// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import YAML from "yaml";
import { buildMcpBridgePolicyYaml } from "../actions/sandbox/mcp-bridge-policy-render";
import type { SandboxEntry } from "../state/registry";

const requireDist = createRequire(import.meta.url);
const shieldsModulePath = "./index.js";

type ShieldsHarness = {
  applyShieldsPolicySnapshot: typeof import("./index.js").applyShieldsPolicySnapshot;
  auditSpy: MockInstance;
  cleanupTempDirSpy: MockInstance;
  errorSpy: MockInstance;
  logSpy: MockInstance;
  policySetBodies: string[];
  runSpy: MockInstance;
  shieldsDown: typeof import("./index.js").shieldsDown;
  shieldsStatus: typeof import("./index.js").shieldsStatus;
  shieldsUp: typeof import("./index.js").shieldsUp;
  isShieldsDown: typeof import("./index.js").isShieldsDown;
  synchronizeAutoRestoreWithShieldsDown: typeof import("./index.js").synchronizeAutoRestoreWithShieldsDown;
};

let tmpDir: string;
const currentProcessStartIdentity = (
  requireDist("./timer-control.js") as typeof import("./timer-control.js")
).readProcessStartIdentity(process.pid);

type HarnessOptions = {
  beginContainment?: typeof import("../state/mcp-lifecycle-lock.js").beginCommittedMcpLifecycleContainmentSync;
  directSandboxUnavailable?: boolean;
  dockerExecFileSync?: (argv: unknown) => string;
  failOpenClawGuardActions?: Array<"lock" | "unlock">;
  failStateSave?: boolean;
  invokedAs?: "nemoclaw" | "nemohermes";
  openClawGuardFailure?: {
    code: string;
    path: string;
    detail: string;
  };
  openClawGuardFailures?: Array<{
    code: string;
    path: string;
    detail: string;
  }>;
  fork?: () => {
    pid: number;
    disconnect: () => void;
    unref: () => void;
    send: () => boolean;
    kill: () => boolean;
  };
  livePolicy?: string;
  run?: (cmd: unknown) => { status: number };
  sandboxEntry?: SandboxEntry;
};

function managedMcpPolicy(server: string, address = "8.8.8.8") {
  const content = buildMcpBridgePolicyYaml(
    server,
    `https://${server}.example.com/mcp`,
    "hermes-config",
    [address],
  );
  const entries = Object.entries(YAML.parse(content).network_policies as Record<string, unknown>);
  expect(entries, `rendered MCP policies for ${server}`).toHaveLength(1);
  const [key, networkPolicy] = entries[0]!;
  return { content, key, networkPolicy, server };
}

function managedMcpSandbox(policies: Array<ReturnType<typeof managedMcpPolicy>>): SandboxEntry {
  return {
    name: "openclaw",
    openshellDriver: "docker",
    customPolicies: policies.map(({ content, server }) => ({
      name: `mcp-bridge-${server}`,
      content,
      sourcePath: "generated:nemoclaw-mcp-bridge",
    })),
    mcp: {
      bridges: Object.fromEntries(
        policies.map(({ server }) => [
          server,
          {
            server,
            agent: "hermes",
            adapter: "hermes-config",
            url: `https://${server}.example.com/mcp`,
            env: ["MCP_SECRET"],
            policyName: `mcp-bridge-${server}`,
            addedAt: "2026-07-30T00:00:00.000Z",
          },
        ]),
      ),
    },
  };
}

function throwHarnessError(error: Error): never {
  throw error;
}

function recordPolicySetBody(policySetBodies: string[], file: unknown): void {
  policySetBodies.push(fs.readFileSync(String(file), "utf-8"));
}

