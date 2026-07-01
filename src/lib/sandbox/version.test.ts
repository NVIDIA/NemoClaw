// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock heavy dependencies that pull in the full module graph
vi.mock("../adapters/openshell/resolve.js", () => ({
  resolveOpenshell: vi.fn(() => "/usr/local/bin/openshell"),
}));

vi.mock("../adapters/openshell/client.js", () => ({
  parseVersionFromText: (value = "") => {
    const match = String(value).match(/([0-9]+\.[0-9]+\.[0-9]+)/);
    return match ? match[1] : null;
  },
  versionGte: (left = "0.0.0", right = "0.0.0") => {
    const lhs = String(left)
      .split(".")
      .map((p) => parseInt(p, 10) || 0);
    const rhs = String(right)
      .split(".")
      .map((p) => parseInt(p, 10) || 0);
    const length = Math.max(lhs.length, rhs.length);
    for (let i = 0; i < length; i++) {
      const a = lhs[i] || 0;
      const b = rhs[i] || 0;
      if (a > b) return true;
      if (a < b) return false;
    }
    return true;
  },
  captureSandboxSshConfigCommand: vi.fn(),
}));

const { EXPECTED_VERSION_BY_AGENT } = vi.hoisted(() => ({
  EXPECTED_VERSION_BY_AGENT: {
    openclaw: "2026.5.27",
    "hermes-calendar-pin": "2026.6.19",
    "high-major-semver": "999.9.9",
    "low-year-semver": "2010.0.0",
  } as Record<string, string>,
}));

vi.mock("../agent/defs.js", () => ({
  loadAgent: vi.fn((name: string) => ({
    name,
    displayName: name === "openclaw" ? "OpenClaw" : "Hermes Agent",
    versionCommand: name === "openclaw" ? "openclaw --version" : "hermes --version",
    expectedVersion: EXPECTED_VERSION_BY_AGENT[name] ?? "0.17.0",
    stateDirs: [],
    configPaths: { dir: "/sandbox/.openclaw" },
  })),
}));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawnSync: vi.fn() };
});

import { spawnSync } from "child_process";
import { captureSandboxSshConfigCommand } from "../adapters/openshell/client.js";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../adapters/openshell/timeouts.js";
import * as registry from "../state/registry.js";
import { checkAgentVersion, formatStalenessWarning } from "./version.js";

