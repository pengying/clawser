#!/bin/bash
set -euo pipefail
umask 077
# Bootstrap firewall before executing any application; application processes have no caps.
iptables -P OUTPUT DROP
ip6tables -P OUTPUT DROP
iptables -A OUTPUT -o lo -m owner --uid-owner 1000 -p tcp -m multiport --dports 5900,9222,9223 -j REJECT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
# Docker's embedded DNS is the sole private destination exception.
iptables -A OUTPUT -d 127.0.0.11 -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -d 127.0.0.11 -p tcp --dport 53 -j ACCEPT
for range in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4; do iptables -A OUTPUT -d "$range" -j REJECT; done
iptables -A OUTPUT -p tcp -m multiport --dports 80,443 -j ACCEPT
install -d -o 1000 -g 1000 -m 0700 /tmp/desktop
install -d -o root -g root -m 1777 /tmp/.X11-unix
chown 1000:1000 /profile
# A separate non-root identity forwards trusted host CDP to Chrome's loopback.
# The browser identity cannot connect to CDP/VNC management TCP ports.
setpriv --reuid=1001 --regid=1001 --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all -- \
  socat TCP-LISTEN:9223,bind=0.0.0.0,reuseaddr,fork TCP:127.0.0.1:9222 \
  >/dev/null 2>/tmp/desktop-proxy.stderr &
export DESKTOP_PROXY_PID=$!
exec setpriv --reuid=1000 --regid=1000 --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all -- python3 /opt/desktop/supervisor.py
