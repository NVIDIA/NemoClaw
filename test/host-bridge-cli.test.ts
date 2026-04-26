// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const CLI = path.join(import.meta.dirname, "..", "bin", "nemoclaw.js");
const cleanupDirs: string[] = [];

function writeSandboxRegistry(home: string): void {
  const registryDir = path.join(home, ".nemoclaw");
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, "sandboxes.json"),
    JSON.stringify(
      {
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

function writeFakeOpenshell(home: string, initialPolicy: string): {
  logFile: string;
  policyFile: string;
  hostServiceFile: string;
} {
  const localBin = path.join(home, ".local", "bin");
  const stateDir = path.join(home, "fake-openshell");
  const logFile = path.join(stateDir, "openshell.log");
  const policyFile = path.join(stateDir, "policy.yaml");
  const hostServiceFile = path.join(stateDir, "host-service.json");
  fs.mkdirSync(localBin, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(policyFile, initialPolicy, { mode: 0o600 });
  fs.writeFileSync(
    path.join(localBin, "openshell"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `log_file=${JSON.stringify(logFile)}`,
      `policy_file=${JSON.stringify(policyFile)}`,
      `host_service_file=${JSON.stringify(hostServiceFile)}`,
      'printf "%s\\n" "$*" >> "$log_file"',
      'if [ "${1:-}" = "--version" ]; then',
      '  echo "OpenShell CLI tool"',
      "  exit 0",
      "fi",
      'if [ "${1:-}" = "sandbox" ] && [ "${2:-}" = "get" ] && [ "${3:-}" = "alpha" ]; then',
      '  echo "Name: alpha"',
      "  exit 0",
      "fi",
      'if [ "${1:-}" = "policy" ] && [ "${2:-}" = "get" ] && [ "${3:-}" = "alpha" ] && [ "${4:-}" = "--full" ]; then',
      '  echo "Version:      1"',
      '  echo "---"',
      '  cat "$policy_file"',
      "  exit 0",
      "fi",
      'if [ "${1:-}" = "policy" ] && [ "${2:-}" = "set" ] && [ "${3:-}" = "--policy" ] && [ "${5:-}" = "--wait" ] && [ "${6:-}" = "alpha" ]; then',
      '  cp "$4" "$policy_file"',
      "  exit 0",
      "fi",
      'if [ "${1:-}" = "host-service" ] && [ "${2:-}" = "register" ] && [ "${3:-}" = "--sandbox" ] && [ "${4:-}" = "alpha" ] && [ "${5:-}" = "--file" ]; then',
      '  cp "$6" "$host_service_file"',
      "  exit 0",
      "fi",
      'if [ "${1:-}" = "host-service" ] && [ "${2:-}" = "unregister" ] && [ "${3:-}" = "--sandbox" ] && [ "${4:-}" = "alpha" ]; then',
      '  rm -f "$host_service_file"',
      "  exit 0",
      "fi",
      'if [ "${1:-}" = "host-service" ] && [ "${2:-}" = "list" ] && [ "${3:-}" = "--sandbox" ] && [ "${4:-}" = "alpha" ]; then',
      '  if [ -f "$host_service_file" ]; then cat "$host_service_file"; fi',
      "  exit 0",
      "fi",
      'echo "unexpected openshell invocation: $*" >&2',
      "exit 1",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { logFile, policyFile, hostServiceFile };
}

function runWithEnv(args: string, env: NodeJS.ProcessEnv): { code: number; out: string } {
  try {
    const out = execSync(`node "${CLI}" ${args}`, {
      encoding: "utf-8",
      env,
      timeout: 10000,
    });
    return { code: 0, out };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status || 1, out: `${err.stdout || ""}${err.stderr || ""}` };
  }
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    fs.rmSync(cleanupDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("host-bridge CLI", () => {
  it("adds the codex-version bridge, registers the host service, and writes evidence", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-bridge-add-"));
    cleanupDirs.push(home);
    writeSandboxRegistry(home);
    const fake = writeFakeOpenshell(home, "version: 1\nnetwork_policies: {}\n");

    const result = runWithEnv("alpha host-bridge add codex-version", {
      ...process.env,
      HOME: home,
      PATH: `${path.join(home, ".local", "bin")}:${process.env.PATH || ""}`,
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain("Applied host bridge 'codex-version' to sandbox 'alpha'.");
    expect(fs.readFileSync(fake.policyFile, "utf-8")).toContain("codex-bridge.local");
    expect(fs.readFileSync(fake.hostServiceFile, "utf-8")).toContain('"service_name": "codex-bridge.local"');
    expect(fs.readFileSync(fake.logFile, "utf-8")).toContain("host-service register --sandbox alpha --file");
    expect(fs.readFileSync(fake.logFile, "utf-8")).toContain("policy set --policy");

    const evidenceRoot = path.join(home, ".nemoclaw", "state", "host-bridges", "alpha");
    const snapshots = fs.readdirSync(evidenceRoot);
    expect(snapshots.length).toBe(1);
    const evidenceDir = path.join(evidenceRoot, snapshots[0]);
    expect(fs.existsSync(path.join(evidenceDir, "policy_before.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(evidenceDir, "policy_after.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(evidenceDir, "bridge_registration.json"))).toBe(true);
    expect(fs.existsSync(path.join(evidenceDir, "revert.sh"))).toBe(true);
    expect(fs.existsSync(path.join(evidenceDir, "validation_notes.txt"))).toBe(true);
  });

  it("removes the codex-version bridge and restores the policy", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-bridge-remove-"));
    cleanupDirs.push(home);
    writeSandboxRegistry(home);
    const fake = writeFakeOpenshell(
      home,
      [
        "version: 1",
        "network_policies:",
        "  codex_bridge:",
        "    name: codex_bridge",
        "    endpoints:",
        "      - host: codex-bridge.local",
        "        port: 80",
        "        protocol: rest",
        "        enforcement: enforce",
        "        rules:",
        '          - allow: { method: POST, path: "/codex_version" }',
      ].join("\n") + "\n",
    );
    fs.writeFileSync(fake.hostServiceFile, '{"service_name":"codex-bridge.local"}\n', {
      mode: 0o600,
    });

    const result = runWithEnv("alpha host-bridge remove codex-version", {
      ...process.env,
      HOME: home,
      PATH: `${path.join(home, ".local", "bin")}:${process.env.PATH || ""}`,
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain("Removed host bridge 'codex-version' from sandbox 'alpha'.");
    expect(fs.readFileSync(fake.policyFile, "utf-8")).not.toContain("codex-bridge.local");
    expect(fs.existsSync(fake.hostServiceFile)).toBe(false);
    expect(fs.readFileSync(fake.logFile, "utf-8")).toContain("host-service unregister --sandbox alpha");
    expect(fs.readFileSync(fake.logFile, "utf-8")).toContain("policy set --policy");
  });

  it("lists the codex-version bridge state from policy, host service, and evidence", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-bridge-list-"));
    cleanupDirs.push(home);
    writeSandboxRegistry(home);
    const fake = writeFakeOpenshell(
      home,
      [
        "version: 1",
        "network_policies:",
        "  codex_bridge:",
        "    name: codex_bridge",
        "    endpoints:",
        "      - host: codex-bridge.local",
        "        port: 80",
        "        protocol: rest",
        "        enforcement: enforce",
        "        rules:",
        '          - allow: { method: POST, path: "/codex_version" }',
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      fake.hostServiceFile,
      JSON.stringify({ service_name: "codex-bridge.local", target_host: "127.0.0.1" }, null, 2),
      { mode: 0o600 },
    );
    const evidenceDir = path.join(home, ".nemoclaw", "state", "host-bridges", "alpha", "latest");
    fs.mkdirSync(evidenceDir, { recursive: true });

    const result = runWithEnv("alpha host-bridge list", {
      ...process.env,
      HOME: home,
      PATH: `${path.join(home, ".local", "bin")}:${process.env.PATH || ""}`,
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain("Host bridge: codex-version");
    expect(result.out).toContain("Policy:  present");
    expect(result.out).toContain("Host service: available");
    expect(result.out).toContain("Evidence snapshots: 1");
  });

  it("lists gracefully when the OpenShell host-service command is unavailable", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-bridge-list-unsupported-"));
    cleanupDirs.push(home);
    writeSandboxRegistry(home);
    const localBin = path.join(home, ".local", "bin");
    const stateDir = path.join(home, "fake-openshell");
    const policyFile = path.join(stateDir, "policy.yaml");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(policyFile, "version: 1\nnetwork_policies: {}\n", { mode: 0o600 });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'if [ "${1:-}" = "sandbox" ] && [ "${2:-}" = "get" ] && [ "${3:-}" = "alpha" ]; then',
        '  echo "Name: alpha"',
        "  exit 0",
        "fi",
        'if [ "${1:-}" = "policy" ] && [ "${2:-}" = "get" ] && [ "${3:-}" = "alpha" ] && [ "${4:-}" = "--full" ]; then',
        '  echo "Version:      1"',
        '  echo "---"',
        '  cat ' + JSON.stringify(policyFile),
        "  exit 0",
        "fi",
        'if [ "${1:-}" = "host-service" ]; then',
        "  echo \"error: unknown command 'host-service'\" >&2",
        "  exit 1",
        "fi",
        'echo "unexpected openshell invocation: $*" >&2',
        "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = runWithEnv("alpha host-bridge list", {
      ...process.env,
      HOME: home,
      PATH: `${path.join(home, ".local", "bin")}:${process.env.PATH || ""}`,
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain("Host service: OpenShell host-service commands unavailable in this build");
  });
});