function createHarness(options: HarnessOptions = {}): ShieldsHarness {
  vi.stubEnv("NEMOCLAW_INVOKED_AS", options.invokedAs ?? "nemoclaw");
  delete require.cache[requireDist.resolve(shieldsModulePath)];
  delete require.cache[requireDist.resolve("./timer-bound-lock.js")];
  delete require.cache[requireDist.resolve("./transition-lock.js")];
  delete require.cache[requireDist.resolve("./permissive-runtime.js")];
  delete require.cache[requireDist.resolve("../actions/sandbox/mcp-bridge-policy.js")];
  delete require.cache[requireDist.resolve("../sandbox/privileged-exec.js")];
  delete require.cache[requireDist.resolve("../cli/branding.js")];
  const lifecycleLock = requireDist(
    "../state/mcp-lifecycle-lock.js",
  ) as typeof import("../state/mcp-lifecycle-lock.js");
  const beginContainment =
    options.beginContainment ?? lifecycleLock.beginCommittedMcpLifecycleContainmentSync;
  vi.spyOn(lifecycleLock, "beginCommittedMcpLifecycleContainmentSync").mockImplementation(
    beginContainment,
  );
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);

  const runner = requireDist("../runner.js");
  const policy = requireDist("../policy/index.js");
  const agentConfig = requireDist("../sandbox/agent-config.js");
  const registry = requireDist("../state/registry.js");
  const privilegedExec = requireDist("../sandbox/privileged-exec.js");
  const dockerExec = requireDist("../adapters/docker/exec.js");
  const audit = requireDist("./audit.js");
  const tempFiles = requireDist("../onboard/temp-files.js");
  const childProcess = requireDist("node:child_process");
  const policySetBodies: string[] = [];
  let openClawPosture: "locked" | "mutable" = "mutable";

  vi.spyOn(runner, "validateName").mockImplementation((name: unknown) => String(name));
  vi.spyOn(runner, "runCapture").mockReturnValue(
    options.livePolicy ?? "version: 1\nnetwork_policies:\n  test: {}\n",
  );
  const runSpy = vi.spyOn(runner, "run").mockImplementation((cmd: unknown) => {
    return options.run ? options.run(cmd) : { status: 0 };
  });
  options.fork && vi.spyOn(childProcess, "fork").mockImplementation(options.fork);
  vi.spyOn(policy, "buildPolicyGetCommand").mockReturnValue(["openshell", "policy", "get"]);
  vi.spyOn(policy, "buildPolicySetCommand").mockImplementation((file: unknown) => {
    recordPolicySetBody(policySetBodies, file);
    return ["openshell", "policy", "set"];
  });
  vi.spyOn(policy, "parseCurrentPolicy").mockImplementation((raw: unknown) => String(raw));
  vi.spyOn(policy, "resolvePermissivePolicyPath").mockReturnValue(
    path.join(tmpDir, "permissive.yaml"),
  );
  fs.writeFileSync(path.join(tmpDir, "permissive.yaml"), "version: 1\nnetwork_policies: {}\n");
  vi.spyOn(agentConfig, "resolveAgentConfig").mockReturnValue({
    agentName: "openclaw",
    configDir: "/sandbox/.openclaw",
    configFile: "openclaw.json",
    configPath: "/sandbox/.openclaw/openclaw.json",
    format: "json",
  });
  vi.spyOn(registry, "getSandbox").mockReturnValue(
    options.sandboxEntry ?? { name: "openclaw", openshellDriver: "docker" },
  );
  vi.spyOn(registry, "listSandboxes").mockReturnValue({ sandboxes: [{ name: "openclaw" }] });
  const permissiveRuntime = requireDist(
    "./permissive-runtime.js",
  ) as typeof import("./permissive-runtime.js");
  const directSandboxUnavailableError = new Error(
    "No running direct OpenShell sandbox container found for 'openclaw' (driver: docker). Expected a running container named openshell-openclaw or openshell-openclaw-*. Is the sandbox running?",
  );
  vi.spyOn(privilegedExec, "isDirectSandboxFallbackUnavailableError").mockReturnValue(
    Boolean(options.directSandboxUnavailable),
  );
  vi.spyOn(privilegedExec, "privilegedSandboxExecArgv").mockImplementation(
    (_sandboxName: unknown, cmd: unknown) =>
      options.directSandboxUnavailable
        ? throwHarnessError(directSandboxUnavailableError)
        : [
            "exec",
            "--user",
            "root",
            "openshell-openclaw",
            ...(Array.isArray(cmd) ? cmd.map(String) : []),
          ],
  );
  vi.spyOn(dockerExec, "dockerSpawnSync").mockImplementation((argv: unknown) => {
    const args = Array.isArray(argv) ? argv.map(String) : [];
    const action = ["preflight", "lock", "unlock"].find((candidate) => args.includes(candidate));
    const openClawGuard = args.some((arg) => arg.endsWith("openclaw-config-guard.py"));
    const shouldFailOpenClawGuard = Boolean(
      openClawGuard &&
        (action === "lock" || action === "unlock") &&
        options.failOpenClawGuardActions?.includes(action),
    );
    const failures = options.openClawGuardFailures ?? [
      options.openClawGuardFailure ?? {
        code: "startup-not-ready",
        path: "/run/nemoclaw/openclaw-config-ready.json",
        detail: "OpenClaw startup is not ready for host config mutations",
      },
    ];
    const failureResult = {
      status: 1,
      signal: null,
      stdout: `${failures
        .map((failure) => JSON.stringify({ type: "issue", ...failure }))
        .join("\n")}\n${JSON.stringify({ type: "result", action, status: "failed" })}\n`,
      stderr: "",
      pid: 0,
      output: [],
    };
    openClawPosture = shouldFailOpenClawGuard
      ? openClawPosture
      : openClawGuard && action === "lock"
        ? "locked"
        : openClawGuard && action === "unlock"
          ? "mutable"
          : openClawPosture;
    const successResult = {
      status: 0,
      signal: null,
      stdout: action
        ? `${JSON.stringify({
            type: "result",
            action,
            status: "ok",
            ...(openClawGuard
              ? {
                  configDir: "/sandbox/.openclaw",
                  files: ["openclaw.json", ".config-hash"],
                  chattrApplied: action === "lock",
                }
              : { issueCount: 0 }),
          })}\n`
        : "",
      stderr: "",
      pid: 0,
      output: [],
    };
    return (shouldFailOpenClawGuard ? failureResult : successResult) as never;
  });
  vi.spyOn(dockerExec, "dockerExecFileSync").mockImplementation((argv: unknown) => {
    const args = Array.isArray(argv) ? argv.map(String) : [];
    return options.dockerExecFileSync
      ? options.dockerExecFileSync(argv)
      : args.includes("sha256sum")
        ? "a".repeat(64) + "  /sandbox/.openclaw/openclaw.json\n"
        : args.includes("stat")
          ? args.at(-1) === "/sandbox"
            ? openClawPosture === "locked"
              ? "1775 root:sandbox\n"
              : "755 sandbox:sandbox\n"
            : args.at(-1) === "/sandbox/.openclaw"
              ? openClawPosture === "locked"
                ? "755 root:root\n"
                : "2770 sandbox:sandbox\n"
              : openClawPosture === "locked"
                ? "444 root:root\n"
                : "660 sandbox:sandbox\n"
          : "";
  });
  const auditSpy = vi.spyOn(audit, "appendAuditEntry").mockImplementation(() => undefined);
  const cleanupTempDirSpy = vi.spyOn(tempFiles, "cleanupTempDir");
  const prepareStateSaveFailure = options.failStateSave
    ? () =>
        fs.mkdirSync(path.join(tmpDir, ".nemoclaw", "state", "shields-openclaw.json"), {
          recursive: true,
        })
    : () => undefined;
  const buildRuntimePermissivePolicy = permissiveRuntime.buildRuntimePermissivePolicy;
  vi.spyOn(permissiveRuntime, "buildRuntimePermissivePolicy").mockImplementation(
    (basePath, deps) => {
      const runtimePolicy = buildRuntimePermissivePolicy(basePath, deps);
      prepareStateSaveFailure();
      return runtimePolicy;
    },
  );

  const shields = requireDist(shieldsModulePath);
  logSpy.mockClear();
  errorSpy.mockClear();
  auditSpy.mockClear();
  return {
    applyShieldsPolicySnapshot: shields.applyShieldsPolicySnapshot,
    auditSpy,
    cleanupTempDirSpy,
    errorSpy,
    logSpy,
    policySetBodies,
    runSpy,
    shieldsDown: shields.shieldsDown,
    shieldsStatus: shields.shieldsStatus,
    shieldsUp: shields.shieldsUp,
    isShieldsDown: shields.isShieldsDown,
    synchronizeAutoRestoreWithShieldsDown: shields.synchronizeAutoRestoreWithShieldsDown,
  };
}

function expectStagedDriverNeutralRecovery(
  errorSpy: MockInstance,
  sandboxName: string,
  cliName = "nemoclaw",
): string {
  const output = errorSpy.mock.calls.flat().map(String).join("\n");
  expect(output).toContain(
    `Recovery: confirm the sandbox is running and ready, then retry \`${cliName} ${sandboxName} shields up\`.`,
  );
  expect(output).toContain(
    `If the retry still fails, rebuild a known-good baseline with \`${cliName} ${sandboxName} rebuild --yes\`.`,
  );
  expect(output).not.toMatch(/kubectl/i);
  return output;
}

