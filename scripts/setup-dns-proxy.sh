#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Set up a DNS forwarder inside the sandbox pod so the isolated sandbox
# network namespace can resolve hostnames.
#
# Problem: The sandbox runs in an isolated namespace (10.200.0.0/24)
# where all non-proxy traffic is rejected by iptables. DNS (UDP:53)
# is blocked, causing getaddrinfo EAI_AGAIN for every outbound request.
#
# Fix (three steps):
#   1. Run a Python DNS forwarder on the pod-side veth gateway IP
#      (10.200.0.1:53), forwarding to the real CoreDNS pod IP.
#   2. Add an iptables rule in the sandbox namespace to allow UDP
#      to the gateway on port 53 (the only non-proxy exception).
#      Sandbox images may not have iptables on PATH, so we probe
#      well-known paths (/sbin, /usr/sbin) to find the binary.
#   3. Update the sandbox's /etc/resolv.conf to point to 10.200.0.1.
#
# Requires: sandbox must be in Ready state. Run after sandbox creation.
#
# Usage: ./scripts/setup-dns-proxy.sh [gateway-name] <sandbox-name>

set -euo pipefail

GATEWAY_NAME="${1:-}"
SANDBOX_NAME="${2:-}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./lib/runtime.sh
. "$SCRIPT_DIR/lib/runtime.sh"

if [ -z "$SANDBOX_NAME" ]; then
  echo "Usage: $0 [gateway-name] <sandbox-name>"
  exit 1
fi

# ── Find the gateway container ──────────────────────────────────────

if [ -z "${DOCKER_HOST:-}" ]; then
  if docker_host="$(detect_docker_host)"; then
    export DOCKER_HOST="$docker_host"
  fi
fi

CLUSTERS="$(docker ps --filter "name=openshell-cluster" --format '{{.Names}}' 2>/dev/null || true)"
CLUSTER="$(select_openshell_cluster_container "$GATEWAY_NAME" "$CLUSTERS" || true)"

if [ -z "$CLUSTER" ]; then
  if [ -n "$GATEWAY_NAME" ]; then
    echo "WARNING: Could not find gateway container for '$GATEWAY_NAME'. DNS proxy not installed."
  else
    echo "WARNING: Could not find any openshell cluster container. DNS proxy not installed."
  fi
  exit 1
fi

# ── Helper: kubectl via gateway ─────────────────────────────────────

kctl() {
  # Target the `agent` container explicitly for `exec` so kubectl stops
  # emitting `Defaulted container "agent" out of: agent, workspace-init (init)`
  # on every call.
  if [ "${1:-}" = "exec" ]; then
    shift
    docker exec "$CLUSTER" kubectl exec -c agent "$@"
  else
    docker exec "$CLUSTER" kubectl "$@"
  fi
}

# ── Discover CoreDNS pod IP ─────────────────────────────────────────
#
# Forward to the real CoreDNS pod (not 8.8.8.8) so k8s-internal names
# like openshell-0.openshell.svc.cluster.local still resolve. CoreDNS
# handles both k8s names (kubernetes plugin) and external names
# (forward plugin, patched by fix-coredns.sh).

DNS_UPSTREAM="$(kctl get endpoints kube-dns \
  -n kube-system -o jsonpath='{.subsets[0].addresses[0].ip}' 2>/dev/null || true)"

if [ -z "$DNS_UPSTREAM" ]; then
  echo "WARNING: Could not discover CoreDNS pod IP. Falling back to 8.8.8.8."
  echo "WARNING: k8s-internal names (inference.local routing) will NOT work."
  DNS_UPSTREAM="8.8.8.8"
fi

# ── Find the sandbox pod ────────────────────────────────────────────

POD="$(kctl get pods -n openshell -o name 2>/dev/null \
  | grep -F -- "$SANDBOX_NAME" | head -1 | sed 's|pod/||' || true)"

if [ -z "$POD" ]; then
  echo "WARNING: Could not find pod for sandbox '$SANDBOX_NAME'. DNS proxy not installed."
  exit 1
fi

# ── Discover the pod-side veth gateway IP ───────────────────────────
#
# The sandbox connects to the pod via a veth pair. The pod side is
# typically 10.200.0.1. The forwarder must listen on this IP so
# packets from the sandbox (10.200.0.2) can reach it.

VETH_GW="$(kctl exec -n openshell "$POD" -- sh -c \
  "ip addr show | grep 'inet 10\\.200\\.0\\.' | awk '{print \$2}' | cut -d/ -f1" \
  2>/dev/null || true)"
VETH_GW="${VETH_GW:-10.200.0.1}"

echo "Setting up DNS proxy in pod '$POD' (${VETH_GW}:53 -> ${DNS_UPSTREAM})..."

# ── Step 1: Write DNS forwarder to the pod ──────────────────────────

kctl exec -n openshell "$POD" -- sh -c "cat > /tmp/dns-proxy.py << 'DNSPROXY'
import socket, threading, os, sys

UPSTREAM = (sys.argv[1] if len(sys.argv) > 1 else '8.8.8.8', 53)
BIND_IP = sys.argv[2] if len(sys.argv) > 2 else '0.0.0.0'

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind((BIND_IP, 53))

