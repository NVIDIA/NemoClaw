// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runSsh } = vi.hoisted(() => ({ runSsh: vi.fn() }));
vi.mock("../adapters/openshell/sandbox-ssh-cli.js", () => ({
  createCliOpenShellSandboxSshExecutor: () => ({ run: runSsh }),
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

// state/registry captures the registry path at module scope, so HOME must be
// redirected before it loads. Static ESM imports are hoisted above this
// assignment, hence the dynamic imports below; reassigning HOME from
// beforeEach() would be too late and every registerSandbox() would land in the
// developer's real ~/.nemoclaw/sandboxes.json (#6553).
const TEST_HOME = mkdtempSync(join(tmpdir(), "sandbox-ver-test-"));
const ORIGINAL_HOME = process.env.HOME;
process.env.HOME = TEST_HOME;

const registry = await import("../state/registry.js");
const { checkAgentVersion, formatStalenessWarning } = await import("./version.js");

const TEST_REGISTRY_FILE = join(TEST_HOME, ".nemoclaw", "sandboxes.json");

function resetTestRegistry(): void {
  mkdirSync(dirname(TEST_REGISTRY_FILE), { recursive: true });
  writeFileSync(TEST_REGISTRY_FILE, JSON.stringify({ sandboxes: {}, defaultSandbox: null }));
}

afterAll(() => {
  process.env.HOME = ORIGINAL_HOME;
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("registry isolation", async () => {
  it("resolves the registry inside the test HOME, never the real one (#6553)", async () => {
    expect(registry.REGISTRY_FILE).toBe(TEST_REGISTRY_FILE);
    expect(registry.REGISTRY_FILE.startsWith(TEST_HOME)).toBe(true);
  });
});

describe("checkAgentVersion", async () => {
  beforeEach(() => {
    resetTestRegistry();
    runSsh.mockReset().mockResolvedValue({ kind: "failed", reason: "configuration" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fast path: uses cached agentVersion from registry", async () => {
    registry.registerSandbox({
      name: "test-sb",
      agent: null,
      agentVersion: "2026.5.27",
    });

    const result = await checkAgentVersion("test-sb");
    expect(result.detectionMethod).toBe("registry");
    expect(result.sandboxVersion).toBe("2026.5.27");
    expect(result.isStale).toBe(false);
  });

  it("fast path: detects stale version from registry", async () => {
    registry.registerSandbox({
      name: "test-sb",
      agent: null,
      agentVersion: "2026.3.11",
    });

    const result = await checkAgentVersion("test-sb");
    expect(result.detectionMethod).toBe("registry");
    expect(result.sandboxVersion).toBe("2026.3.11");
    expect(result.isStale).toBe(true);
  });

  it("fast path: same version is not stale", async () => {
    registry.registerSandbox({
      name: "test-sb",
      agent: null,
      agentVersion: "2026.5.27",
    });

    const result = await checkAgentVersion("test-sb");
    expect(result.isStale).toBe(false);
  });

  it("slow path: probes via SSH when no cached version", async () => {
    registry.registerSandbox({ name: "test-sb", agent: null });

    runSsh.mockResolvedValue({
      kind: "completed",
      exitCode: 0,
      stdout: "OpenClaw 2026.5.27 (abc123)\n",
      stderr: "",
    });

    const result = await checkAgentVersion("test-sb");
    expect(result.detectionMethod).toBe("ssh-exec");
    expect(result.sandboxVersion).toBe("2026.5.27");
    expect(result.isStale).toBe(false);
    // A row that pre-dates the per-port migration resolves to the canonical
    // default gateway, and the probe pins to it explicitly rather than
    // inheriting OpenShell's current selection (#7429).

    expect(runSsh).toHaveBeenCalledWith({
      sandboxName: "test-sb",
      target: { kind: "named", gatewayName: "nemoclaw" },
      command: "openclaw --version",
    });

    // Should have cached the version in registry
    const updated = registry.getSandbox("test-sb");
    expect(updated?.agentVersion).toBe("2026.5.27");
  });

  it("probes the sandbox's own recorded gateway, not OpenShell's ambient selection (#7429)", async () => {
    // A sandbox onboarded under a non-default NEMOCLAW_GATEWAY_PORT is
    // registered against `nemoclaw-<port>`. `openshell sandbox get` /
    // `ssh-config` fall back to OpenShell's mutable current selection when no
    // gateway is given, so an unscoped probe queries the wrong gateway,
    // returns "not found", and the sandbox is reported as `v?` even though the
    // gateway-scoped sandbox listing observed it as live.
    registry.registerSandbox({ name: "test-sb", agent: null, gatewayPort: 18080 });

    runSsh.mockResolvedValue({
      kind: "completed",
      exitCode: 0,
      stdout: "OpenClaw 2026.5.27 (abc123)\n",
      stderr: "",
    });

    const result = await checkAgentVersion("test-sb", { forceProbe: true });

    expect(result.detectionMethod).toBe("ssh-exec");
    expect(runSsh).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: "named", gatewayName: "nemoclaw-18080" } }),
    );
  });

  it("scopes a Hermes sandbox on a non-default gateway to its own gateway (#7429)", async () => {
    // The exact reported topology: a Hermes sandbox onboarded under a
    // non-default NEMOCLAW_GATEWAY_PORT. Before the fix the probe queried
    // OpenShell's ambient selection, came back "not found", and
    // `upgrade-sandboxes --check` printed `v? → v0.18.0`.
    registry.registerSandbox({ name: "hermes-sb", agent: "hermes", gatewayPort: 18080 });

    runSsh.mockResolvedValue({
      kind: "completed",
      exitCode: 0,
      stdout: "Hermes Agent 0.17.0\n",
      stderr: "",
    });

    const result = await checkAgentVersion("hermes-sb", { forceProbe: true });

    // The version resolves instead of landing in the "Unknown version" bucket.
    expect(result.detectionMethod).toBe("ssh-exec");
    expect(result.sandboxVersion).toBe("0.17.0");
    expect(result.verificationFailed).toBe(false);
    // The Hermes agent definition drives the probe, not the openclaw default.
    expect(runSsh).toHaveBeenCalledWith({
      sandboxName: "hermes-sb",
      target: { kind: "named", gatewayName: "nemoclaw-18080" },
      command: "hermes --version",
    });
  });

  it("does not probe at all when the persisted gateway binding is corrupted (#7429)", async () => {
    // resolveSandboxGatewayName fails closed on an invalid binding. Falling
    // back to an unscoped probe would defeat that: OpenShell would resolve the
    // name against its ambient selection, so a same-named sandbox on another
    // gateway could be probed and its version cached onto this row. A row with
    // no binding fields resolves to the canonical default instead of throwing,
    // so this path is reached only by genuinely corrupted state.
    registry.registerSandbox({ name: "test-sb", agent: null, gatewayName: "not-a-nemoclaw-gw" });

    const result = await checkAgentVersion("test-sb", { forceProbe: true });

    expect(runSsh).not.toHaveBeenCalled();
    // No probe was attempted, so the contract's `unavailable` applies —
    // `unknown`/`probe-failed` would claim a probe ran and failed.
    expect(result.detectionMethod).toBe("unavailable");
    expect(result.unavailableReason).toBe("invalid-gateway-binding");
    expect(result.verificationFailed).toBe(true);
    expect(result.sandboxVersion).toBeNull();
  });

  it("returns an unknown verdict when SSH config fails so callers do not read isStale as verified current", async () => {
    registry.registerSandbox({ name: "test-sb", agent: null });

    const result = await checkAgentVersion("test-sb");
    expect(result.detectionMethod).toBe("unknown");
    expect(result.unavailableReason).toBe("probe-failed");
    expect(result.isStale).toBe(false);
  });

  it.each(["configuration", "unavailable", "timeout", "cancelled", "transport", "capture"])(
    "leaves the cached version unchanged after a %s failure",
    async (reason) => {
      registry.registerSandbox({ name: "test-sb", agent: null, agentVersion: "2026.3.11" });
      runSsh.mockResolvedValue({ kind: "failed", reason });
      expect(await checkAgentVersion("test-sb", { forceProbe: true })).toMatchObject({
        detectionMethod: "unknown",
        unavailableReason: "probe-failed",
        verificationFailed: true,
        sandboxVersion: null,
      });
      expect(registry.getSandbox("test-sb")?.agentVersion).toBe("2026.3.11");
    },
  );

  it.each([
    { exitCode: 7, stdout: "2026.5.27" },
    { exitCode: 0, stdout: "unknown" },
  ])("does not cache an unsuccessful version observation %j", async (result) => {
    registry.registerSandbox({ name: "test-sb", agent: null });
    runSsh.mockResolvedValue({ kind: "completed", stderr: "", ...result });
    expect(await checkAgentVersion("test-sb")).toMatchObject({
      verificationFailed: true,
      sandboxVersion: null,
    });
    expect(registry.getSandbox("test-sb")?.agentVersion).toBeFalsy();
  });

  it("can skip live probing when no cached version is available", async () => {
    registry.registerSandbox({ name: "test-sb", agent: null });

    const result = await checkAgentVersion("test-sb", { skipProbe: true });

    expect(result.detectionMethod).toBe("unavailable");
    expect(result.sandboxVersion).toBeNull();
    expect(result.isStale).toBe(false);
    expect(runSsh).not.toHaveBeenCalled();
  });

  it("force probe bypasses cached version", async () => {
    registry.registerSandbox({
      name: "test-sb",
      agent: null,
      agentVersion: "2026.3.11",
    });

    runSsh.mockResolvedValue({
      kind: "completed",
      exitCode: 0,
      stdout: "OpenClaw 2026.5.27 (abc123)\n",
      stderr: "",
    });

    const result = await checkAgentVersion("test-sb", { forceProbe: true });
    expect(result.detectionMethod).toBe("ssh-exec");
    expect(result.sandboxVersion).toBe("2026.5.27");
  });

  it("force probe returns unknown when the live probe fails so cached metadata cannot silently mask drift", async () => {
    registry.registerSandbox({
      name: "test-sb",
      agent: null,
      agentVersion: "2026.5.18",
    });

    const result = await checkAgentVersion("test-sb", { forceProbe: true });

    expect(result.detectionMethod).toBe("unknown");
    expect(result.unavailableReason).toBe("probe-failed");
    expect(result.sandboxVersion).toBeNull();
    expect(result.isStale).toBe(false);
  });

  it("does not flag an update for a hermes runtime that matches the expected semver", async () => {
    registry.registerSandbox({
      name: "hermes-sb",
      agent: "hermes",
      agentVersion: "0.17.0",
    });

    const result = await checkAgentVersion("hermes-sb");
    expect(result.detectionMethod).toBe("registry");
    expect(result.sandboxVersion).toBe("0.17.0");
    expect(result.isStale).toBe(false);
  });

  it("flags a hermes runtime that is behind the expected semver", async () => {
    registry.registerSandbox({
      name: "hermes-sb",
      agent: "hermes",
      agentVersion: "0.16.9",
    });

    const result = await checkAgentVersion("hermes-sb");
    expect(result.sandboxVersion).toBe("0.16.9");
    expect(result.isStale).toBe(true);
  });

  it("flags a scheme-mismatched cached version as stale so the rebuild flow realigns runtime and manifest (#6049)", async () => {
    registry.registerSandbox({
      name: "hermes-sb",
      agent: "hermes-calendar-pin",
      agentVersion: "0.17.0",
    });

    const result = await checkAgentVersion("hermes-sb");
    expect(result.detectionMethod).toBe("registry");
    expect(result.sandboxVersion).toBe("0.17.0");
    expect(result.schemeMismatch).toBe(true);
    expect(result.isStale).toBe(true);
  });

  it("treats a semver with a four-digit major that does not start with 20 as semver, not calendar (#6049)", async () => {
    registry.registerSandbox({
      name: "high-major-sb",
      agent: "high-major-semver",
      agentVersion: "1000.0.0",
    });

    const result = await checkAgentVersion("high-major-sb");
    expect(result.detectionMethod).toBe("registry");
    expect(result.sandboxVersion).toBe("1000.0.0");
    expect(result.verificationFailed).toBe(false);
    expect(result.isStale).toBe(false);
  });

  it("flags a same-scheme semver when the sandbox trails a four-digit-major expected pin (#6049)", async () => {
    registry.registerSandbox({
      name: "high-major-sb",
      agent: "high-major-semver",
      agentVersion: "999.9.8",
    });

    const result = await checkAgentVersion("high-major-sb");
    expect(result.verificationFailed).toBe(false);
    expect(result.isStale).toBe(true);
  });

  it("treats a semver with a pre-2020 four-digit major as semver, not calendar (#6049)", async () => {
    registry.registerSandbox({
      name: "low-year-sb",
      agent: "low-year-semver",
      agentVersion: "2010.0.0",
    });

    const result = await checkAgentVersion("low-year-sb");
    expect(result.detectionMethod).toBe("registry");
    expect(result.sandboxVersion).toBe("2010.0.0");
    expect(result.schemeMismatch).toBeFalsy();
    expect(result.isStale).toBe(false);
  });

  it("without a manifest version_scheme, falls back to shape classification so a matching-shape cached value is treated as current (#6049)", async () => {
    registry.registerSandbox({ name: "openclaw-sb", agent: null, agentVersion: "2026.5.27" });

    const result = await checkAgentVersion("openclaw-sb");
    expect(result.detectionMethod).toBe("registry");
    expect(result.sandboxVersion).toBe("2026.5.27");
    expect(result.schemeMismatch).toBeFalsy();
    expect(result.isStale).toBe(false);
  });

  it("flags a calendar-manifest agent with a semver runtime as scheme-mismatched and stale (#6049)", async () => {
    registry.registerSandbox({ name: "openclaw-sb", agent: "openclaw", agentVersion: "1.2.3" });

    const result = await checkAgentVersion("openclaw-sb");
    expect(result.detectionMethod).toBe("registry");
    expect(result.sandboxVersion).toBe("1.2.3");
    expect(result.schemeMismatch).toBe(true);
    expect(result.isStale).toBe(true);
  });

  it("emits a structured JSON payload to stderr when a scheme mismatch is detected (#6049)", async () => {
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
      await checkAgentVersion("hermes-warn-sb");
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

  it("flags a scheme mismatch discovered during an ssh probe as stale (#6049)", async () => {
    registry.registerSandbox({ name: "hermes-sb", agent: "hermes-calendar-pin" });

    runSsh.mockResolvedValue({
      kind: "completed",
      exitCode: 0,
      stdout: "hermes 0.17.0\n",
      stderr: "",
    });

    const result = await checkAgentVersion("hermes-sb");
    expect(result.detectionMethod).toBe("ssh-exec");
    expect(result.sandboxVersion).toBe("0.17.0");
    expect(result.schemeMismatch).toBe(true);
    expect(result.isStale).toBe(true);
  });

  it("surfaces the reason when checkAgentVersion cannot inspect the sandbox", async () => {
    registry.registerSandbox({ name: "test-sb", agent: null });

    const result = await checkAgentVersion("test-sb", { skipProbe: true });

    expect(result.detectionMethod).toBe("unavailable");
    expect(result.unavailableReason).toBe("skip-probe");
  });

  it("probes a hermes runtime over ssh and does not flag a matching semver", async () => {
    registry.registerSandbox({ name: "hermes-sb", agent: "hermes" });

    runSsh.mockResolvedValue({
      kind: "completed",
      exitCode: 0,
      stdout: "hermes 0.17.0\n",
      stderr: "",
    });

    const result = await checkAgentVersion("hermes-sb");
    expect(result.detectionMethod).toBe("ssh-exec");
    expect(result.sandboxVersion).toBe("0.17.0");
    expect(result.isStale).toBe(false);
  });
});

describe("formatStalenessWarning", async () => {
  beforeEach(() => {
    resetTestRegistry();
    runSsh.mockReset().mockResolvedValue({ kind: "failed", reason: "configuration" });
    registry.registerSandbox({ name: "my-sb", agent: null });
  });

  it("includes sandbox name, versions, and rebuild hint", async () => {
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
