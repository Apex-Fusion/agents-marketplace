# Host runtime for the paper2agent build host on NixOS (build-nixos-2): a rootless Docker daemon for
# the dedicated paper2agent-build user, and sshd limits for the paper2agent-link account.
#   nix-build default.nix --argstr buildUid UID -A host   systemd units, rootless daemon unit, CLI wrapper
#   nix-build default.nix -A linkSshd                       sshd drop-in with the paper2agent-link Match block
# provision.sh installs both outputs into root's Nix profile. Nix exposes that profile as
# /nix/var/nix/profiles/default, and NixOS systemd loads system units from its lib/systemd/system.
# The profile is also the garbage-collector root for Docker, RootlessKit and slirp4netns.
{
  buildUid ? null,
}:
let
  # nixos-26.05 channel release nixos-26.05.11680.6fcc160353f6 (binary cache: cache.nixos.org).
  nixpkgs = builtins.fetchTarball {
    url = "https://github.com/NixOS/nixpkgs/archive/6fcc160353f63555b560f25588925133c8f61f2a.tar.gz";
    sha256 = "0rmvi7fa3brb2zvj8y3dzl819q33xjrw0j95wwxqhb099kwhp3y4";
  };
  pkgs = import nixpkgs {
    config = { };
    overlays = [ ];
  };
  inherit (pkgs) lib;

  user = "paper2agent-build";
  uid = if buildUid == null then throw "pass --argstr buildUid \"$(id -u ${user})\"" else buildUid;
  runtimeDir = "/run/user/${uid}";
  # Fixed subordinate ID range for the user namespace of the rootless daemon.
  subidEntry = "${user}:268435456:65536";
  docker = pkgs.docker;

  # NixOS rewrites /etc/subuid and /etc/subgid from declared users on every activation, and this
  # user is not declared in the host configuration. Restore its range without touching other lines.
  subid = pkgs.writeShellScript "${user}-subid" ''
    set -eu
    PATH=${lib.makeBinPath [ pkgs.coreutils pkgs.gnugrep ]}
    for file in /etc/subuid /etc/subgid; do
      grep -qxF '${subidEntry}' "$file" && continue
      tmp=$(mktemp "$file.${user}.XXXXXX")
      grep -v -e '^${user}:' -e '^$' "$file" > "$tmp" || true
      printf '%s\n' '${subidEntry}' >> "$tmp"
      chmod 0644 "$tmp"
      mv -f "$tmp" "$file"
    done
  '';

  guard = pkgs.writeShellScript "${user}-guard" ''
    exec ${pkgs.nftables}/bin/nft -f ${./host-guard.nft}
  '';

  # Socket group 0 inside the daemon's user namespace is the build user's own group on the host.
  # Containers then see the socket as 0:0 mode 1660, so the control uses DOCKER_GID=0. Without this,
  # dockerd takes the GID of the host's root-Docker group "docker" from /etc/group.
  daemonConfig = pkgs.writeText "${user}-daemon.json" (
    builtins.toJSON {
      exec-opts = [ "native.cgroupdriver=systemd" ];
      group = "0";
      log-driver = "json-file";
      log-opts = {
        max-size = "20m";
        max-file = "5";
      };
    }
  );

  # Applies to the build user's systemd manager, which contains the daemon and every container.
  # The guard loads before the manager starts, so the daemon never runs without it.
  userManagerDropIn = pkgs.writeText "50-${user}.conf" ''
    [Service]
    ExecStartPre=+${subid}
    ExecStartPre=+${guard}
    MemoryMax=8G
    CPUQuota=400%
    TasksMax=4096
  '';

  subidService = pkgs.writeText "${user}-subid.service" ''
    [Unit]
    Description=Restore the subordinate ID range of ${user}

    [Service]
    Type=oneshot
    ExecStart=${subid}
  '';

  subidPath = pkgs.writeText "${user}-subid.path" ''
    [Unit]
    Description=Watch /etc/subuid and /etc/subgid for the ${user} range

    [Path]
    PathChanged=/etc/subuid
    PathChanged=/etc/subgid

    [Install]
    WantedBy=multi-user.target
  '';

  # User unit. newuidmap and newgidmap come from the NixOS setuid wrappers. With host loopback on,
  # slirp4netns maps 10.0.2.2 to the host's 127.0.0.1; host-guard.nft allows only port 18000 there.
  dockerdUnit = pkgs.writeText "paper2agent-dockerd.service" ''
    [Unit]
    Description=paper2agent rootless Docker daemon
    ConditionUser=${user}
    StartLimitIntervalSec=60
    StartLimitBurst=3

    [Service]
    Type=notify
    NotifyAccess=all
    Environment=PATH=/run/wrappers/bin:${
      lib.makeBinPath [
        pkgs.coreutils
        pkgs.findutils
        pkgs.gnugrep
        pkgs.gnused
      ]
    }
    Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_NET=slirp4netns
    Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_PORT_DRIVER=builtin
    Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=false
    ExecStart=${docker}/bin/dockerd-rootless --config-file=${daemonConfig}
    ExecReload=${pkgs.coreutils}/bin/kill -s HUP $MAINPID
    TimeoutStartSec=0
    TimeoutStopSec=240
    Restart=always
    RestartSec=2
    Delegate=yes
    KillMode=mixed

    [Install]
    WantedBy=default.target
  '';

  # Run as root. The Docker CLI runs as the build user against its rootless socket, with a clean
  # environment; pass Compose interpolation values with --env-file.
  cli = pkgs.writeShellScript "paper2agent-docker" ''
    exec ${pkgs.util-linux}/bin/setpriv --reuid=${user} --regid=${user} --init-groups --inh-caps=-all --reset-env \
      ${pkgs.coreutils}/bin/env \
      PATH=${lib.makeBinPath [ docker pkgs.coreutils ]} \
      XDG_RUNTIME_DIR=${runtimeDir} \
      DOCKER_HOST=unix://${runtimeDir}/docker.sock \
      ${docker}/bin/docker "$@"
  '';

  # Server-side limits for the production link account. The NixOS sshd_config has no Include
  # directory, so this drop-in starts sshd with a file that includes the NixOS config first.
  # Settings from the NixOS config still apply; the Match block only narrows paper2agent-link.
  # Dead link sessions close after 45 seconds and release the model relay port 18000.
  linkSshdConfig = pkgs.writeText "paper2agent-link-sshd_config" ''
    Include /etc/ssh/sshd_config

    Match User paper2agent-link
      AuthenticationMethods publickey
      ClientAliveInterval 15
      ClientAliveCountMax 3
      AllowAgentForwarding no
      AllowStreamLocalForwarding no
      PermitListen 127.0.0.1:18000
      PermitOpen 127.0.0.1:18095
      PermitTTY no
      ForceCommand /run/current-system/sw/bin/false
  '';

  # /run/current-system keeps sshd on the binary of the active NixOS generation.
  # KillMode=process in the NixOS unit keeps open sessions when sshd restarts.
  linkSshdDropIn = pkgs.writeText "50-paper2agent-link.conf" ''
    [Service]
    ExecStart=
    ExecStart=/run/current-system/sw/bin/sshd -D -f ${linkSshdConfig}
  '';
in
{
  host = pkgs.runCommand "${user}-host" { } ''
    sys=$out/lib/systemd/system
    install -D -m 0444 ${userManagerDropIn} $sys/user@${uid}.service.d/50-${user}.conf
    install -D -m 0444 ${subidService} $sys/${user}-subid.service
    install -D -m 0444 ${subidPath} $sys/${user}-subid.path
    mkdir -p $sys/multi-user.target.wants
    ln -s ../${user}-subid.path $sys/multi-user.target.wants/${user}-subid.path
    install -D -m 0444 ${dockerdUnit} $out/share/${user}/paper2agent-dockerd.service
    mkdir -p $out/bin $out/libexec/${user}
    ln -s ${cli} $out/bin/paper2agent-docker
    ln -s ${subid} $out/libexec/${user}/subid
    ln -s ${guard} $out/libexec/${user}/guard
  '';

  linkSshd = pkgs.runCommand "paper2agent-link-sshd" { } ''
    install -D -m 0444 ${linkSshdDropIn} $out/lib/systemd/system/sshd.service.d/50-paper2agent-link.conf
  '';

  inherit linkSshdConfig;
}
