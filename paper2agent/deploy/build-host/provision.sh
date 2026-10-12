#!/usr/bin/env bash
# Provisions the paper2agent build host on NixOS (build-nixos-2): a rootless Docker daemon for the
# dedicated paper2agent-build user, and the paper2agent-link account for the production model link.
#
# Run as root on the host from a copy of this directory:
#   scp -r paper2agent/deploy/build-host root@HOST:/root/paper2agent-build-host
#   ssh root@HOST /root/paper2agent-build-host/provision.sh [--link-key FILE]
#
#   --link-key  The authorized_keys line for paper2agent-link: restrict,port-forwarding,
#               [from=...,]permitopen="127.0.0.1:18095",permitlisten="127.0.0.1:18000"[,command=...] KEY
#
# Result:
#   paper2agent-build   system user without password, login shell or groups; private home /var/lib/paper2agent-build
#   rootless dockerd    lingering systemd user service paper2agent-dockerd.service, socket /run/user/UID/docker.sock
#   paper2agent-docker  Docker CLI for root; it runs docker as paper2agent-build against that socket
#   nft table           inet paper2agent_build guards loopback 18095 and 18000 and the build user's egress
#
# Repeated runs are safe. The script never rebuilds NixOS and never touches the root Docker daemon or
# the CI runner. It restarts the sshd listener only when the paper2agent-link Match block is not
# active yet; the NixOS sshd unit uses KillMode=process, so open SSH sessions stay connected.
set -euo pipefail
umask 022

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
readonly here
cd /
readonly build_user=paper2agent-build link_user=paper2agent-link
readonly home=/var/lib/paper2agent-build
readonly nologin=/run/current-system/sw/bin/nologin
readonly sshd_bin=/run/current-system/sw/bin/sshd
readonly link_keys=/etc/ssh/authorized_keys.d/paper2agent-link
readonly dockerd_unit=paper2agent-dockerd.service
# NixOS systemd loads units from this profile. Nix links it to root's profile.
readonly default_profile=/nix/var/nix/profiles/default

die() { echo "provision: $*" >&2; exit 1; }
log() { echo "provision: $*"; }

link_key_file=
while [ $# -gt 0 ]; do
  case $1 in
    --link-key) link_key_file=${2:?--link-key needs a file}; shift 2 ;;
    *) die "usage: $0 [--link-key FILE]" ;;
  esac
done

[ "$(id -u)" = 0 ] || die "run as root"
[ -e /etc/NIXOS ] || die "expected a NixOS host"
[ "$(stat -fc %T /sys/fs/cgroup)" = cgroup2fs ] || die "cgroup v2 is required"
[ -u /run/wrappers/bin/newuidmap ] && [ -u /run/wrappers/bin/newgidmap ] || die "setuid newuidmap/newgidmap are missing"
[ "$(cat /proc/sys/user/max_user_namespaces)" -gt 0 ] || die "user namespaces are disabled"

