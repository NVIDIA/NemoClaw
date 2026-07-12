// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const DEFAULT_DNS_UPSTREAM = "8.8.8.8";
export const DEFAULT_VETH_GATEWAY = "10.200.0.1";

export function buildDnsProxyPython(): string {
  return String.raw`import socket, threading, os, sys

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
`;
}

export function buildDnsReadyProbePython(vethGateway: string): string {
  return String.raw`
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(1)
try:
    s.sendto(b'\x00\x1e\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x06google\x03com\x00\x00\x01\x00\x01',
             (${JSON.stringify(vethGateway)}, 53))
    data, _ = s.recvfrom(4096)
    sys.stdout.write('ok' if data else '')
except Exception:
    pass
`;
}

// Kubernetes pod names append generated suffixes to the requested sandbox name.
// Keep substring matching so names such as "box[1]" match "pod/box[1]-abc",
// then strip the leading "pod/" prefix before returning the pod name.
export function selectSandboxPod(sandboxName: string, podsOutput: string): string | null {
  for (const line of podsOutput.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.includes(sandboxName)) continue;
    return trimmed.replace(/^pod\//, "");
  }
  return null;
}

export function parseVethGateway(output: string): string {
  const trimmed = output.trim();
  return trimmed || DEFAULT_VETH_GATEWAY;
}

export function selectSandboxNamespace(output: string): string | null {
  return (
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.includes("sandbox")) ?? null
  );
}

export function buildResolvConf(vethGateway: string): string {
  return `nameserver ${vethGateway}\noptions ndots:5\n`;
}

export function isSafeDnsAddress(value: string): boolean {
  return /^[a-zA-Z0-9.:_-]+$/.test(value);
}