describe("checkAgentVersion", () => {
  let tmpDir: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sandbox-ver-test-"));
    process.env.HOME = tmpDir;
    mkdirSync(join(tmpDir, ".nemoclaw"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".nemoclaw", "sandboxes.json"),
      JSON.stringify({ sandboxes: {}, defaultSandbox: null }),
    );
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("fast path: uses cached agentVersion from registry", () => {
    registry.registerSandbox({
      name: "test-sb",
      agent: null,
      agentVersion: "2026.5.27",
    });

    const result = checkAgentVersion("test-sb");
    expect(result.detectionMethod).toBe("registry");
    expect(result.sandboxVersion).toBe("2026.5.27");
    expect(result.isStale).toBe(false);
  });

  it("fast path: detects stale version from registry", () => {
    registry.registerSandbox({
      name: "test-sb",
      agent: null,
      agentVersion: "2026.3.11",
    });

    const result = checkAgentVersion("test-sb");
    expect(result.detectionMethod).toBe("registry");
    expect(result.sandboxVersion).toBe("2026.3.11");
    expect(result.isStale).toBe(true);
  });

  it("fast path: same version is not stale", () => {
    registry.registerSandbox({
      name: "test-sb",
      agent: null,
      agentVersion: "2026.5.27",
    });

    const result = checkAgentVersion("test-sb");
    expect(result.isStale).toBe(false);
  });

  it("slow path: probes via SSH when no cached version", () => {
    registry.registerSandbox({ name: "test-sb", agent: null });

    vi.mocked(captureSandboxSshConfigCommand).mockReturnValue({
      status: 0,
      output: "Host openshell-test-sb\n  HostName 127.0.0.1\n",
    });

    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "OpenClaw 2026.5.27 (abc123)\n",
      stderr: "",
      pid: 1234,
      output: [],
      signal: null,
    });

    const result = checkAgentVersion("test-sb");
    expect(result.detectionMethod).toBe("ssh-exec");
    expect(result.sandboxVersion).toBe("2026.5.27");
    expect(result.isStale).toBe(false);
    expect(captureSandboxSshConfigCommand).toHaveBeenCalledWith(
      "/usr/local/bin/openshell",
      "test-sb",
      { ignoreError: true, timeout: OPENSHELL_PROBE_TIMEOUT_MS },
    );
    const sshArgs = vi.mocked(spawnSync).mock.calls[0]?.[1] as string[];
    const configFile = sshArgs[sshArgs.indexOf("-F") + 1];
    const configDir = dirname(configFile);
    expect(configDir).not.toBe(tmpdir());
    expect(basename(configDir)).toMatch(/^nemoclaw-ver-/);
    expect(basename(configFile)).toBe("ssh_config");
    expect(existsSync(configDir)).toBe(false);

    // Should have cached the version in registry
    const updated = registry.getSandbox("test-sb");
    expect(updated?.agentVersion).toBe("2026.5.27");
  });

  it("returns an unknown verdict when SSH config fails so callers do not read isStale as verified current", () => {
    registry.registerSandbox({ name: "test-sb", agent: null });

    vi.mocked(captureSandboxSshConfigCommand).mockReturnValue({
      status: 1,
      output: "",
    });

    const result = checkAgentVersion("test-sb");
    expect(result.detectionMethod).toBe("unknown");
    expect(result.unavailableReason).toBe("probe-failed");
    expect(result.isStale).toBe(false);
  });

  it("can skip live probing when no cached version is available", () => {
    registry.registerSandbox({ name: "test-sb", agent: null });
    vi.mocked(captureSandboxSshConfigCommand).mockClear();
    vi.mocked(spawnSync).mockClear();

    const result = checkAgentVersion("test-sb", { skipProbe: true });

    expect(result.detectionMethod).toBe("unavailable");
    expect(result.sandboxVersion).toBeNull();
    expect(result.isStale).toBe(false);
    expect(captureSandboxSshConfigCommand).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("force probe bypasses cached version", () => {
    registry.registerSandbox({
      name: "test-sb",
      agent: null,
      agentVersion: "2026.3.11",
    });

    vi.mocked(captureSandboxSshConfigCommand).mockReturnValue({
      status: 0,
      output: "Host openshell-test-sb\n  HostName 127.0.0.1\n",
    });

    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "OpenClaw 2026.5.27 (abc123)\n",
      stderr: "",
      pid: 1234,
      output: [],
      signal: null,
    });

    const result = checkAgentVersion("test-sb", { forceProbe: true });
    expect(result.detectionMethod).toBe("ssh-exec");
    expect(result.sandboxVersion).toBe("2026.5.27");
  });

  it("force probe returns unknown when the live probe fails so cached metadata cannot silently mask drift", () => {
    registry.registerSandbox({
      name: "test-sb",
      agent: null,
      agentVersion: "2026.5.18",
    });

    vi.mocked(captureSandboxSshConfigCommand).mockReturnValue({
      status: 0,
      output: "",
    });
    vi.mocked(spawnSync).mockClear();

    const result = checkAgentVersion("test-sb", { forceProbe: true });

    expect(result.detectionMethod).toBe("unknown");
    expect(result.unavailableReason).toBe("probe-failed");
    expect(result.sandboxVersion).toBeNull();
    expect(result.isStale).toBe(false);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("does not flag an update for a hermes runtime that matches the expected semver", () => {
    registry.registerSandbox({
      name: "hermes-sb",
      agent: "hermes",
      agentVersion: "0.17.0",
    });

    const result = checkAgentVersion("hermes-sb");
    expect(result.detectionMethod).toBe("registry");
    expect(result.sandboxVersion).toBe("0.17.0");
    expect(result.isStale).toBe(false);
  });

  it("flags a hermes runtime that is behind the expected semver", () => {
    registry.registerSandbox({
      name: "hermes-sb",
      agent: "hermes",
      agentVersion: "0.16.9",
    });

    const result = checkAgentVersion("hermes-sb");
    expect(result.sandboxVersion).toBe("0.16.9");
    expect(result.isStale).toBe(true);
  });

  it("flags a scheme-mismatched cached version as stale so the rebuild flow realigns runtime and manifest (#6049)", () => {
    registry.registerSandbox({
      name: "hermes-sb",
      agent: "hermes-calendar-pin",
      agentVersion: "0.17.0",
    });

    const result = checkAgentVersion("hermes-sb");
    expect(result.detectionMethod).toBe("registry");
    expect(result.sandboxVersion).toBe("0.17.0");
    expect(result.schemeMismatch).toBe(true);
    expect(result.isStale).toBe(true);
  });

  it("treats a semver with a four-digit major that does not start with 20 as semver, not calendar (#6049)", () => {
    registry.registerSandbox({
      name: "high-major-sb",
      agent: "high-major-semver",
      agentVersion: "1000.0.0",
    });

    const result = checkAgentVersion("high-major-sb");
    expect(result.detectionMethod).toBe("registry");
    expect(result.sandboxVersion).toBe("1000.0.0");
    expect(result.verificationFailed).toBe(false);
    expect(result.isStale).toBe(false);
  });

  it("flags a same-scheme semver when the sandbox trails a four-digit-major expected pin (#6049)", () => {
    registry.registerSandbox({
      name: "high-major-sb",
      agent: "high-major-semver",
      agentVersion: "999.9.8",
    });

    const result = checkAgentVersion("high-major-sb");
    expect(result.verificationFailed).toBe(false);
    expect(result.isStale).toBe(true);
  });

  it("treats a semver with a pre-2020 four-digit major as semver, not calendar (#6049)", () => {
    registry.registerSandbox({
      name: "low-year-sb",
      agent: "low-year-semver",
      agentVersion: "2010.0.0",
    });

    const result = checkAgentVersion("low-year-sb");
    expect(result.detectionMethod).toBe("registry");
    expect(result.sandboxVersion).toBe("2010.0.0");
    expect(result.schemeMismatch).toBeFalsy();
    expect(result.isStale).toBe(false);
  });

  it("without a manifest version_scheme, falls back to shape classification so a matching-shape cached value is treated as current (#6049)", () => {
    registry.registerSandbox({ name: "openclaw-sb", agent: null, agentVersion: "2026.5.27" });

    const result = checkAgentVersion("openclaw-sb");
    expect(result.detectionMethod).toBe("registry");
    expect(result.sandboxVersion).toBe("2026.5.27");
    expect(result.schemeMismatch).toBeFalsy();
    expect(result.isStale).toBe(false);
  });

  it("flags a calendar-manifest agent with a semver runtime as scheme-mismatched and stale (#6049)", () => {
    registry.registerSandbox({ name: "openclaw-sb", agent: "openclaw", agentVersion: "1.2.3" });

    const result = checkAgentVersion("openclaw-sb");
    expect(result.detectionMethod).toBe("registry");
    expect(result.sandboxVersion).toBe("1.2.3");
    expect(result.schemeMismatch).toBe(true);
    expect(result.isStale).toBe(true);
  });

  it("emits a structured JSON payload to stderr when a scheme mismatch is detected (#6049)", () => {
    registry.registerSandbox({
      name: "hermes-warn-sb",
      agent: "hermes-calendar-pin",
      agentVersion: "0.17.0",
    });

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      checkAgentVersion("hermes-warn-sb");
    } finally {
      process.stderr.write = originalWrite;
    }

    const line = stderrChunks.join("");
    const jsonStart = line.indexOf("{");
    const payload = JSON.parse(line.slice(jsonStart).trim());
    expect(payload).toEqual({
      event: "sandbox_version_scheme_mismatch",
      sandbox: "hermes-warn-sb",
      sandboxVersion: "0.17.0",
      expectedVersion: "2026.6.19",
      action: "flagged_as_stale",
    });
  });

  it("flags a scheme mismatch discovered during an ssh probe as stale (#6049)", () => {
    registry.registerSandbox({ name: "hermes-sb", agent: "hermes-calendar-pin" });

    vi.mocked(captureSandboxSshConfigCommand).mockReturnValue({
      status: 0,
      output: "Host openshell-hermes-sb\n  HostName 127.0.0.1\n",
    });
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "hermes 0.17.0\n",
      stderr: "",
      pid: 4321,
      output: [],
      signal: null,
    });

    const result = checkAgentVersion("hermes-sb");
    expect(result.detectionMethod).toBe("ssh-exec");
    expect(result.sandboxVersion).toBe("0.17.0");
    expect(result.schemeMismatch).toBe(true);
    expect(result.isStale).toBe(true);
  });

  it("surfaces the reason when checkAgentVersion cannot inspect the sandbox", () => {
    registry.registerSandbox({ name: "test-sb", agent: null });

    const result = checkAgentVersion("test-sb", { skipProbe: true });

    expect(result.detectionMethod).toBe("unavailable");
    expect(result.unavailableReason).toBe("skip-probe");
  });

  it("probes a hermes runtime over ssh and does not flag a matching semver", () => {
    registry.registerSandbox({ name: "hermes-sb", agent: "hermes" });

    vi.mocked(captureSandboxSshConfigCommand).mockReturnValue({
      status: 0,
      output: "Host openshell-hermes-sb\n  HostName 127.0.0.1\n",
    });
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "hermes 0.17.0\n",
      stderr: "",
      pid: 4321,
      output: [],
      signal: null,
    });

    const result = checkAgentVersion("hermes-sb");
    expect(result.detectionMethod).toBe("ssh-exec");
    expect(result.sandboxVersion).toBe("0.17.0");
    expect(result.isStale).toBe(false);
  });
});

describe("formatStalenessWarning", () => {
  let tmpDir: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sandbox-warn-test-"));
    process.env.HOME = tmpDir;
    mkdirSync(join(tmpDir, ".nemoclaw"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".nemoclaw", "sandboxes.json"),
      JSON.stringify({ sandboxes: {}, defaultSandbox: null }),
    );
    registry.registerSandbox({ name: "my-sb", agent: null });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("includes sandbox name, versions, and rebuild hint", () => {
    const lines = formatStalenessWarning("my-sb", {
      sandboxVersion: "2026.3.11",
      expectedVersion: "2026.5.27",
      isStale: true,
      verificationFailed: false,
      detectionMethod: "registry",
    });
    const joined = lines.join("\n");
    expect(joined).toContain("my-sb");
    expect(joined).toContain("2026.3.11");
    expect(joined).toContain("2026.5.27");
    expect(joined).toContain("rebuild");
  });
});
