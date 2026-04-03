// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
      encoding: /** @type {const} */ ("utf-8"),
      env: { ...process.env },
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  });

  it("exits with usage when no sandbox name provided", () => {
    const result = spawnSync("bash", [SETUP_DNS_PROXY, "nemoclaw"], {
      encoding: /** @type {const} */ ("utf-8"),
      env: { ...process.env },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/Usage:/i);
  });

  it("discovers CoreDNS service IP and veth gateway dynamically", () => {
    const content = fs.readFileSync(SETUP_DNS_PROXY, "utf-8");
    expect(content).toContain("VETH_GW");
    expect(content).toContain("10.200.0.1");
  });

  it("adds iptables rule to allow UDP DNS from sandbox", () => {
    const content = fs.readFileSync(SETUP_DNS_PROXY, "utf-8");
    expect(content).toContain("iptables");
    expect(content).toContain("-p udp");
    expect(content).toContain("--dport 53");
    expect(content).toContain("ACCEPT");
  });

  it("deploys a Python DNS forwarder to the pod", () => {
    const content = fs.readFileSync(SETUP_DNS_PROXY, "utf-8");
    expect(content).toContain("dns-proxy.py");
    expect(content).toContain("socket.SOCK_DGRAM");
    expect(content).toContain("kctl exec");
  });

  it("uses kubectl exec (not nsenter) to launch the forwarder", () => {
    const content = fs.readFileSync(SETUP_DNS_PROXY, "utf-8");
    expect(content).toContain("kctl exec");
    expect(content).toContain("nohup python3");
    const codeLines = content.split("\n").filter((l) => !l.trimStart().startsWith("#"));
    expect(codeLines.join("\n")).not.toContain("nsenter");
  });

  it("uses grep -F for fixed-string sandbox name matching", () => {
    const content = fs.readFileSync(SETUP_DNS_PROXY, "utf-8");
    expect(content).toContain("grep -F");
  });

  it("discovers CoreDNS pod IP via kube-dns endpoints", () => {
    const content = fs.readFileSync(SETUP_DNS_PROXY, "utf-8");
    expect(content).toContain("get endpoints kube-dns");
    expect(content).toContain("kube-system");
  });

  it("verifies the forwarder started after launch", () => {
    const content = fs.readFileSync(SETUP_DNS_PROXY, "utf-8");
    expect(content).toContain("dns-proxy.pid");
    expect(content).toContain("dns-proxy.log");
  });

  it("performs runtime verification of resolv.conf, iptables, and DNS resolution", () => {
    const content = fs.readFileSync(SETUP_DNS_PROXY, "utf-8");
    expect(content).toContain("cat /etc/resolv.conf");
    expect(content).toContain("iptables -C OUTPUT");
    expect(content).toContain("getent hosts");
    expect(content).toContain("VERIFY_PASS");
    expect(content).toContain("VERIFY_FAIL");
  });
});

describe("fix-coredns.sh", () => {
  it("exists and is executable", () => {
    const stat = fs.statSync(FIX_COREDNS);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o100).toBeTruthy();
  });

  it("works with any Docker host (not Colima-specific)", () => {
    const content = fs.readFileSync(FIX_COREDNS, "utf-8");
    expect(content).not.toContain("find_colima_docker_socket");
    expect(content).toContain("detect_docker_host");
  });

  it("resolves systemd-resolved upstreams when resolv.conf is loopback-only", () => {
    const content = fs.readFileSync(FIX_COREDNS, "utf-8");
    expect(content).toContain("resolvectl");
    expect(content).toContain("Current DNS Server");
  });

  it("falls back to 8.8.8.8 only as last resort", () => {
    const content = fs.readFileSync(FIX_COREDNS, "utf-8");
    const lines = content.split("\n");
    const resolvectlLine = lines.findIndex((l) => l.includes("resolvectl"));
    const fallbackLine = lines.findIndex((l) => l.includes('UPSTREAM_DNS="8.8.8.8"'));
    expect(resolvectlLine).toBeGreaterThan(-1);
    expect(fallbackLine).toBeGreaterThan(-1);
    expect(fallbackLine).toBeGreaterThan(resolvectlLine);
  });
});
