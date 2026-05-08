// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import os from "node:os";

const SETUP_DNS_PROXY = path.join(import.meta.dirname, "..", "scripts", "setup-dns-proxy.sh");
const RUNTIME_SH = path.join(import.meta.dirname, "..", "scripts", "lib", "runtime.sh");
const FIX_COREDNS = path.join(import.meta.dirname, "..", "scripts", "fix-coredns.sh");

describe("setup-dns-proxy.sh", () => {
  it("exists and is executable", () => {
    const stat = fs.statSync(SETUP_DNS_PROXY);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o100).toBeTruthy();
  });

  it("sources runtime.sh successfully", () => {
    const result = spawnSync("bash", ["-c", `source "${RUNTIME_SH}"; echo ok`], {
      encoding: /** @type {const} */ "utf-8",
      env: { ...process.env },
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  });

  it("exits with usage when no sandbox name provided", () => {
    const result = spawnSync("bash", [SETUP_DNS_PROXY, "nemoclaw"], {
      encoding: /** @type {const} */ "utf-8",
      env: { ...process.env },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/Usage:/i);
  });

  it("configures DNS proxy through kubectl and verifies sandbox DNS end to end", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dns-proxy-"));
    const fakeBin = path.join(tmp, "bin");
    const dockerLog = path.join(tmp, "docker.log");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "docker"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(dockerLog)}
if [ "\${1:-}" = "ps" ]; then
  echo "openshell-cluster-nemoclaw"
  exit 0
fi
if [ "\${1:-}" != "exec" ]; then
  exit 1
fi
shift # cluster name
shift # kubectl
cmd="$*"
case "$cmd" in
  *"get endpoints kube-dns"*) echo "10.43.0.10"; exit 0 ;;
  *"get pods -n openshell -o name"*) echo "pod/box[1]-abc"; exit 0 ;;
  *"ip addr show"*) echo "10.200.0.1"; exit 0 ;;
  *"cat /tmp/dns-proxy.pid"*) echo "12345"; exit 0 ;;
  *"cat /tmp/dns-proxy.log"*) echo "dns-proxy: 10.200.0.1:53 -> 10.43.0.10:53 pid=12345"; exit 0 ;;
  *"python3 -c"*) echo "ok"; exit 0 ;;
  *"ls /run/netns/"*) echo "sandbox-ns"; exit 0 ;;
  *"test -x"*) [[ "$cmd" == *"/usr/sbin/iptables"* ]] && exit 0 || exit 1 ;;
  *"cat /etc/resolv.conf"*) echo "nameserver 10.200.0.1"; exit 0 ;;
  *"getent hosts github.com"*) echo "140.82.112.4 github.com"; exit 0 ;;
esac
exit 0
`,
      { mode: 0o755 },
    );

    try {
      const result = spawnSync("bash", [SETUP_DNS_PROXY, "nemoclaw", "box[1]"], {
        encoding: "utf-8",
        env: {
          ...process.env,
          DOCKER_HOST: "unix:///tmp/fake-docker.sock",
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
        },
        timeout: 15000,
      });
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).toBe(0);
      expect(output).toContain("Setting up DNS proxy in pod 'box[1]-abc'");
      expect(output).toContain("DNS verification: 4 passed, 0 failed");

      const calls = fs.readFileSync(dockerLog, "utf-8");
      expect(calls).toContain("get endpoints kube-dns");
      expect(calls).toContain("kube-system");
      expect(calls).toContain("nohup python3 -u /tmp/dns-proxy.py");
      expect(calls).toContain("10.43.0.10");
      expect(calls).toContain("10.200.0.1");
      expect(calls).toContain("/usr/sbin/iptables");
      expect(calls).toContain("--dport 53");
      expect(calls).toContain("cp /etc/resolv.conf /tmp/resolv.conf.orig");
      expect(calls).not.toContain("nsenter");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("fix-coredns.sh", () => {
  it("exists and is executable", () => {
    const stat = fs.statSync(FIX_COREDNS);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o100).toBeTruthy();
  });

  it("patches CoreDNS on a Podman-style Docker host using a resolved upstream", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fix-coredns-"));
    const fakeBin = path.join(tmp, "bin");
    const dockerLog = path.join(tmp, "docker.log");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "docker"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(dockerLog)}
if [ "\${1:-}" = "ps" ]; then echo "openshell-cluster-nemoclaw"; exit 0; fi
if [ "\${1:-}" = "exec" ] && [ "\${3:-}" = "cat" ]; then echo "nameserver 9.9.9.9"; exit 0; fi
exit 0
`,
      { mode: 0o755 },
    );

    try {
      const result = spawnSync("bash", [FIX_COREDNS, "nemoclaw"], {
        encoding: "utf-8",
        env: {
          ...process.env,
          DOCKER_HOST: "unix:///run/user/1000/podman/podman.sock",
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
        },
      });
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).toBe(0);
      expect(output).toContain("Patching CoreDNS to forward to 9.9.9.9");
      expect(output).toContain("Done. DNS should resolve");
      const calls = fs.readFileSync(dockerLog, "utf-8");
      expect(calls).toContain("kubectl patch configmap coredns");
      expect(calls).toContain("forward . 9.9.9.9");
      expect(calls).toContain("rollout restart deploy/coredns");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects invalid resolved upstream values before patching CoreDNS", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fix-coredns-bad-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "docker"),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "ps" ]; then echo "openshell-cluster-nemoclaw"; exit 0; fi
if [ "\${1:-}" = "exec" ] && [ "\${3:-}" = "cat" ]; then echo "nameserver bad;rm"; exit 0; fi
exit 0
`,
      { mode: 0o755 },
    );

    try {
      const result = spawnSync("bash", [FIX_COREDNS, "nemoclaw"], {
        encoding: "utf-8",
        env: {
          ...process.env,
          DOCKER_HOST: "unix:///run/user/1000/podman/podman.sock",
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
        },
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("contains invalid characters");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