function writeExpiredShieldsFixture(
  processToken: string,
  reason: string,
  ownerState: "dead" | "live",
) {
  const liveOwner = ownerState === "live";
  const sandboxName = "openclaw";
  const stateDir = path.join(tmpDir, ".nemoclaw", "state");
  const snapshotPath = path.join(stateDir, `snapshot-${processToken.slice(0, 8)}.yaml`);
  const timerMarkerPath = path.join(stateDir, `shields-timer-${sandboxName}.json`);
  const transitionLockPath = path.join(stateDir, `shields-transition-lock-${sandboxName}.json`);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  test: {}\n");
  fs.writeFileSync(
    path.join(stateDir, `shields-${sandboxName}.json`),
    JSON.stringify({
      shieldsDown: true,
      shieldsDownAt: new Date(Date.now() - 120_000).toISOString(),
      shieldsDownTimeout: 60,
      shieldsDownReason: reason,
      shieldsDownPolicy: "permissive",
      shieldsPolicySnapshotPath: snapshotPath,
    }),
  );
  fs.writeFileSync(
    timerMarkerPath,
    JSON.stringify({
      pid: liveOwner ? 2_147_483_647 : 4242,
      sandboxName,
      snapshotPath,
      restoreAt: new Date(Date.now() - 60_000).toISOString(),
      processToken,
    }),
  );
  fs.writeFileSync(
    transitionLockPath,
    JSON.stringify({
      version: 1,
      sandboxName,
      pid: liveOwner ? process.pid : 4242,
      processStartIdentity: liveOwner ? currentProcessStartIdentity : "dead-timer",
      command: liveOwner ? "shields down" : "shields auto-restore",
      acquiredAtMs: Date.now() - 60_000,
      takeoverToken: processToken,
    }),
  );
  return { stateDir, timerMarkerPath, transitionLockPath };
}

