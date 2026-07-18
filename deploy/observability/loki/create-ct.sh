#!/usr/bin/env bash
set -uo pipefail
CTID=206; HOST=hel1-loki; IP=10.10.10.16
TMPL=local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst
if ! pct status $CTID >/dev/null 2>&1; then
  echo "[mk] a criar CT $CTID ($HOST)"
  pct create $CTID $TMPL --hostname $HOST --cores 2 --memory 2048 --swap 512 \
    --rootfs local-zfs:40 \
    --net0 name=eth0,bridge=vmbr1,gw=10.10.10.1,ip=$IP/24,type=veth \
    --features nesting=1,keyctl=1,fuse=1 --unprivileged 1 --onboot 1 --ostype debian >/dev/null 2>&1
  grep -q 'dev/net/tun' /etc/pve/lxc/$CTID.conf || {
    echo 'lxc.cgroup2.devices.allow: c 10:200 rwm' >> /etc/pve/lxc/$CTID.conf
    echo 'lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file' >> /etc/pve/lxc/$CTID.conf
  }
else echo "[mk] CT $CTID já existe"; fi
pct start $CTID >/dev/null 2>&1 || true
for i in $(seq 1 15); do pct exec $CTID -- ping -c1 -W2 1.1.1.1 >/dev/null 2>&1 && break; sleep 2; done
echo "[mk] a instalar tailscale"
pct exec $CTID -- sh -c 'apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq curl ca-certificates >/dev/null 2>&1; command -v tailscale >/dev/null 2>&1 || curl -fsSL https://tailscale.com/install.sh | sh >/dev/null 2>&1'
echo "[mk] tailscale up (interativo)"
pct exec $CTID -- sh -c 'if tailscale ip -4 >/dev/null 2>&1; then echo "TS_UP=$(tailscale ip -4|head -1)"; else rm -f /tmp/ts.log; setsid nohup tailscale up --ssh --hostname=hel1-loki --accept-routes </dev/null >/tmp/ts.log 2>&1 & for i in $(seq 1 20); do sleep 2; u=$(grep -oE "https://login.tailscale.com/[A-Za-z0-9/]+" /tmp/ts.log|head -1); [ -n "$u" ] && { echo "LOGIN_URL=$u"; break; }; done; fi'
echo DONE