with open('/tmp/dns-proxy.pid', 'w') as pf:
    pf.write(str(os.getpid()))

msg = 'dns-proxy: {}:53 -> {}:{} pid={}'.format(BIND_IP, UPSTREAM[0], UPSTREAM[1], os.getpid())
print(msg, flush=True)
with open('/tmp/dns-proxy.log', 'w') as log:
    log.write(msg + '\n')

def forward(data, addr):
    try:
        f = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        f.settimeout(5)
        f.sendto(data, UPSTREAM)
        r, _ = f.recvfrom(4096)
        sock.sendto(r, addr)
        f.close()
    except Exception:
        pass

while True:
    d, a = sock.recvfrom(4096)
    threading.Thread(target=forward, args=(d, a), daemon=True).start()
DNSPROXY"

# ── Step 2: Kill any existing DNS proxy ─────────────────────────────

OLD_PID="$(kctl exec -n openshell "$POD" -- cat /tmp/dns-proxy.pid 2>/dev/null || true)"
if [ -n "$OLD_PID" ]; then
  kctl exec -n openshell "$POD" -- kill "$OLD_PID" 2>/dev/null || true
  sleep 1
fi

# ── Step 3: Launch forwarder on pod-side veth gateway ───────────────
#
# Use kubectl exec with nohup to start the forwarder as a background
# process inside the pod. This avoids the nsenter PID namespace
# mismatch that caused PR #732's launch to silently fail.
#
# Bind on the pod-side veth IP so the sandbox namespace can reach it
# once the iptables UDP exception is in place.

kctl exec -n openshell "$POD" -- \
  sh -c "nohup python3 -u /tmp/dns-proxy.py '${DNS_UPSTREAM}' '${VETH_GW}' \
    > /tmp/dns-proxy.log 2>&1 &"

# Wait for forwarder to actually be serving (up to 10s).
# The PID file is written before the socket is bound, so we probe
# with a real DNS query instead of just checking the file. See #2017.
_dns_ready=0
for _i in $(seq 1 10); do
  # Probe via python3, not socat — socat is not installed in the sandbox image.
  if kctl exec -n openshell "$POD" -- python3 -c "
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(1)
try:
    s.sendto(b'\x00\x1e\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x06google\x03com\x00\x00\x01\x00\x01',
             ('${VETH_GW}', 53))
    data, _ = s.recvfrom(4096)
    sys.stdout.write('ok' if data else '')
except Exception:
    pass
" 2>/dev/null | grep -q ok; then
    _dns_ready=1
    break
  fi
  sleep 1
done
if [ "$_dns_ready" -eq 0 ]; then
  echo "WARNING: DNS forwarder not responding after 10s — verification may fail"
fi

# ── Step 4: Allow UDP DNS in sandbox iptables ───────────────────────
#
# OpenShell's sandbox network policy rejects all non-proxy traffic
# (only TCP to 10.200.0.1:3128 is allowed). Insert a rule at the top
# of the OUTPUT chain to allow UDP to the gateway on port 53.
#
# Sandbox images may not have iptables on PATH (e.g. minimal images
# ship it in /sbin or /usr/sbin without updating PATH). We run
# `ip netns exec` from the *pod*, so the binary is resolved from the
# pod's filesystem — probe well-known paths to find it.  See #557.

SANDBOX_NS="$(kctl exec -n openshell "$POD" -- sh -c \
  "ls /run/netns/ 2>/dev/null | grep sandbox | head -1" 2>/dev/null || true)"

if [ -z "$SANDBOX_NS" ]; then
  echo "WARNING: Could not find sandbox network namespace. DNS may not work."
else
  # Find iptables binary — check PATH first, then well-known locations.
  # The sandbox image may not include iptables at all, but the pod's
  # root filesystem (which ip-netns-exec inherits) usually has it in
  # /sbin or /usr/sbin even when those dirs are not on PATH.
  IPTABLES_BIN=""
  for candidate in iptables /sbin/iptables /usr/sbin/iptables; do
    if kctl exec -n openshell "$POD" -- sh -c "test -x \"\$(command -v $candidate 2>/dev/null || echo $candidate)\"" 2>/dev/null; then
      IPTABLES_BIN="$candidate"
      break
    fi
  done

  # Back up the original resolv.conf before we touch it. On reruns the
  # file may already contain our rewritten content, so only save once.
  kctl exec -n openshell "$POD" -- \
    ip netns exec "$SANDBOX_NS" sh -c "
      [ -f /tmp/resolv.conf.orig ] || cp /etc/resolv.conf /tmp/resolv.conf.orig
    " 2>/dev/null || true

  if [ -n "$IPTABLES_BIN" ]; then
    kctl exec -n openshell "$POD" -- \
      ip netns exec "$SANDBOX_NS" \
      "$IPTABLES_BIN" -C OUTPUT -p udp -d "$VETH_GW" --dport 53 -j ACCEPT 2>/dev/null \
      || kctl exec -n openshell "$POD" -- \
        ip netns exec "$SANDBOX_NS" \
        "$IPTABLES_BIN" -I OUTPUT 1 -p udp -d "$VETH_GW" --dport 53 -j ACCEPT

    # ── Step 5: Update sandbox resolv.conf ──────────────────────────
    # Only rewrite resolv.conf when the iptables rule was added.
    # Without the UDP exception, pointing resolv.conf at the forwarder
    # would make DNS queries silently time out instead of failing fast
    # with the system default resolver — a worse failure mode.
    kctl exec -n openshell "$POD" -- \
      ip netns exec "$SANDBOX_NS" sh -c "
        printf 'nameserver ${VETH_GW}\noptions ndots:5\n' > /etc/resolv.conf
      "
  else
    echo "WARNING: iptables not found in pod (checked PATH, /sbin, /usr/sbin)."
    echo "WARNING: Cannot add UDP DNS exception. Sandbox DNS resolution will not work."
    # Restore original resolv.conf in case a previous run overwrote it.
    kctl exec -n openshell "$POD" -- \
      ip netns exec "$SANDBOX_NS" sh -c "
        [ -f /tmp/resolv.conf.orig ] && cp /tmp/resolv.conf.orig /etc/resolv.conf
      " 2>/dev/null || true
  fi