profile=$default_profile
case $(readlink "$default_profile" || true) in
  "" | default-*-link) ;;
  /*) profile=$(readlink "$default_profile") ;;
  *) die "unexpected link target for $default_profile" ;;
esac

ensure_account() {
  local name=$1 dir=$2 comment=$3
  getent group "$name" >/dev/null || groupadd --system "$name"
  getent passwd "$name" >/dev/null ||
    useradd --system --gid "$name" --no-create-home --home-dir "$dir" --shell "$nologin" --comment "$comment" "$name"
  [ "$(id -nG "$name")" = "$name" ] || die "$name must not have supplementary groups"
  [ "$(passwd -S "$name" | cut -d' ' -f2)" = L ] || die "$name must keep a locked password"
}
ensure_account "$build_user" "$home" "paper2agent rootless Docker build daemon"
ensure_account "$link_user" /var/empty "paper2agent production link, TCP forwarding only"
install -d -o "$build_user" -g "$build_user" -m 0700 "$home"
uid=$(id -u "$build_user")

if [ -n "$link_key_file" ]; then
  [ "$(grep -c . "$link_key_file")" = 1 ] || die "--link-key must contain one line"
  line=$(grep . "$link_key_file")
  re='^restrict,port-forwarding(,from="[0-9a-fA-F.:,/*!]+")?,permitopen="127\.0\.0\.1:18095",permitlisten="127\.0\.0\.1:18000"(,command="[^"]*")? (ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa) [A-Za-z0-9+/]+=*( [A-Za-z0-9@._-]+)?$'
  [[ $line =~ $re ]] || die "--link-key does not match the required restrict/permitopen/permitlisten form"
  printf '%s\n' "$line" > "${link_keys%/*}/.paper2agent-link.new"
  ssh-keygen -lf "${link_keys%/*}/.paper2agent-link.new" >/dev/null || die "invalid link public key"
  chmod 0644 "${link_keys%/*}/.paper2agent-link.new"
  mv -f "${link_keys%/*}/.paper2agent-link.new" "$link_keys"
  log "installed $link_keys"
fi
[ -s "$link_keys" ] || log "warning: $link_keys is missing; the production link cannot log in"

log "building the pinned host runtime"
host_pkg=$(nix-build --no-out-link "$here/default.nix" --argstr buildUid "$uid" -A host)
link_sshd=$(nix-build --no-out-link "$here/default.nix" -A linkSshd)
link_sshd_config=$(nix-build --no-out-link "$here/default.nix" -A linkSshdConfig)
unit_link=$default_profile/share/$build_user/$dockerd_unit
before=$(readlink -f "$unit_link" || true)
nix-env --profile "$profile" --install "$host_pkg" "$link_sshd"
systemctl daemon-reload
[[ " $(systemctl show -p DropInPaths --value "user@$uid.service") " == *"/user@$uid.service.d/50-$build_user.conf "* ]] ||
  die "systemd does not load the user@$uid.service drop-in from $default_profile"
[[ " $(systemctl show -p WantedBy --value "$build_user-subid.path") " == *" multi-user.target "* ]] ||
  die "$build_user-subid.path is not wanted by multi-user.target"
systemctl start "$build_user-subid.path"

# Apply the paper2agent-link Match block: idle link sessions close after 45 s and release port 18000.
[ "$(systemctl show -p KillMode --value sshd.service)" = process ] || die "sshd.service must use KillMode=process"
"$sshd_bin" -t -f "$link_sshd_config" || die "sshd rejects $link_sshd_config"
link_view=$("$sshd_bin" -T -f "$link_sshd_config" -C "user=$link_user,host=link,addr=127.0.0.1")
for want in "authenticationmethods publickey" "clientaliveinterval 15" "clientalivecountmax 3" \
  "allowagentforwarding no" "allowstreamlocalforwarding no" "permitlisten 127.0.0.1:18000" \
  "permitopen 127.0.0.1:18095" "permittty no" "forcecommand /run/current-system/sw/bin/false"; do
  grep -qxF "$want" <<<"$link_view" || die "sshd -T for $link_user lacks '$want'"
done
[ "$("$sshd_bin" -T -f /etc/ssh/sshd_config -C user=root,host=check,addr=127.0.0.1)" = \
  "$("$sshd_bin" -T -f "$link_sshd_config" -C user=root,host=check,addr=127.0.0.1)" ] ||
  die "$link_sshd_config changes settings for users other than $link_user"
sshd_title=$(tr '\0' ' ' < "/proc/$(systemctl show -p MainPID --value sshd.service)/cmdline")
if [[ $sshd_title != *"-f $link_sshd_config"* ]]; then
  log "restarting the sshd listener for the $link_user Match block; open sessions stay connected"
  systemctl restart sshd.service
  systemctl is-active --quiet sshd.service || die "sshd is not active; check journalctl -u sshd"
fi

# Subordinate IDs and the network guard now. user@$uid.service applies both again on every start.
"$host_pkg/libexec/$build_user/subid"
"$host_pkg/libexec/$build_user/guard"
for file in /etc/subuid /etc/subgid; do
  grep -q "^$build_user:" "$file" || die "$file has no range for $build_user"
done

# The daemon unit lives in the build user's own systemd configuration and links to the profile copy.
as_build() { setpriv --reuid="$build_user" --regid="$build_user" --init-groups --inh-caps=-all "$@"; }
as_build mkdir -p "$home/.config/systemd/user/default.target.wants"
as_build ln -sfn "$unit_link" "$home/.config/systemd/user/$dockerd_unit"
as_build ln -sfn "../$dockerd_unit" "$home/.config/systemd/user/default.target.wants/$dockerd_unit"

# Lingering starts the user manager now and at every boot.
loginctl enable-linger "$build_user"
for _ in $(seq 60); do
  systemctl is-active --quiet "user@$uid.service" && break
  sleep 1
done
systemctl is-active --quiet "user@$uid.service" || die "user@$uid.service is not active; see journalctl -u user@$uid.service"
user_ctl() { systemctl --machine="$build_user@.host" --user "$@"; }
user_ctl daemon-reload
if user_ctl is-active --quiet "$dockerd_unit"; then
  [ "$before" = "$(readlink -f "$unit_link")" ] ||
    log "notice: $dockerd_unit still runs the previous unit; restart it to apply (this stops the containers)"
else
  user_ctl start --no-block "$dockerd_unit"
fi

docker_cli=$host_pkg/bin/paper2agent-docker
deadline=$((SECONDS + 180))
until "$docker_cli" info >/dev/null 2>&1; do
  ! user_ctl is-failed --quiet "$dockerd_unit" ||
    die "$dockerd_unit failed; see journalctl _UID=$uid _SYSTEMD_USER_UNIT=$dockerd_unit"
  [ "$SECONDS" -lt "$deadline" ] || die "the rootless daemon does not answer on /run/user/$uid/docker.sock"
  sleep 2
done
info=$("$docker_cli" info --format '{{json .SecurityOptions}} {{.CgroupDriver}} {{.CgroupVersion}} {{.Driver}} {{.ServerVersion}}')
[[ $info == *name=rootless* ]] || die "the daemon on /run/user/$uid/docker.sock is not rootless: $info"
[[ $info == *" systemd 2 "* ]] || die "the daemon must use the systemd cgroup driver on cgroup v2: $info"
log "rootless daemon: $info"
cat <<EOF
provision: ready
  user     $build_user uid $uid, private state $home, subordinate IDs $(grep "^$build_user:" /etc/subuid | cut -d: -f2-)
  socket   /run/user/$uid/docker.sock
  cli      paper2agent-docker ARGS (as root; the environment is reset, so pass Compose values with --env-file)
  limits   user@$uid.service MemoryMax=8G CPUQuota=400% TasksMax=4096; per container --memory --cpus --pids-limit
  network  control host 127.0.0.1:18095 for root and $link_user; containers reach the model relay at 10.0.2.2:18000
EOF
