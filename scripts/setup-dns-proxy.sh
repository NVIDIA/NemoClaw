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
  docker exec "$CLUSTER" kubectl "$@"
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

sleep 2

# ── Step 4: Allow UDP DNS in sandbox iptables ───────────────────────
#
# OpenShell's sandbox network policy rejects all non-proxy traffic
# (only TCP to 10.200.0.1:3128 is allowed). Insert a rule at the top
# of the OUTPUT chain to allow UDP to the gateway on port 53.

SANDBOX_NS="$(kctl exec -n openshell "$POD" -- sh -c \
  "ls /run/netns/ 2>/dev/null | grep sandbox | head -1" 2>/dev/null || true)"

if [ -n "$SANDBOX_NS" ]; then
  kctl exec -n openshell "$POD" -- \
    ip netns exec "$SANDBOX_NS" \
    iptables -C OUTPUT -p udp -d "$VETH_GW" --dport 53 -j ACCEPT 2>/dev/null \
    || kctl exec -n openshell "$POD" -- \
      ip netns exec "$SANDBOX_NS" \
      iptables -I OUTPUT 1 -p udp -d "$VETH_GW" --dport 53 -j ACCEPT

  # ── Step 5: Update sandbox resolv.conf ────────────────────────────
  kctl exec -n openshell "$POD" -- \
    ip netns exec "$SANDBOX_NS" sh -c "
      printf 'nameserver ${VETH_GW}\noptions ndots:5\n' > /etc/resolv.conf
    "
else
  echo "WARNING: Could not find sandbox network namespace. DNS may not work."
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

  # 6c. iptables UDP DNS rule present
  if sb_exec iptables -C OUTPUT -p udp -d "$VETH_GW" --dport 53 -j ACCEPT 2>/dev/null; then
    echo "  [PASS] iptables: UDP ${VETH_GW}:53 ACCEPT rule present"
    VERIFY_PASS=$((VERIFY_PASS + 1))
  else
    echo "  [FAIL] iptables: UDP DNS ACCEPT rule missing"
    VERIFY_FAIL=$((VERIFY_FAIL + 1))
  fi

  # 6d. Actual DNS resolution from sandbox (getent hosts)
  DNS_RESULT="$(sb_exec getent hosts github.com 2>/dev/null || true)"
  if [ -n "$DNS_RESULT" ]; then
    echo "  [PASS] getent hosts github.com -> ${DNS_RESULT}"
    VERIFY_PASS=$((VERIFY_PASS + 1))
  else
    echo "  [FAIL] getent hosts github.com returned empty (DNS not resolving)"
    VERIFY_FAIL=$((VERIFY_FAIL + 1))
  fi
else
  echo "  [SKIP] Sandbox namespace not found; cannot verify resolv.conf, iptables, or DNS"
fi

echo "  DNS verification: ${VERIFY_PASS} passed, ${VERIFY_FAIL} failed"
if [ "$VERIFY_FAIL" -gt 0 ]; then
  echo "WARNING: DNS setup incomplete. Sandbox DNS resolution may not work. See issue #626."
fi