describe("shields command flow", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shields-flow-"));
    vi.stubEnv("HOME", tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[requireDist.resolve(shieldsModulePath)];
    delete require.cache[requireDist.resolve("./timer-bound-lock.js")];
    delete require.cache[requireDist.resolve("./transition-lock.js")];
    delete require.cache[requireDist.resolve("./permissive-runtime.js")];
    delete require.cache[requireDist.resolve("../actions/sandbox/mcp-bridge-policy.js")];
    delete require.cache[requireDist.resolve("../cli/branding.js")];
  });

  it("shieldsDown captures policy, unlocks config, saves state, and skips timer on request", {
    timeout: 15_000,
  }, () => {
    const harness = createHarness();

    harness.shieldsDown("openclaw", {
      timeout: "5m",
      reason: "coverage",
      skipTimer: true,
      throwOnError: true,
    });

    const statePath = path.join(tmpDir, ".nemoclaw", "state", "shields-openclaw.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    expect(state).toMatchObject({
      shieldsDown: true,
      shieldsDownTimeout: 300,
      shieldsDownReason: "coverage",
      shieldsDownPolicy: "permissive",
    });
    expect(fs.existsSync(state.shieldsPolicySnapshotPath)).toBe(true);
    expect(harness.isShieldsDown("openclaw")).toBe(true);
    expect(harness.logSpy.mock.calls.flat().join("\n")).toContain(
      "Config unlocked for openclaw (no auto-lockdown timer",
    );
  });

  it("shieldsDown preserves an exact managed MCP policy and records its snapshot key (#7952)", {
    timeout: 15_000,
  }, () => {
    const alpha = managedMcpPolicy("alpha");
    const harness = createHarness({
      livePolicy: YAML.stringify({
        version: 1,
        network_policies: {
          restrictive_baseline: { endpoints: [{ host: "baseline.example.com" }] },
          mcp_bridge_alpha: alpha.networkPolicy,
        },
      }),
      sandboxEntry: managedMcpSandbox([alpha]),
    });

    harness.shieldsDown("openclaw", {
      timeout: "5m",
      reason: "managed MCP transition coverage",
      skipTimer: true,
      throwOnError: true,
    });

    const state = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".nemoclaw", "state", "shields-openclaw.json"), "utf-8"),
    );
    expect(state.shieldsManagedMcpPolicyKeys).toEqual(["mcp_bridge_alpha"]);
    const applied = YAML.parse(harness.policySetBodies.at(-1)!);
    expect(applied.network_policies.mcp_bridge_alpha).toEqual(alpha.networkPolicy);
    expect(applied.network_policies).not.toHaveProperty("restrictive_baseline");
  });

  it("cleans the staged managed MCP policy when timer startup fails", () => {
    const alpha = managedMcpPolicy("alpha");
    const harness = createHarness({
      fork: () => {
        throw new Error("timer startup failed");
      },
      livePolicy: YAML.stringify({
        version: 1,
        network_policies: { [alpha.key]: alpha.networkPolicy },
      }),
      sandboxEntry: managedMcpSandbox([alpha]),
    });

    expect(() =>
      harness.shieldsDown("openclaw", {
        timeout: "5m",
        reason: "cleanup coverage",
        throwOnError: true,
      }),
    ).toThrow("Cannot start auto-restore timer: timer startup failed");

    expect(harness.cleanupTempDirSpy).toHaveBeenCalledWith(
      expect.stringContaining("nemoclaw-permissive-runtime"),
      "nemoclaw-permissive-runtime",
    );
    expect(harness.cleanupTempDirSpy).toHaveBeenCalledTimes(1);
    const stagedPolicyPath = String(harness.cleanupTempDirSpy.mock.calls.at(-1)?.[0]);
    expect(fs.existsSync(path.dirname(stagedPolicyPath))).toBe(false);
  });

  it("cleans the staged managed MCP policy when state persistence fails", () => {
    const alpha = managedMcpPolicy("alpha");
    const harness = createHarness({
      failStateSave: true,
      livePolicy: YAML.stringify({
        version: 1,
        network_policies: { [alpha.key]: alpha.networkPolicy },
      }),
      sandboxEntry: managedMcpSandbox([alpha]),
    });

    expect(() =>
      harness.shieldsDown("openclaw", {
        timeout: "5m",
        reason: "cleanup coverage",
        skipTimer: true,
        throwOnError: true,
      }),
    ).toThrow(/EISDIR|directory/i);

    expect(harness.cleanupTempDirSpy).toHaveBeenCalledWith(
      expect.stringContaining("nemoclaw-permissive-runtime"),
      "nemoclaw-permissive-runtime",
    );
    expect(harness.cleanupTempDirSpy).toHaveBeenCalledTimes(1);
    const stagedPolicyPath = String(harness.cleanupTempDirSpy.mock.calls.at(-1)?.[0]);
    expect(fs.existsSync(path.dirname(stagedPolicyPath))).toBe(false);
  });

  it("timer restore uses persisted MCP ownership after its transition marker clears (#7952)", () => {
    const alpha = managedMcpPolicy("alpha", "8.8.8.8");
    const beta = managedMcpPolicy("beta", "1.1.1.1");
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    const snapshotPath = path.join(stateDir, "policy-snapshot-managed-restore.yaml");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      snapshotPath,
      YAML.stringify({
        version: 1,
        network_policies: {
          restrictive_baseline: { endpoints: [{ host: "baseline.example.com" }] },
          mcp_bridge_alpha: alpha.networkPolicy,
        },
      }),
    );
    fs.writeFileSync(
      path.join(stateDir, "shields-openclaw.json"),
      JSON.stringify({
        shieldsDown: true,
        shieldsPolicySnapshotPath: snapshotPath,
        shieldsManagedMcpPolicyKeys: ["mcp_bridge_alpha"],
      }),
    );
    const harness = createHarness({
      livePolicy: YAML.stringify({
        version: 1,
        network_policies: {
          permissive_baseline: { endpoints: [{ host: "*" }] },
          mcp_bridge_alpha: alpha.networkPolicy,
          mcp_bridge_beta: beta.networkPolicy,
        },
      }),
      sandboxEntry: managedMcpSandbox([alpha, beta]),
    });

    const result = harness.applyShieldsPolicySnapshot("openclaw", snapshotPath, {
      transitionProcessToken: "6".repeat(32),
    });

    expect(result.status).toBe(0);
    const restored = YAML.parse(harness.policySetBodies.at(-1)!);
    expect(Object.keys(restored.network_policies).sort()).toEqual([
      "mcp_bridge_alpha",
      "mcp_bridge_beta",
      "restrictive_baseline",
    ]);
    expect(restored.network_policies.mcp_bridge_beta).toEqual(beta.networkPolicy);
  });

  it("refuses managed snapshot restoration when persisted Shields state is corrupt (#7952)", () => {
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    const snapshotPath = path.join(stateDir, "policy-snapshot-corrupt-state.yaml");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies: {}\n");
    fs.writeFileSync(
      path.join(stateDir, "shields-openclaw.json"),
      JSON.stringify({
        shieldsDown: true,
        shieldsPolicySnapshotPath: snapshotPath,
        shieldsManagedMcpPolicyKeys: ["../not-a-managed-key"],
      }),
    );
    const harness = createHarness();

    expect(() => harness.applyShieldsPolicySnapshot("openclaw", snapshotPath)).toThrow(
      /persisted state is corrupt/,
    );
    expect(harness.policySetBodies).toHaveLength(0);
  });

  it("refuses a legacy restore whose persisted state names a different snapshot (#7952)", () => {
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    const expectedSnapshotPath = path.join(stateDir, "policy-snapshot-expected.yaml");
    const requestedSnapshotPath = path.join(stateDir, "policy-snapshot-requested.yaml");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(expectedSnapshotPath, "version: 1\nnetwork_policies: {}\n");
    fs.writeFileSync(requestedSnapshotPath, "version: 1\nnetwork_policies: {}\n");
    fs.writeFileSync(
      path.join(stateDir, "shields-openclaw.json"),
      JSON.stringify({
        shieldsDown: true,
        shieldsPolicySnapshotPath: expectedSnapshotPath,
      }),
    );
    const harness = createHarness();

    expect(() => harness.applyShieldsPolicySnapshot("openclaw", requestedSnapshotPath)).toThrow(
      /does not match the policy snapshot/,
    );
    expect(harness.policySetBodies).toHaveLength(0);
  });

  it("uses token-bound transition ownership when the forward owner dies before state commit (#7952)", () => {
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    const processToken = "8".repeat(32);
    const snapshotPath = path.join(stateDir, "policy-snapshot-new-cycle.yaml");
    const oldSnapshotPath = path.join(stateDir, "policy-snapshot-old-cycle.yaml");
    const alpha = managedMcpPolicy("alpha", "8.8.8.8");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      snapshotPath,
      YAML.stringify({
        version: 1,
        network_policies: { mcp_bridge_alpha: alpha.networkPolicy },
      }),
    );
    fs.writeFileSync(oldSnapshotPath, "version: 1\nnetwork_policies: {}\n");
    fs.writeFileSync(
      path.join(stateDir, "shields-openclaw.json"),
      JSON.stringify({
        shieldsDown: false,
        shieldsPolicySnapshotPath: oldSnapshotPath,
        shieldsManagedMcpPolicyKeys: [],
      }),
    );
    fs.writeFileSync(
      path.join(stateDir, `shields-transition-openclaw-${processToken}.json`),
      JSON.stringify({
        version: 1,
        phase: "preparing",
        ownerPid: process.pid,
        ownerStartIdentity: "forward-owner",
        processToken,
        sandboxName: "openclaw",
        snapshotPath,
        managedMcpPolicyKeys: ["mcp_bridge_alpha"],
      }),
    );
    const harness = createHarness({
      livePolicy: YAML.stringify({
        version: 1,
        network_policies: { mcp_bridge_alpha: alpha.networkPolicy },
      }),
      sandboxEntry: managedMcpSandbox([alpha]),
    });

    const result = harness.applyShieldsPolicySnapshot("openclaw", snapshotPath, {
      transitionProcessToken: processToken,
    });

    expect(result.status).toBe(0);
    expect(YAML.parse(harness.policySetBodies.at(-1)!).network_policies.mcp_bridge_alpha).toEqual(
      alpha.networkPolicy,
    );
  });

  it("loads 257 managed keys recorded by Shields down (#7952)", { timeout: 15_000 }, () => {
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    const snapshotPath = path.join(stateDir, "policy-snapshot-many-managed-keys.yaml");
    const policies = Array.from({ length: 257 }, (_, index) => managedMcpPolicy(`server${index}`));
    const keys = policies.map(({ key }) => key);
    const networkPolicies = Object.fromEntries(
      policies.map(({ key, networkPolicy }) => [key, networkPolicy]),
    );
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(snapshotPath, YAML.stringify({ network_policies: networkPolicies }));
    fs.writeFileSync(
      path.join(stateDir, "shields-openclaw.json"),
      JSON.stringify({
        shieldsDown: true,
        shieldsPolicySnapshotPath: snapshotPath,
        shieldsManagedMcpPolicyKeys: keys,
      }),
    );
    const harness = createHarness({
      livePolicy: YAML.stringify({ version: 1, network_policies: networkPolicies }),
      sandboxEntry: managedMcpSandbox(policies),
    });

    expect(harness.applyShieldsPolicySnapshot("openclaw", snapshotPath).status).toBe(0);
    const applied = YAML.parse(harness.policySetBodies.at(-1)!);
    const appliedKeys = Object.keys(applied.network_policies);
    expect([...appliedKeys].sort()).toEqual([...keys].sort());
    expect(appliedKeys).toHaveLength(257);
    expect(appliedKeys).toContain("mcp_bridge_server256");
  });

  it("binds manual shields-up to the active auto-restore timer generation", () => {
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    const sandboxName = "openclaw";
    const processToken = "9".repeat(32);
    const snapshotPath = path.join(stateDir, "policy-snapshot-manual-up.yaml");
    const lockPath = path.join(stateDir, `shields-transition-lock-${sandboxName}.json`);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  test: {}\n");
    fs.writeFileSync(
      path.join(stateDir, `shields-${sandboxName}.json`),
      JSON.stringify({
        shieldsDown: true,
        shieldsDownAt: new Date().toISOString(),
        shieldsDownTimeout: 300,
        shieldsDownReason: "manual-up-token-test",
        shieldsDownPolicy: "permissive",
        shieldsPolicySnapshotPath: snapshotPath,
      }),
    );
    fs.writeFileSync(
      path.join(stateDir, `shields-timer-${sandboxName}.json`),
      JSON.stringify({
        pid: 999_999,
        sandboxName,
        snapshotPath,
        restoreAt: new Date(Date.now() + 60_000).toISOString(),
        processToken,
      }),
    );

    let observedOwner: Record<string, unknown> | null = null;
    const harness = createHarness({
      run: () => {
        observedOwner = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
        return { status: 0 };
      },
      dockerExecFileSync: (argv: unknown) => {
        const args = Array.isArray(argv) ? argv.map(String) : [];
        switch (true) {
          case args.includes("sha256sum"):
            return `${"a".repeat(64)}  ${String(args.at(-1))}\n`;
          case args.includes("lsattr"):
            return `----i---------e----- ${String(args.at(-1))}\n`;
          case args.includes("stat"):
            return args.at(-1) === "/sandbox"
              ? "1775 root:sandbox\n"
              : args.at(-1) === "/sandbox/.openclaw"
                ? "755 root:root\n"
                : "444 root:root\n";
          default:
            return "";
        }
      },
    });
    harness.shieldsUp(sandboxName, { throwOnError: true });

    expect(observedOwner).toMatchObject({
      sandboxName,
      command: "shields up",
      takeoverToken: processToken,
    });
  });

  it("auto-restore waits for the forward shields-down commit before reclaiming policy", () => {
    const harness = createHarness();
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });

    const sandboxName = "openclaw";
    const processToken = "a".repeat(32);
    const snapshotPath = path.join(stateDir, "policy-snapshot-race.yaml");
    const transitionPath = path.join(
      stateDir,
      `shields-transition-${sandboxName}-${processToken}.json`,
    );
    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  test: {}\n");
    fs.writeFileSync(
      path.join(stateDir, `shields-timer-${sandboxName}.json`),
      JSON.stringify({
        pid: process.pid,
        sandboxName,
        snapshotPath,
        restoreAt: new Date(Date.now() - 1_000).toISOString(),
        processToken,
      }),
    );

    const owner = spawn(
      process.execPath,
      [
        "-e",
        [
          "const fs=require('fs')",
          "const p=process.argv[1]",
          "setTimeout(()=>{",
          " const v=JSON.parse(fs.readFileSync(p,'utf8'))",
          " const t=p+'.child.tmp'",
          " fs.writeFileSync(t,JSON.stringify({...v,phase:'active'}),{mode:0o600})",
          " fs.renameSync(t,p)",
          "},150)",
          "setTimeout(()=>{},1000)",
        ].join(";"),
        transitionPath,
      ],
      { stdio: "ignore" },
    );
    expect(owner.pid).toBeTypeOf("number");
    const timerControl = requireDist("./timer-control.js");
    const ownerStartIdentity = timerControl.readProcessStartIdentity(owner.pid);
    expect(ownerStartIdentity).toBeTypeOf("string");
    fs.writeFileSync(
      transitionPath,
      JSON.stringify({
        version: 1,
        phase: "preparing",
        ownerPid: owner.pid,
        ownerStartIdentity,
        processToken,
        sandboxName,
        snapshotPath,
      }),
      { mode: 0o600 },
    );

    const startedAt = Date.now();
    try {
      harness.synchronizeAutoRestoreWithShieldsDown(sandboxName);
    } finally {
      owner.kill("SIGTERM");
    }

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
    expect(fs.existsSync(transitionPath)).toBe(true);
    expect(harness.runSpy).toHaveBeenCalledWith(
      ["openshell", "policy", "set"],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("preserves a live transition owner instead of attempting portable process-tree takeover", () => {
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const sandboxName = "live-transition-owner";
    const processToken = "b".repeat(32);
    const lockPath = path.join(stateDir, `shields-transition-lock-${sandboxName}.json`);
    const owner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
      stdio: "ignore",
    });
    expect(owner.pid).toBeTypeOf("number");
    const timerControl = requireDist("./timer-control.js");
    const ownerStartIdentity = timerControl.readProcessStartIdentity(owner.pid);
    expect(ownerStartIdentity).toBeTypeOf("string");
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        version: 1,
        sandboxName,
        pid: owner.pid,
        processStartIdentity: ownerStartIdentity,
        command: "inference set",
        acquiredAtMs: Date.now(),
        takeoverToken: processToken,
      }),
      { mode: 0o600 },
    );
    const processKillSpy = vi.spyOn(process, "kill");
    createHarness();
    const shields = requireDist(shieldsModulePath) as {
      prepareAutoRestoreTransitionTakeover: (
        sandboxName: string,
        processToken: string,
        snapshotPath: string,
      ) => void;
    };

    try {
      expect(() =>
        shields.prepareAutoRestoreTransitionTakeover(
          sandboxName,
          processToken,
          path.join(stateDir, "unused-snapshot.yaml"),
        ),
      ).toThrow("still active");
      expect(processKillSpy).not.toHaveBeenCalledWith(owner.pid, "SIGSTOP");
      expect(processKillSpy).not.toHaveBeenCalledWith(owner.pid, "SIGKILL");
      expect(fs.existsSync(lockPath)).toBe(true);
    } finally {
      owner.kill("SIGKILL");
    }
  });

  it.each([
    ["matching", "c".repeat(32)],
    ["different", "d".repeat(32)],
  ])("permanently contains a %s-token transition whose owner exited in the recovery gap", (_tokenRelationship, transitionOwnerToken) => {
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const sandboxName = "dead-transition-owner";
    const processToken = "c".repeat(32);
    const transitionLockPath = path.join(stateDir, `shields-transition-lock-${sandboxName}.json`);
    fs.writeFileSync(
      transitionLockPath,
      JSON.stringify({
        version: 1,
        sandboxName,
        pid: 2_147_483_647,
        processStartIdentity: "dead-owner",
        command: "config set write",
        acquiredAtMs: Date.now(),
        takeoverToken: transitionOwnerToken,
      }),
      { mode: 0o600 },
    );
    createHarness();
    const transitionLock = requireDist("./transition-lock.js") as {
      withShieldsTransitionLock: (
        sandboxName: string,
        command: string,
        fn: () => void,
        options: { recoverStaleOwner: boolean; waitTimeoutMs: number },
      ) => void;
    };
    const shields = requireDist(shieldsModulePath) as {
      prepareAutoRestoreTransitionTakeover: (
        sandboxName: string,
        processToken: string,
        snapshotPath: string,
      ) => void;
    };
    const lifecycleLock = requireDist("../state/mcp-lifecycle-lock.js") as {
      getMcpLifecycleLockPath: (sandboxName: string, stateDir: string) => string;
    };
    const containmentPath = `${lifecycleLock.getMcpLifecycleLockPath(
      sandboxName,
      stateDir,
    )}.containment`;

    expect(() =>
      transitionLock.withShieldsTransitionLock(
        sandboxName,
        "shields auto-restore contender",
        () => undefined,
        {
          recoverStaleOwner: false,
          waitTimeoutMs: 0,
        },
      ),
    ).toThrow("recorded owner PID");
    expect(fs.existsSync(transitionLockPath)).toBe(true);
    expect(fs.existsSync(containmentPath)).toBe(false);

    expect(() =>
      shields.prepareAutoRestoreTransitionTakeover(
        sandboxName,
        processToken,
        path.join(stateDir, "unused-snapshot.yaml"),
      ),
    ).toThrow("permanent containment");
    expect(fs.existsSync(transitionLockPath)).toBe(true);
    expect(fs.existsSync(containmentPath)).toBe(true);
  });

  it("publishes preparing recovery ownership before weakening and active only after unlock", () => {
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    let observedPreparingDuringPolicy = false;
    let observedPreparingDuringUnlock = false;
    let authorizationSawMarker = false;
    const readOnlyTransition = () => {
      const transitionName = fs
        .readdirSync(stateDir)
        .find((name) => name.startsWith("shields-transition-openclaw-"));
      expect(transitionName).toBeDefined();
      return JSON.parse(fs.readFileSync(path.join(stateDir, transitionName!), "utf-8"));
    };
    const harness = createHarness({
      fork: () => ({
        pid: 4242,
        disconnect: vi.fn(),
        unref: vi.fn(),
        send: vi.fn(() => {
          authorizationSawMarker = fs.existsSync(
            path.join(stateDir, "shields-timer-openclaw.json"),
          );
          return true;
        }),
        kill: vi.fn(() => true),
      }),
      run: () => {
        observedPreparingDuringPolicy = readOnlyTransition().phase === "preparing";
        return { status: 0 };
      },
      dockerExecFileSync: (argv: unknown) => {
        const args = Array.isArray(argv) ? argv.map(String) : [];
        observedPreparingDuringUnlock ||= readOnlyTransition().phase === "preparing";
        switch (true) {
          case args.includes("sha256sum"):
            return `${"a".repeat(64)}  /sandbox/.openclaw/openclaw.json\n`;
          case args.includes("stat"):
            return args.at(-1) === "/sandbox"
              ? "755 sandbox:sandbox\n"
              : args.at(-1) === "/sandbox/.openclaw"
                ? "2770 sandbox:sandbox\n"
                : "660 sandbox:sandbox\n";
          default:
            return "";
        }
      },
    });

    harness.shieldsDown("openclaw", {
      timeout: "5m",
      reason: "race coverage",
      throwOnError: true,
    });

    const transition = readOnlyTransition();
    expect(observedPreparingDuringPolicy).toBe(true);
    expect(observedPreparingDuringUnlock).toBe(true);
    expect(authorizationSawMarker).toBe(true);
    expect(transition).toMatchObject({
      version: 1,
      phase: "active",
      ownerPid: process.pid,
      sandboxName: "openclaw",
      snapshotPath: expect.stringContaining("policy-snapshot-"),
      managedMcpPolicyKeys: [],
    });
    expect(fs.existsSync(path.join(stateDir, "shields-timer-openclaw.json"))).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "atomically replaces a timer marker symlink without modifying its target",
    () => {
      const stateDir = path.join(tmpDir, ".nemoclaw", "state");
      const markerPath = path.join(stateDir, "shields-timer-openclaw.json");
      const markerTargetPath = path.join(stateDir, "operator-owned-marker.json");
      const markerTarget = "operator-owned marker contents";
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(markerTargetPath, markerTarget);
      const originalRename = fs.renameSync.bind(fs);
      const plantMarkerSymlink = () => fs.symlinkSync(markerTargetPath, markerPath);
      const publicationRoutes = new Map<string, () => void>([[markerPath, plantMarkerSymlink]]);
      const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
        (publicationRoutes.get(String(destination)) ?? (() => undefined))();
        originalRename(source, destination);
      });
      const harness = createHarness({
        fork: () => ({
          pid: 4242,
          disconnect: vi.fn(),
          unref: vi.fn(),
          send: vi.fn(() => true),
          kill: vi.fn(() => true),
        }),
      });

      harness.shieldsDown("openclaw", {
        timeout: "5m",
        reason: "marker publication coverage",
        throwOnError: true,
      });

      expect(renameSpy).toHaveBeenCalledWith(expect.stringContaining(".tmp"), markerPath);
      const markerFd = fs.openSync(markerPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        expect(fs.fstatSync(markerFd).isFile()).toBe(true);
        expect(JSON.parse(fs.readFileSync(markerFd, "utf-8"))).toMatchObject({
          pid: 4242,
          sandboxName: "openclaw",
        });
      } finally {
        fs.closeSync(markerFd);
      }
      expect(fs.readFileSync(markerTargetPath, "utf-8")).toBe(markerTarget);
    },
  );

  it("shieldsUp refuses to mark lockdown active when the saved restrictive policy snapshot is missing", () => {
    const harness = createHarness();
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "shields-openclaw.json"),
      JSON.stringify({
        shieldsDown: true,
        shieldsDownAt: new Date(Date.now() - 120_000).toISOString(),
        shieldsDownTimeout: 300,
        shieldsDownReason: "coverage",
        shieldsDownPolicy: "permissive",
        shieldsPolicySnapshotPath: path.join(stateDir, "missing-snapshot.yaml"),
      }),
    );

    expect(() => harness.shieldsUp("openclaw", { throwOnError: true })).toThrow(
      "Saved policy snapshot is missing",
    );
  });

  it("reports staged driver-neutral recovery when shields-down rollback cannot re-lock (#6126)", () => {
    const harness = createHarness({ failOpenClawGuardActions: ["unlock", "lock"] });

    expect(() =>
      harness.shieldsDown("openclaw", {
        timeout: "5m",
        reason: "recovery-hint coverage",
        skipTimer: true,
        throwOnError: true,
      }),
    ).toThrow(/startup-not-ready/);

    const output = expectStagedDriverNeutralRecovery(harness.errorSpy, "openclaw");
    expect(output).toContain("Rolling back — restoring policy from snapshot");
    expect(output).toContain("Config remains unlocked — manual intervention required");
  });

  it("reports staged driver-neutral recovery when snapshot restoration fails (#6126)", () => {
    const harness = createHarness({ run: () => ({ status: 1 }) });
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    const snapshotPath = path.join(stateDir, "policy-snapshot-failed-restore.yaml");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies: {}\n");
    fs.writeFileSync(
      path.join(stateDir, "shields-openclaw.json"),
      JSON.stringify({
        shieldsDown: true,
        shieldsDownAt: new Date().toISOString(),
        shieldsDownTimeout: 300,
        shieldsDownReason: "recovery-hint coverage",
        shieldsDownPolicy: "permissive",
        shieldsPolicySnapshotPath: snapshotPath,
      }),
    );

    expect(() => harness.shieldsUp("openclaw", { throwOnError: true })).toThrow(
      "policy restore exited with status 1",
    );

    const output = expectStagedDriverNeutralRecovery(harness.errorSpy, "openclaw");
    expect(output).toContain("Config remains unlocked — manual intervention required");
  });

  it("reports staged driver-neutral recovery when the initial config lock fails (#6126)", () => {
    const harness = createHarness({ failOpenClawGuardActions: ["lock"] });

    expect(() => harness.shieldsUp("openclaw", { throwOnError: true })).toThrow(
      /startup-not-ready/,
    );

    const output = expectStagedDriverNeutralRecovery(harness.errorSpy, "openclaw");
    expect(output).toContain(
      "Warning: OpenClaw lock rollback could not restore the trusted posture",
    );
    expect(output).not.toContain("CRITICAL: OpenClaw lock rollback");
    expect(output).not.toContain(
      "OpenClaw lock rollback could not restore the trusted posture. Restore from a trusted backup and recreate the sandbox",
    );
  });

  it("uses the invoked nemohermes alias in staged recovery commands (#6126)", () => {
    const harness = createHarness({
      failOpenClawGuardActions: ["lock"],
      invokedAs: "nemohermes",
    });

    expect(() => harness.shieldsUp("openclaw", { throwOnError: true })).toThrow(
      /startup-not-ready/,
    );

    const output = expectStagedDriverNeutralRecovery(harness.errorSpy, "openclaw", "nemohermes");
    expect(output).not.toContain("`nemoclaw openclaw shields up`");
    expect(output).not.toContain("`nemoclaw openclaw rebuild --yes`");
  });

  it("reports staged recovery when a stopped sandbox prevents config relock (#6126)", () => {
    const harness = createHarness({ directSandboxUnavailable: true });

    expect(() => harness.shieldsUp("openclaw", { throwOnError: true })).toThrow(
      /No running direct OpenShell sandbox container found/,
    );

    const output = expectStagedDriverNeutralRecovery(harness.errorSpy, "openclaw");
    expect(output).toContain(
      "Warning: OpenClaw lock rollback could not restore the trusted posture",
    );
    expect(output).not.toContain("CRITICAL: OpenClaw lock rollback");
  });

  it("retains critical recovery for non-transient OpenClaw rollback failures (#6126)", () => {
    const harness = createHarness({
      failOpenClawGuardActions: ["lock"],
      openClawGuardFailure: {
        code: "unsafe-config-path",
        path: "/sandbox/.openclaw/openclaw.json",
        detail: "canonical config path is not a safe regular file",
      },
    });

    expect(() => harness.shieldsUp("openclaw", { throwOnError: true })).toThrow(
      /unsafe-config-path/,
    );

    const output = harness.errorSpy.mock.calls.flat().map(String).join("\n");
    expect(output).toContain(
      "CRITICAL: OpenClaw lock rollback could not restore the trusted posture. Restore from a trusted backup and recreate the sandbox.",
    );
    expect(output).not.toContain(
      "Warning: OpenClaw lock rollback could not restore the trusted posture",
    );
  });

  it("retains critical recovery for structural startup-not-ready diagnostics (#6126)", () => {
    const harness = createHarness({
      failOpenClawGuardActions: ["lock"],
      openClawGuardFailure: {
        code: "startup-not-ready",
        path: "/run/nemoclaw/openclaw-config-ready.json",
        detail: "installed config guard requires NemoClaw PID 1",
      },
    });

    expect(() => harness.shieldsUp("openclaw", { throwOnError: true })).toThrow(
      /requires NemoClaw PID 1/,
    );

    const output = harness.errorSpy.mock.calls.flat().map(String).join("\n");
    expect(output).toContain(
      "CRITICAL: OpenClaw lock rollback could not restore the trusted posture. Restore from a trusted backup and recreate the sandbox.",
    );
    expect(output).not.toContain(
      "Warning: OpenClaw lock rollback could not restore the trusted posture",
    );
  });

  it("retains critical recovery when a transient diagnostic is followed by another issue (#6126)", () => {
    const harness = createHarness({
      failOpenClawGuardActions: ["lock"],
      openClawGuardFailures: [
        {
          code: "startup-not-ready",
          path: "/run/nemoclaw/openclaw-config-ready.json",
          detail: "OpenClaw startup is not ready for host config mutations",
        },
        {
          code: "unsafe-config-path",
          path: "/sandbox/.openclaw/openclaw.json",
          detail: "canonical config path is not a safe regular file",
        },
      ],
    });

    expect(() => harness.shieldsUp("openclaw", { throwOnError: true })).toThrow(
      /unsafe-config-path/,
    );

    const output = harness.errorSpy.mock.calls.flat().map(String).join("\n");
    expect(output).toContain(
      "CRITICAL: OpenClaw lock rollback could not restore the trusted posture. Restore from a trusted backup and recreate the sandbox.",
    );
    expect(output).not.toContain(
      "Warning: OpenClaw lock rollback could not restore the trusted posture",
    );
  });

  it("reports staged driver-neutral recovery when drift remediation cannot re-lock (#6126)", () => {
    const harness = createHarness({ failOpenClawGuardActions: ["lock"] });
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "shields-openclaw.json"),
      JSON.stringify({
        shieldsDown: false,
        chattrApplied: false,
        fileHashes: {
          "/sandbox/.openclaw/openclaw.json": "a".repeat(64),
          "/sandbox/.openclaw/.config-hash": "a".repeat(64),
        },
      }),
    );

    expect(() => harness.shieldsUp("openclaw", { throwOnError: true })).toThrow(
      /startup-not-ready/,
    );

    const output = expectStagedDriverNeutralRecovery(harness.errorSpy, "openclaw");
    expect(output).toContain("Config remains drifted — manual intervention required");
  });

  it("retains the bounded auto-restore owner when manual shields-up fails", () => {
    const harness = createHarness();
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    const snapshotPath = path.join(stateDir, "policy-snapshot-relock-failure.yaml");
    const markerPath = path.join(stateDir, "shields-timer-openclaw.json");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies: {}\n");
    fs.writeFileSync(
      path.join(stateDir, "shields-openclaw.json"),
      JSON.stringify({
        shieldsDown: true,
        shieldsDownAt: new Date().toISOString(),
        shieldsDownTimeout: 1800,
        shieldsDownReason: "rebuild",
        shieldsDownPolicy: "permissive",
        shieldsPolicySnapshotPath: snapshotPath,
      }),
    );
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        pid: 4242,
        sandboxName: "openclaw",
        snapshotPath,
        restoreAt: new Date(Date.now() + 60_000).toISOString(),
        processToken: "timer-token",
        allowLegacyHermesProtocol: false,
      }),
    );
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

    expect(() => harness.shieldsUp("openclaw", { throwOnError: true })).toThrow(
      /Config not locked/,
    );

    expect(fs.existsSync(markerPath)).toBe(true);
    expect(killSpy).not.toHaveBeenCalled();
    expect(
      JSON.parse(fs.readFileSync(path.join(stateDir, "shields-openclaw.json"), "utf-8"))
        .shieldsDown,
    ).toBe(true);
  });

  it("shieldsStatus contains an expired timer whose transition owner exited", async () => {
    const processToken = "7".repeat(32);
    const lifecycleLock = requireDist("../state/mcp-lifecycle-lock.js");
    const sandboxMutationLockPath = lifecycleLock.getMcpLifecycleLockPath("openclaw");
    const containmentPath = `${sandboxMutationLockPath}.containment`;
    const harness = createHarness();
    const {
      stateDir,
      timerMarkerPath,
      transitionLockPath: lockPath,
    } = writeExpiredShieldsFixture(processToken, "coverage", "dead");
    vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
      const failDeadTimerProbe = () => {
        const error = new Error("timer is gone") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      };
      const deadTimerProbe = `${pid}:${signal}` === "4242:0" ? failDeadTimerProbe : undefined;
      deadTimerProbe?.();
      return true;
    });

    await expect(
      lifecycleLock.withSandboxMutationLock("openclaw", () => harness.shieldsStatus("openclaw")),
    ).rejects.toThrow("permanent containment");

    const state = JSON.parse(
      fs.readFileSync(path.join(stateDir, "shields-openclaw.json"), "utf-8"),
    );
    expect(state.shieldsDown).toBe(true);
    expect(fs.existsSync(timerMarkerPath)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.existsSync(containmentPath)).toBe(true);
    expect(fs.existsSync(sandboxMutationLockPath)).toBe(false);
    expect(harness.runSpy).not.toHaveBeenCalledWith(
      ["openshell", "policy", "set"],
      expect.anything(),
    );
  });

  it("retains the timer-bound lifecycle generation when a caller handles a failed containment write", async () => {
    const processToken = "a".repeat(32);
    const lifecycleLock = requireDist("../state/mcp-lifecycle-lock.js");
    const mainLockPath = lifecycleLock.getMcpLifecycleLockPath("openclaw");
    const containmentPath = `${mainLockPath}.containment`;
    const { timerMarkerPath, transitionLockPath } = writeExpiredShieldsFixture(
      processToken,
      "containment write failure coverage",
      "dead",
    );
    vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
      const failDeadTimerProbe = () => {
        const error = new Error("timer is gone") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      };
      const deadTimerProbe = `${pid}:${signal}` === "4242:0" ? failDeadTimerProbe : undefined;
      deadTimerProbe?.();
      return true;
    });
    const harness = createHarness({
      beginContainment: () => {
        throw new Error("state directory is read-only");
      },
    });
    let containmentFailure: unknown;

    const result = await lifecycleLock.withSandboxMutationLock("openclaw", () => {
      try {
        return harness.shieldsStatus("openclaw");
      } catch (error) {
        containmentFailure = error;
        return "handled";
      }
    });

    expect(result).toBe("handled");
    expect(containmentFailure).toMatchObject({
      code: "NEMOCLAW_PERMANENT_CONTAINMENT",
    });
    expect(String(containmentFailure)).toContain("state directory is read-only");
    expect(fs.existsSync(containmentPath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(mainLockPath, "utf8"))).toMatchObject({
      sandboxName: "openclaw",
      shieldsTakeoverToken: processToken,
    });
    expect(fs.existsSync(timerMarkerPath)).toBe(true);
    expect(fs.existsSync(transitionLockPath)).toBe(true);
    expect(harness.runSpy).not.toHaveBeenCalledWith(
      ["openshell", "policy", "set"],
      expect.anything(),
    );
  });

  it.skipIf(currentProcessStartIdentity === null)(
    "bounds live transition takeover before committing durable containment",
    () => {
      const sandboxName = "openclaw";
      const processToken = "8".repeat(32);
      const lifecycleLock = requireDist("../state/mcp-lifecycle-lock.js");
      const containmentPath = `${lifecycleLock.getMcpLifecycleLockPath(sandboxName)}.containment`;
      writeExpiredShieldsFixture(processToken, "takeover exhaustion coverage", "live");
      const waitSpy = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
      const harness = createHarness();

      expect(() => harness.shieldsStatus(sandboxName)).toThrow(
        "Auto-restore transition takeover exhausted 7 attempts",
      );

      expect(waitSpy.mock.calls.map((call) => call[3])).toEqual([
        5_000, 5_000, 5_000, 5_000, 5_000, 5_000,
      ]);
      expect(fs.existsSync(containmentPath)).toBe(true);
      expect(harness.auditSpy).toHaveBeenCalledTimes(1);
      expect(harness.auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "shields_up_failed",
          sandbox: sandboxName,
          error:
            "Shields transition owner is still active; automatic recovery is waiting behind the deadline gate",
        }),
      );
    },
  );

  it.skipIf(currentProcessStartIdentity === null)(
    "returns after bounded containment commit failures without reopening the deadline gate",
    () => {
      const sandboxName = "openclaw";
      const processToken = "9".repeat(32);
      const lifecycleLock = requireDist("../state/mcp-lifecycle-lock.js");
      const mainLockPath = lifecycleLock.getMcpLifecycleLockPath(sandboxName);
      const containmentPath = `${mainLockPath}.containment`;
      writeExpiredShieldsFixture(processToken, "containment write failure coverage", "live");
      const waitSpy = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
      let containmentAttempts = 0;
      const harness = createHarness({
        beginContainment: () => {
          containmentAttempts += 1;
          throw new Error("state directory is read-only");
        },
      });

      expect(() => harness.shieldsStatus(sandboxName)).toThrow(
        /Permanent containment could not be committed after 11 attempts: state directory is read-only.*Correct the state-directory write failure/,
      );

      expect(containmentAttempts).toBe(11);
      expect(waitSpy.mock.calls.filter((call) => call[3] === 5_000)).toHaveLength(6);
      expect(waitSpy.mock.calls.filter((call) => call[3] === 50)).toHaveLength(10);
      expect(fs.existsSync(containmentPath)).toBe(false);
      expect(fs.existsSync(mainLockPath)).toBe(true);
      expect(fs.existsSync(`${mainLockPath}.deadline`)).toBe(true);
      expect(harness.auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "shields_up_failed",
          sandbox: sandboxName,
          error:
            "Permanent containment commit failed; retrying behind the deadline gate: state directory is read-only",
        }),
      );
    },
  );
});
