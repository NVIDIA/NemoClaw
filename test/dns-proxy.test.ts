// @ts-nocheck
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
    expect(content).toContain("-C OUTPUT");
    expect(content).toContain("getent hosts");
    expect(content).toContain("VERIFY_PASS");
    expect(content).toContain("VERIFY_FAIL");
  });

  it("probes well-known paths when iptables is not on PATH (#557)", () => {
    const content = fs.readFileSync(SETUP_DNS_PROXY, "utf-8");
    // Must check /sbin/iptables and /usr/sbin/iptables as fallback paths
    expect(content).toContain("/sbin/iptables");
    expect(content).toContain("/usr/sbin/iptables");
    expect(content).toContain("IPTABLES_BIN");
  });

  it("uses discovered iptables binary for both rule insertion and verification", () => {
    const content = fs.readFileSync(SETUP_DNS_PROXY, "utf-8");
    // The discovered IPTABLES_BIN should be used in the -C check and -I insert
    expect(content).toContain('"$IPTABLES_BIN" -C OUTPUT');
    expect(content).toContain('"$IPTABLES_BIN" -I OUTPUT');
    // Verification step should also use the discovered binary
    expect(content).toContain("IPTABLES_CHECK");
  });

  it("warns when iptables is not found at any path", () => {
    const content = fs.readFileSync(SETUP_DNS_PROXY, "utf-8");
    expect(content).toContain("iptables not found in pod");
    expect(content).toContain("Cannot add UDP DNS exception");
  });

  it("backs up resolv.conf before rewriting and restores on iptables failure", () => {
    const content = fs.readFileSync(SETUP_DNS_PROXY, "utf-8");
    // Backup: save original resolv.conf once before any rewrite
    expect(content).toContain("resolv.conf.orig");
    expect(content).toContain("cp /etc/resolv.conf /tmp/resolv.conf.orig");
    // Restore: copy backup back when iptables is not found
    expect(content).toContain("cp /tmp/resolv.conf.orig /etc/resolv.conf");
  });
});

describe("fix-coredns.sh", () => {
  it("exists and is executable", () => {
    const stat = fs.statSync(FIX_COREDNS);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o100).toBeTruthy();
  });

  it("supports multiple container runtimes (not Colima-only)", () => {
    const content = fs.readFileSync(FIX_COREDNS, "utf-8");
    expect(content).toContain("DOCKER_HOST");
    expect(content).toContain("find_podman_socket");
  });

  it("delegates DNS resolution to resolve_coredns_upstream", () => {
    const content = fs.readFileSync(FIX_COREDNS, "utf-8");
    expect(content).toContain("resolve_coredns_upstream");
  });

  it("validates UPSTREAM_DNS before use", () => {
    const content = fs.readFileSync(FIX_COREDNS, "utf-8");
    expect(content).toContain("UPSTREAM_DNS");
    expect(content).toContain("invalid characters");
  });
});