fi

# ── Step 6: Runtime verification ─────────────────────────────────────
#
# Verify all three layers of the DNS bridge actually work, not just
# that the forwarder process started. This catches silent failures that
# static checks miss.

VERIFY_PASS=0
VERIFY_FAIL=0

# 6a. Forwarder process running
PID="$(kctl exec -n openshell "$POD" -- cat /tmp/dns-proxy.pid 2>/dev/null || true)"
LOG="$(kctl exec -n openshell "$POD" -- cat /tmp/dns-proxy.log 2>/dev/null || true)"

if [ -n "$PID" ] && echo "$LOG" | grep -q "dns-proxy:"; then
  echo "  [PASS] DNS forwarder running (pid=$PID): $LOG"
  VERIFY_PASS=$((VERIFY_PASS + 1))
else
  echo "  [FAIL] DNS forwarder not running. PID=${PID:-none} Log: ${LOG:-empty}"
  VERIFY_FAIL=$((VERIFY_FAIL + 1))
fi

# 6b-6d run inside sandbox namespace (require SANDBOX_NS)
if [ -n "$SANDBOX_NS" ]; then
  sb_exec() {
    kctl exec -n openshell "$POD" -- ip netns exec "$SANDBOX_NS" "$@"
  }

  # 6b. resolv.conf points to the veth gateway
  RESOLV="$(sb_exec cat /etc/resolv.conf 2>/dev/null || true)"
  if echo "$RESOLV" | grep -q "nameserver ${VETH_GW}"; then
    echo "  [PASS] resolv.conf -> nameserver ${VETH_GW}"
    VERIFY_PASS=$((VERIFY_PASS + 1))
  else
    echo "  [FAIL] resolv.conf does not point to ${VETH_GW}: ${RESOLV}"
    VERIFY_FAIL=$((VERIFY_FAIL + 1))
  fi

  # 6c. iptables UDP DNS rule present (use discovered binary path)
  IPTABLES_CHECK="${IPTABLES_BIN:-iptables}"
  if sb_exec "$IPTABLES_CHECK" -C OUTPUT -p udp -d "$VETH_GW" --dport 53 -j ACCEPT 2>/dev/null; then
    echo "  [PASS] iptables: UDP ${VETH_GW}:53 ACCEPT rule present"
    VERIFY_PASS=$((VERIFY_PASS + 1))
  else
    echo "  [FAIL] iptables: UDP DNS ACCEPT rule missing"
    VERIFY_FAIL=$((VERIFY_FAIL + 1))
  fi

  # 6d. Actual DNS resolution from sandbox (getent hosts)
  # Retry up to 3 times — on slower hardware (Jetson ARM64) the forwarder
  # may need a few extra seconds after binding. See #2017.
  DNS_RESULT=""
  for _dns_try in 1 2 3; do
    DNS_RESULT="$(sb_exec getent hosts github.com 2>/dev/null || true)"
    [ -n "$DNS_RESULT" ] && break
    [ "$_dns_try" -lt 3 ] && sleep 2
  done
  if [ -n "$DNS_RESULT" ]; then
    echo "  [PASS] getent hosts github.com -> ${DNS_RESULT}"
    VERIFY_PASS=$((VERIFY_PASS + 1))
  else
    echo "  [FAIL] getent hosts github.com returned empty after 3 attempts (DNS not resolving)"
    VERIFY_FAIL=$((VERIFY_FAIL + 1))
  fi
else
  echo "  [SKIP] Sandbox namespace not found; cannot verify resolv.conf, iptables, or DNS"
fi

echo "  DNS verification: ${VERIFY_PASS} passed, ${VERIFY_FAIL} failed"
if [ "$VERIFY_FAIL" -gt 0 ]; then
  echo "WARNING: DNS setup incomplete. Sandbox DNS resolution may not work. See issue #626, #557."
fi
