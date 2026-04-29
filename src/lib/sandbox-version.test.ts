// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock heavy dependencies that pull in the full module graph
vi.mock("./resolve-openshell.js", () => ({
  resolveOpenshell: vi.fn(() => "/usr/local/bin/openshell"),
}));

vi.mock("./openshell.js", () => ({
  parseVersionFromText: (value = "") => {
    const match = String(value).match(/([0-9]+\.[0-9]+\.[0-9]+)/);
    return match ? match[1] : null;
  },
  versionGte: (left = "0.0.0", right = "0.0.0") => {
    const lhs = String(left).split(".").map((p) => parseInt(p, 10) || 0);
    const rhs = String(right).split(".").map((p) => parseInt(p, 10) || 0);
    const length = Math.max(lhs.length, rhs.length);
    for (let i = 0; i < length; i++) {
      const a = lhs[i] || 0;
      const b = rhs[i] || 0;
      if (a > b) return true;
      if (a < b) return false;
    }
    return true;
  },
  captureOpenshellCommand: vi.fn(),
}));

vi.mock("./agent-defs.js", () => ({
  loadAgent: vi.fn((name: string) => ({
    name,
    displayName: name === "openclaw" ? "OpenClaw" : "Hermes Agent",
    versionCommand: name === "openclaw" ? "openclaw --version" : "hermes --version",
    expectedVersion: name === "openclaw" ? "2026.4.24" : "2026.4.24",
    stateDirs: [],
    configPaths: { writableDir: "/sandbox/.openclaw-data" },
  })),
}));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawnSync: vi.fn() };
});

import { checkAgentVersion, formatStalenessWarning } from "./sandbox-version.js";
import * as registry from "./registry.js";
import { captureOpenshellCommand } from "./openshell.js";
import { spawnSync } from "child_process";

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
      agentVersion: "2026.4.24",
    });

    const result = checkAgentVersion("test-sb");
    expect(result.detectionMethod).toBe("registry");
    expect(result.sandboxVersion).toBe("2026.4.24");
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
      agentVersion: "2026.4.24",
    });

    const result = checkAgentVersion("test-sb");
    expect(result.isStale).toBe(false);
  });

  it("slow path: probes via SSH when no cached version", () => {
    registry.registerSandbox({ name: "test-sb", agent: null });

    vi.mocked(captureOpenshellCommand).mockReturnValue({
      status: 0,
      output: "Host openshell-test-sb\n  HostName 127.0.0.1\n",
    });

    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "OpenClaw 2026.4.24 (abc123)\n",
      stderr: "",
      pid: 1234,
      output: [],
      signal: null,
    });

    const result = checkAgentVersion("test-sb");
    expect(result.detectionMethod).toBe("ssh-exec");
    expect(result.sandboxVersion).toBe("2026.4.24");
    expect(result.isStale).toBe(false);

    // Should have cached the version in registry
    const updated = registry.getSandbox("test-sb");
    expect(updated?.agentVersion).toBe("2026.4.24");
  });

  it("returns unavailable when SSH config fails", () => {
    registry.registerSandbox({ name: "test-sb", agent: null });

    vi.mocked(captureOpenshellCommand).mockReturnValue({
      status: 1,
      output: "",
    });

    const result = checkAgentVersion("test-sb");
    expect(result.detectionMethod).toBe("unavailable");
    expect(result.isStale).toBe(false);
  });

  it("force probe bypasses cached version", () => {
    registry.registerSandbox({
      name: "test-sb",
      agent: null,
      agentVersion: "2026.3.11",
    });

    vi.mocked(captureOpenshellCommand).mockReturnValue({
      status: 0,
      output: "Host openshell-test-sb\n  HostName 127.0.0.1\n",
    });

    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "OpenClaw 2026.4.24 (abc123)\n",
      stderr: "",
      pid: 1234,
      output: [],
      signal: null,
    });

    const result = checkAgentVersion("test-sb", { forceProbe: true });
    expect(result.detectionMethod).toBe("ssh-exec");
    expect(result.sandboxVersion).toBe("2026.4.24");
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
      expectedVersion: "2026.4.24",
      isStale: true,
      detectionMethod: "registry",
    });
    const joined = lines.join("\n");
    expect(joined).toContain("my-sb");
    expect(joined).toContain("2026.3.11");
    expect(joined).toContain("2026.4.24");
    expect(joined).toContain("rebuild");
  });
});
