# Outbound SSH link from trusted production to the Paper2Agent build host.
# OpenSSH client only: no Docker CLI, wallet tooling or credentials. The private
# key and the pinned build-host key are read-only runtime mounts, and the
# forwards and destination come from
# deploy/mainnet/docker-compose.paper2agent-link.yml.
FROM alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

RUN apk add --no-cache openssh-client-default \
 && addgroup -S -g 10001 paper2agent-link \
 && adduser -S -D -H -h /nonexistent -s /sbin/nologin -G paper2agent-link -u 10001 paper2agent-link

# The mounted private key must be owned by this UID with mode 0600.
USER 10001:10001

# -F /dev/null skips every ssh_config file. Host-key checks use only the pinned
# alias, never update it, and ssh exits whenever the session or a forward fails
# so the container restart policy re-establishes the link.
ENTRYPOINT ["/usr/bin/ssh", "-N", "-T", "-F", "/dev/null", \
  "-o", "BatchMode=yes", \
  "-o", "PreferredAuthentications=publickey", \
  "-o", "IdentitiesOnly=yes", \
  "-o", "IdentityAgent=none", \
  "-o", "IdentityFile=/run/paper2agent-link/id_ed25519", \
  "-o", "ForwardAgent=no", \
  "-o", "HostKeyAlias=paper2agent-build-host", \
  "-o", "HostKeyAlgorithms=ssh-ed25519", \
  "-o", "StrictHostKeyChecking=yes", \
  "-o", "UserKnownHostsFile=/run/paper2agent-link/known_hosts", \
  "-o", "GlobalKnownHostsFile=/dev/null", \
  "-o", "UpdateHostKeys=no", \
  "-o", "ExitOnForwardFailure=yes", \
  "-o", "ServerAliveInterval=15", \
  "-o", "ServerAliveCountMax=3", \
  "-o", "ConnectTimeout=15"]
