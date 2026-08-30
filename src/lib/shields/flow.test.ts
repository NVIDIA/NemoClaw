// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import YAML from "yaml";
import {
  createShieldsFlowHarness,
  managedMcpPolicy,
  managedMcpSandbox,
  type ShieldsFlowHarnessOptions,
  writeShieldsTimerAuthorizationProof,
} from "../../../test/helpers/shields-flow-harness";

const requireDist = createRequire(import.meta.url);
const shieldsModulePath = "./index.js";

let tmpDir: string;
const currentProcessStartIdentity = (
  requireDist("./timer-control.js") as typeof import("./timer-control.js")
).readProcessStartIdentity(process.pid);

function createHarness(options: ShieldsFlowHarnessOptions = {}) {
  return createShieldsFlowHarness(requireDist, tmpDir, options);
}

function writeBoundPolicySnapshot(
  snapshotPath: string,
  content = "version: 1\nnetwork_policies:\n  test: {}\n",
) {
  fs.writeFileSync(snapshotPath, content, { mode: 0o600 });
  fs.chmodSync(snapshotPath, 0o600);
  const metadata = fs.statSync(snapshotPath);
  return {
    schemaVersion: 1 as const,
    path: snapshotPath,
    sha256: createHash("sha256").update(content).digest("hex"),
    size: Buffer.byteLength(content),
    mode: 0o600,
    uid: metadata.uid,
    gid: metadata.gid,
    nlink: 1 as const,
  };
}

function writeActivePolicyTransition(
  stateDir: string,
  sandboxName: string,
  processToken: string,
  snapshotPath: string,
  snapshotPolicy: ReturnType<typeof writeBoundPolicySnapshot>,
): void {
  const forwardPolicy = writeBoundPolicySnapshot(
    path.join(stateDir, `policy-forward-${processToken.slice(0, 8)}.yaml`),
  );
  fs.writeFileSync(
    path.join(stateDir, `shields-transition-${sandboxName}-${processToken}.json`),
    JSON.stringify({
      version: 1,
      phase: "active",
      ownerPid: 2_147_483_647,
      ownerStartIdentity: "test-timer-owner",
      processToken,
      sandboxName,
      snapshotPath,
      snapshotPolicy,
      forwardPolicy,
    }),
    { mode: 0o600 },
  );
}

const timerAuthorityFixtures: ReadonlyArray<readonly [string, (markerPath: string) => void]> = [
  ["missing", () => undefined],
  ["malformed", (markerPath) => fs.writeFileSync(markerPath, "{not-json")],
];

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
  const snapshotPolicy = writeBoundPolicySnapshot(snapshotPath);
  fs.writeFileSync(
    path.join(stateDir, `shields-${sandboxName}.json`),
    JSON.stringify({
      shieldsDown: true,
      shieldsDownAt: new Date(Date.now() - 120_000).toISOString(),
      shieldsDownTimeout: 60,
      shieldsDownReason: reason,
      shieldsDownPolicy: "permissive",
      shieldsPolicySnapshotPath: snapshotPath,
      shieldsPolicySnapshot: snapshotPolicy,
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

  it(
    "shieldsDown captures policy, unlocks config, saves state, and authorizes a timer",
    {
      timeout: 30_000,
    },
    () => {
      const harness = createHarness({ confirmOpenClawInodeFlags: true });

      harness.shieldsDown("openclaw", {
        timeout: "5m",
        reason: "coverage",
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
        "Config unlocked for openclaw (auto-lockdown in: 5m)",
      );
    },
  );

  it("restores restrictive policy when policy verification fails (#9833)", () => {
    const harness = createHarness();
    harness.policyVerificationSpy.mockImplementationOnce(() => {
      throw new Error("policy verification failed");
    });

    expect(() =>
      harness.shieldsDown("openclaw", {
        timeout: "5m",
        reason: "policy verification coverage",
        throwOnError: true,
      }),
    ).toThrow("policy verification failed");

    expect(harness.policySetBodies.map((body) => YAML.parse(body).network_policies)).toEqual([
      { test: {} },
      { test: {} },
    ]);
    expect(harness.getOpenClawPosture()).toBe("mutable");
    expect(harness.auditSpy).not.toHaveBeenCalled();
    const stateFiles = fs.readdirSync(path.join(tmpDir, ".nemoclaw", "state"));
    expect(
      stateFiles.filter((name) =>
        /^(shields-openclaw|shields-timer-|shields-transition-openclaw)/u.test(name),
      ),
    ).toEqual([]);
  });

  it("shieldsDown preserves exact live OpenShell policy without shadow ownership state (#7952)", () => {
    const alpha = managedMcpPolicy("alpha");
    const harness = createHarness({
      livePolicyYaml: YAML.stringify({
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
      throwOnError: true,
    });

    const applied = YAML.parse(harness.policySetBodies.at(-1)!);
    expect(applied.network_policies.mcp_bridge_alpha).toEqual(alpha.networkPolicy);
    expect(applied.network_policies.restrictive_baseline).toEqual({
      endpoints: [{ host: "baseline.example.com" }],
    });
  });

  it("isolates same-millisecond policy snapshots and cleanup across sandboxes", () => {
    const fixedNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(fixedNow);
    const harness = createHarness({ confirmOpenClawInodeFlags: true });
    const alphaToken = "a".repeat(32);
    const betaToken = "b".repeat(32);
    const alphaPolicy = "version: 1\nnetwork_policies:\n  alpha: {}\n";
    const betaPolicy = "version: 1\nnetwork_policies:\n  beta: {}\n";
    harness.runCaptureSpy.mockReturnValue(alphaPolicy);

    harness.shieldsDown("alpha", {
      timeout: "5m",
      reason: "same millisecond alpha",
      processToken: alphaToken,
      throwOnError: true,
    });

    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    const alphaState = JSON.parse(
      fs.readFileSync(path.join(stateDir, "shields-alpha.json"), "utf-8"),
    );
    harness.shieldsUp("alpha", { throwOnError: true });
    harness.runCaptureSpy.mockReturnValue("version: 1\nnetwork_policies:\n  alpha_second: {}\n");
    harness.shieldsDown("alpha", {
      timeout: "5m",
      reason: "reused alpha token",
      processToken: alphaToken,
      throwOnError: true,
    });
    const reusedAlphaState = JSON.parse(
      fs.readFileSync(path.join(stateDir, "shields-alpha.json"), "utf-8"),
    );
    expect(reusedAlphaState.shieldsPolicySnapshotPath).not.toBe(
      alphaState.shieldsPolicySnapshotPath,
    );
    expect(fs.existsSync(alphaState.shieldsPolicySnapshotPath)).toBe(true);

    harness.runCaptureSpy.mockReturnValue(betaPolicy);
    expect(() =>
      harness.shieldsDown("beta", {
        timeout: "5m",
        reason: "same millisecond beta",
        policy: "missing-beta-policy",
        processToken: betaToken,
        throwOnError: true,
      }),
    ).toThrow(/unknown policy/iu);

    expect(alphaState.shieldsPolicySnapshotPath).not.toBe(
      reusedAlphaState.shieldsPolicySnapshotPath,
    );
    expect(fs.readFileSync(alphaState.shieldsPolicySnapshotPath, "utf-8")).toBe(alphaPolicy);
    expect(
      fs
        .readdirSync(stateDir)
        .some((entry) => entry.startsWith(`policy-snapshot-beta-${betaToken}-`)),
    ).toBe(false);
  });

  it("cleans the staged managed MCP policy when timer startup fails", () => {
    const alpha = managedMcpPolicy("alpha");
    const harness = createHarness({
      fork: () => {
        throw new Error("timer startup failed");
      },
      livePolicyYaml: YAML.stringify({
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
      livePolicyYaml: YAML.stringify({
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
    ).toThrow(/EISDIR|directory/i);

    expect(harness.cleanupTempDirSpy).toHaveBeenCalledWith(
      expect.stringContaining("nemoclaw-permissive-runtime"),
      "nemoclaw-permissive-runtime",
    );
    expect(harness.cleanupTempDirSpy).toHaveBeenCalledTimes(1);
    const stagedPolicyPath = String(harness.cleanupTempDirSpy.mock.calls.at(-1)?.[0]);
    expect(fs.existsSync(path.dirname(stagedPolicyPath))).toBe(false);
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
      /does not match the saved policy snapshot/,
    );
    expect(harness.policySetBodies).toHaveLength(0);
  });

  it("refuses recovery without a forward-policy artifact and preserves later host edits", () => {
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    const processToken = "8".repeat(32);
    const snapshotPath = path.join(stateDir, "policy-snapshot-new-cycle.yaml");
    const oldSnapshotPath = path.join(stateDir, "policy-snapshot-old-cycle.yaml");
    const alpha = managedMcpPolicy("alpha", "8.8.8.8");
    fs.mkdirSync(stateDir, { recursive: true });
    const snapshotPolicy = writeBoundPolicySnapshot(
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
        snapshotPolicy,
      }),
    );
    const harness = createHarness({
      livePolicyYaml: YAML.stringify({
        version: 1,
        network_policies: {
          mcp_bridge_alpha: alpha.networkPolicy,
          later_host_edit: { endpoints: [{ host: "host.example.test", port: 443 }] },
        },
      }),
      sandboxEntry: managedMcpSandbox([alpha]),
    });

    expect(() =>
      harness.applyShieldsPolicySnapshot("openclaw", snapshotPath, {
        transitionProcessToken: processToken,
      }),
    ).toThrow(/no bound forward-policy artifact/);
    expect(harness.policySetBodies).toHaveLength(0);
    expect(
      fs.existsSync(path.join(stateDir, `shields-transition-openclaw-${processToken}.json`)),
    ).toBe(true);
  });

  it("binds manual shields-up to the active auto-restore timer generation", () => {
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    const sandboxName = "openclaw";
    const processToken = "9".repeat(32);
    const snapshotPath = path.join(stateDir, "policy-snapshot-manual-up.yaml");
    const forwardPath = path.join(stateDir, "policy-forward-manual-up.yaml");
    const lockPath = path.join(stateDir, `shields-transition-lock-${sandboxName}.json`);
    fs.mkdirSync(stateDir, { recursive: true });
    const snapshotPolicy = writeBoundPolicySnapshot(snapshotPath);
    const forwardPolicy = writeBoundPolicySnapshot(forwardPath);
    const timerControl = requireDist("./timer-control.js") as typeof import("./timer-control.js");
    vi.spyOn(timerControl, "isProcessAlive").mockReturnValue(true);
    vi.spyOn(timerControl, "readProcessStartIdentity").mockReturnValue("live-timer-start");
    vi.spyOn(timerControl, "verifyTimerMarkerIdentity").mockReturnValue({ verified: true });
    vi.spyOn(timerControl, "killTimer").mockReturnValue({
      authorityRevoked: true,
      markerFound: true,
      markerPid: 999_999,
      wasAlive: true,
      terminated: true,
      warnings: [],
    });
    fs.writeFileSync(
      path.join(stateDir, `shields-${sandboxName}.json`),
      JSON.stringify({
        shieldsDown: true,
        shieldsDownAt: new Date().toISOString(),
        shieldsDownTimeout: 300,
        shieldsDownReason: "manual-up-token-test",
        shieldsDownPolicy: "permissive",
        shieldsPolicySnapshotPath: snapshotPath,
        shieldsPolicySnapshot: snapshotPolicy,
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
        timerProcessStartIdentity: "live-timer-start",
      }),
    );
    writeShieldsTimerAuthorizationProof(requireDist, sandboxName);
    fs.writeFileSync(
      path.join(stateDir, `shields-transition-${sandboxName}-${processToken}.json`),
      JSON.stringify({
        version: 1,
        phase: "active",
        ownerPid: process.pid,
        ownerStartIdentity: currentProcessStartIdentity,
        processToken,
        sandboxName,
        snapshotPath,
        snapshotPolicy,
        forwardPolicy,
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

  it.skipIf(currentProcessStartIdentity === null)(
    "lets the lifecycle owner raise Shields after a live timer's completion grace (#7952)",
    { timeout: 15_000 },
    () => {
      const sandboxName = "openclaw";
      const processToken = "7".repeat(32);
      const lifecycleLock = requireDist("../state/mcp-lifecycle-lock.js");
      const timerControl = requireDist("./timer-control.js");
      const { stateDir, timerMarkerPath, transitionLockPath } = writeExpiredShieldsFixture(
        processToken,
        "long lifecycle operation",
        "dead",
      );
      fs.rmSync(transitionLockPath);
      const marker = JSON.parse(fs.readFileSync(timerMarkerPath, "utf-8"));
      marker.restoreAt = new Date(Date.now() + 60_000).toISOString();
      fs.writeFileSync(timerMarkerPath, JSON.stringify(marker));
      const transitionPath = path.join(
        stateDir,
        `shields-transition-${sandboxName}-${processToken}.json`,
      );
      const snapshotPolicy = JSON.parse(
        fs.readFileSync(path.join(stateDir, `shields-${sandboxName}.json`), "utf8"),
      ).shieldsPolicySnapshot;
      const forwardPolicy = writeBoundPolicySnapshot(
        path.join(stateDir, "policy-forward-lifecycle-owner.yaml"),
      );
      fs.writeFileSync(
        transitionPath,
        JSON.stringify({
          version: 1,
          phase: "active",
          ownerPid: process.pid,
          ownerStartIdentity: currentProcessStartIdentity,
          processToken,
          sandboxName,
          snapshotPath: marker.snapshotPath,
          snapshotPolicy,
          forwardPolicy,
        }),
      );
      vi.spyOn(timerControl, "isProcessAlive").mockReturnValue(true);
      vi.spyOn(timerControl, "verifyTimerMarkerIdentity").mockReturnValue({ verified: true });
      const waitSpy = vi.spyOn(Atomics, "wait");
      const harness = createHarness({
        dockerExecFileSync: (argv: unknown) => {
          const args = Array.isArray(argv) ? argv.map(String) : [];
          switch (true) {
            case args.includes("sha256sum"):
              return `${"a".repeat(64)}  ${String(args.at(-1))}\n`;
            case args.includes("lsattr"):
              return `----i---------e----- ${String(args.at(-1))}\n`;
            case !args.includes("stat"):
              return "";
            case args.at(-1) === "/sandbox":
              return "1775 root:sandbox\n";
            case args.at(-1) === "/sandbox/.openclaw":
              return "755 root:root\n";
            default:
              return "444 root:root\n";
          }
        },
      });
      const containmentPath = `${lifecycleLock.getMcpLifecycleLockPath(sandboxName, stateDir)}.containment`;

      lifecycleLock.withMcpLifecycleLockSync(
        sandboxName,
        () => {
          marker.restoreAt = new Date(Date.now() - 60_000).toISOString();
          fs.writeFileSync(timerMarkerPath, JSON.stringify(marker));
          expect(lifecycleLock.isMcpLifecycleLockHeld(sandboxName, stateDir)).toBe(true);
          harness.shieldsUp(sandboxName, { throwOnError: true });
        },
        { stateDir },
      );

      expect(
        JSON.parse(fs.readFileSync(path.join(stateDir, `shields-${sandboxName}.json`), "utf-8"))
          .shieldsDown,
      ).toBe(false);
      expect(fs.existsSync(timerMarkerPath)).toBe(false);
      expect(fs.existsSync(transitionPath)).toBe(false);
      expect(fs.existsSync(containmentPath)).toBe(false);
      expect(waitSpy.mock.calls.filter((call) => call[3] === 5_000)).toHaveLength(0);
      expect(harness.auditSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "shields_up_failed" }),
      );
    },
  );

  it("auto-restore waits for the forward shields-down commit before reclaiming policy", () => {
    const harness = createHarness();
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });

    const sandboxName = "openclaw";
    const processToken = "a".repeat(32);
    const snapshotPath = path.join(stateDir, "policy-snapshot-race.yaml");
    const forwardPath = path.join(stateDir, "policy-forward-race.yaml");
    const transitionPath = path.join(
      stateDir,
      `shields-transition-${sandboxName}-${processToken}.json`,
    );
    const snapshotPolicy = writeBoundPolicySnapshot(snapshotPath);
    const forwardPolicy = writeBoundPolicySnapshot(forwardPath);
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
        snapshotPolicy,
        forwardPolicy,
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
      ["openshell", "policy", "set", "-g", "nemoclaw"],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("preserves a live transition owner instead of attempting portable process-tree takeover", () => {
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const sandboxName = "live-owner";
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
  ])(
    "enters durable containment for a %s-token transition whose owner exited in the recovery gap",
    (_tokenRelationship, transitionOwnerToken) => {
      const stateDir = path.join(tmpDir, ".nemoclaw", "state");
      fs.mkdirSync(stateDir, { recursive: true });
      const sandboxName = "dead-owner";
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
      ).toThrow("durable containment");
      expect(fs.existsSync(transitionLockPath)).toBe(true);
      expect(fs.existsSync(containmentPath)).toBe(true);
    },
  );

  it(
    "waits for a token-bound destroy owner without signaling it, then restores lockdown",
    {
      timeout: 10_000,
    },
    async () => {
      const transitionLockPath = path.join(import.meta.dirname, "transition-lock.ts");
      const stateDir = path.join(tmpDir, ".nemoclaw", "state");
      const sandboxName = "destroy-deadline";
      const processToken = "e".repeat(32);
      const snapshotPath = path.join(stateDir, "policy-snapshot-destroy.yaml");
      const readyPath = path.join(stateDir, "destroy-owner.ready");
      const releasePath = path.join(stateDir, "destroy-owner.release");
      const lockPath = path.join(stateDir, `shields-transition-lock-${sandboxName}.json`);
      const markerPath = path.join(stateDir, `shields-timer-${sandboxName}.json`);
      const statePath = path.join(stateDir, `shields-${sandboxName}.json`);
      fs.mkdirSync(stateDir, { recursive: true });
      const snapshotPolicy = writeBoundPolicySnapshot(snapshotPath);
      writeActivePolicyTransition(
        stateDir,
        sandboxName,
        processToken,
        snapshotPath,
        snapshotPolicy,
      );
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          shieldsDown: true,
          shieldsDownAt: new Date(Date.now() - 60_000).toISOString(),
          shieldsDownTimeout: 60,
          shieldsDownReason: "destroy takeover coverage",
          shieldsDownPolicy: "permissive",
          shieldsPolicySnapshotPath: snapshotPath,
          shieldsPolicySnapshot: snapshotPolicy,
          updatedAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        markerPath,
        JSON.stringify({
          pid: 999_999,
          sandboxName,
          snapshotPath,
          restoreAt: new Date(Date.now() - 1_000).toISOString(),
          processToken,
        }),
        { mode: 0o600 },
      );

      const owner = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "-e",
          [
            `const {withShieldsTransitionLock}=require(${JSON.stringify(transitionLockPath)})`,
            "const fs=require('fs')",
            "const [name,token,ready,release]=process.argv.slice(1)",
            "const waitBuffer=new Int32Array(new SharedArrayBuffer(4))",
            "withShieldsTransitionLock(name,'destroy sandbox',()=>{fs.writeFileSync(ready,'ready');const deadline=Date.now()+5000;while(!fs.existsSync(release)){if(Date.now()>=deadline)throw new Error('release handshake timed out');Atomics.wait(waitBuffer,0,0,10)}},{takeoverToken:token})",
          ].join(";"),
          sandboxName,
          processToken,
          readyPath,
          releasePath,
        ],
        { env: { ...process.env, HOME: tmpDir }, stdio: "ignore" },
      );

      try {
        await vi.waitFor(
          () => {
            expect(fs.existsSync(readyPath)).toBe(true);
            expect(fs.existsSync(lockPath)).toBe(true);
          },
          { timeout: 5_000, interval: 10 },
        );
        const timerControl = requireDist("./timer-control.js");
        const ownerStartIdentity = timerControl.readProcessStartIdentity(owner.pid);
        expect(ownerStartIdentity).toBeTypeOf("string");
        const processKillSpy = vi.spyOn(process, "kill");
        const nativeAtomicsWait = Atomics.wait;
        const atomicsWaitSpy = vi
          .spyOn(Atomics, "wait")
          .mockImplementationOnce(() => {
            const ownerState = timerControl.readProcessState(owner.pid);
            expect(ownerState).not.toBeNull();
            expect(ownerState?.startsWith("Z")).toBe(false);
            expect(fs.existsSync(lockPath)).toBe(true);
            expect(processKillSpy).not.toHaveBeenCalledWith(owner.pid, "SIGSTOP");
            expect(processKillSpy).not.toHaveBeenCalledWith(owner.pid, "SIGKILL");
            fs.writeFileSync(releasePath, "release");
            const releaseDeadline = Date.now() + 5_000;
            const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
            while (fs.existsSync(lockPath) && Date.now() < releaseDeadline) {
              nativeAtomicsWait(waitBuffer, 0, 0, 10);
            }
            expect(fs.existsSync(lockPath)).toBe(false);
            return "timed-out";
          })
          .mockReturnValue("timed-out");
        const harness = createHarness({
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

        harness.shieldsStatus(sandboxName);

        expect(atomicsWaitSpy).toHaveBeenCalled();
        expect(processKillSpy).not.toHaveBeenCalledWith(owner.pid, "SIGSTOP");
        expect(processKillSpy).not.toHaveBeenCalledWith(owner.pid, "SIGKILL");
        await vi.waitFor(
          () => {
            const ownerState = timerControl.readProcessState(owner.pid);
            expect(ownerState === null || ownerState.startsWith("Z")).toBe(true);
          },
          { timeout: 2_000, interval: 10 },
        );
        expect(fs.existsSync(lockPath)).toBe(false);
        expect(JSON.parse(fs.readFileSync(statePath, "utf-8"))).toMatchObject({
          shieldsDown: false,
          shieldsDownAt: null,
        });
        expect(fs.existsSync(markerPath)).toBe(false);
        expect(harness.runSpy).toHaveBeenCalledWith(
          ["openshell", "policy", "set", "-g", "nemoclaw"],
          expect.objectContaining({ ignoreError: true }),
        );
        expect(harness.logSpy).toHaveBeenCalledWith("  Shields: UP (lockdown active)");
      } finally {
        owner.kill("SIGKILL");
      }
    },
  );

  it("publishes preparing recovery ownership before weakening and active only after unlock", () => {
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    let observedPreparingDuringPolicy = false;
    let observedPreparingDuringUnlock = false;
    let authorizationSawMarker = false;
    let timerArgs: string[] = [];
    const readOnlyTransition = () => {
      const transitionName = fs
        .readdirSync(stateDir)
        .find((name) => name.startsWith("shields-transition-openclaw-"));
      expect(transitionName).toBeDefined();
      return JSON.parse(fs.readFileSync(path.join(stateDir, transitionName!), "utf-8"));
    };
    const harness = createHarness({
      fork: (_modulePath, args) => {
        timerArgs = args as string[];
        return {
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
        };
      },
      run: () => {
        observedPreparingDuringPolicy = readOnlyTransition().phase === "preparing";
        return { status: 0 };
      },
      dockerExecFileSync: (argv: unknown) => {
        const args = Array.isArray(argv) ? argv.map(String) : [];
        switch (true) {
          case args.some((arg) => arg.includes("nemoclaw-shields-down-path-preflight")):
            return "";
          default:
            break;
        }
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
    expect(timerArgs.at(9)).toBe("openclaw");
    expect(transition).toMatchObject({
      version: 1,
      phase: "active",
      ownerPid: process.pid,
      sandboxName: "openclaw",
      snapshotPath: expect.stringContaining("policy-snapshot-"),
    });
    expect(fs.existsSync(path.join(stateDir, "shields-timer-openclaw.json"))).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(stateDir, "shields-timer-openclaw.json"), "utf-8")),
    ).toMatchObject({
      agentName: "openclaw",
      configPath: "/sandbox/.openclaw/openclaw.json",
      configDir: "/sandbox/.openclaw",
    });
  });

  it("releases a stale timer token before publishing a fresh DOWN generation", () => {
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    const sandboxName = "openclaw";
    const staleToken = "8".repeat(32);
    const freshToken = "7".repeat(32);
    const snapshotPath = path.join(stateDir, "stale-policy-snapshot.yaml");
    const lockPath = path.join(stateDir, `shields-transition-lock-${sandboxName}.json`);
    fs.mkdirSync(stateDir, { recursive: true });
    writeBoundPolicySnapshot(snapshotPath);
    fs.writeFileSync(
      path.join(stateDir, `shields-${sandboxName}.json`),
      JSON.stringify({ shieldsDown: false, updatedAt: new Date().toISOString() }),
    );
    fs.writeFileSync(
      path.join(stateDir, `shields-timer-${sandboxName}.json`),
      JSON.stringify({
        pid: 4242,
        sandboxName,
        snapshotPath,
        restoreAt: new Date(Date.now() + 60_000).toISOString(),
        processToken: staleToken,
      }),
    );
    let ownerDuringFork: Record<string, unknown> | null = null;
    const harness = createHarness({
      initialOpenClawPosture: "locked",
      fork: () => {
        ownerDuringFork = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
        return {
          pid: 4343,
          disconnect: vi.fn(),
          unref: vi.fn(),
          send: vi.fn(() => true),
          kill: vi.fn(() => true),
        };
      },
    });

    harness.shieldsDown(sandboxName, {
      timeout: "5m",
      reason: "stale generation handoff coverage",
      processToken: freshToken,
      throwOnError: true,
    });

    expect(ownerDuringFork).toMatchObject({ takeoverToken: freshToken });
    expect(ownerDuringFork).not.toMatchObject({ takeoverToken: staleToken });
    expect(
      JSON.parse(
        fs.readFileSync(path.join(stateDir, `shields-timer-${sandboxName}.json`), "utf-8"),
      ),
    ).toMatchObject({ processToken: freshToken });
  });

  it("fails before policy mutation when the fresh timer dies before authorization proof", () => {
    const harness = createHarness({
      timerAuthorizationOutcome: "dies-before-proof",
      fork: () => ({
        pid: 4545,
        disconnect: vi.fn(),
        unref: vi.fn(),
        send: vi.fn(() => true),
        kill: vi.fn(() => true),
      }),
    });

    expect(() =>
      harness.shieldsDown("openclaw", {
        timeout: "5m",
        reason: "timer authorization failure",
        throwOnError: true,
      }),
    ).toThrow(/authorization proof/u);

    expect(harness.runSpy).not.toHaveBeenCalled();
    expect(harness.auditSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "shields_down" }),
    );
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    expect(fs.existsSync(path.join(stateDir, "shields-openclaw.json"))).toBe(false);
    expect(
      fs.readdirSync(stateDir).some((entry) => entry.startsWith("shields-transition-openclaw-")),
    ).toBe(false);
    expect(
      fs
        .readdirSync(stateDir)
        .some((entry) => entry.startsWith("shields-timer-authorization-openclaw-")),
    ).toBe(false);
  });

  it("rolls back when the authorized fresh timer dies before active commit", () => {
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "shields-openclaw.json"),
      JSON.stringify({ shieldsDown: false, updatedAt: new Date().toISOString() }),
    );
    const harness = createHarness({
      confirmOpenClawInodeFlags: true,
      initialOpenClawPosture: "locked",
      timerDiesAfterUnlock: true,
      fork: () => ({
        pid: 4646,
        disconnect: vi.fn(),
        unref: vi.fn(),
        send: vi.fn(() => true),
        kill: vi.fn(() => true),
      }),
    });

    expect(() =>
      harness.shieldsDown("openclaw", {
        timeout: "5m",
        reason: "timer died before active",
        throwOnError: true,
      }),
    ).toThrow(/live future auto-restore timer authority/u);

    expect(harness.getOpenClawPosture()).toBe("locked");
    expect(
      JSON.parse(
        fs.readFileSync(path.join(tmpDir, ".nemoclaw", "state", "shields-openclaw.json"), "utf-8"),
      ),
    ).toMatchObject({ shieldsDown: false });
    expect(harness.auditSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "shields_down" }),
    );
  });

  it("restores lockdown instead of trusting a dead future timer marker", () => {
    const harness = createHarness({ confirmOpenClawInodeFlags: true });
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    const snapshotPath = path.join(stateDir, "policy-snapshot-dead-future-timer.yaml");
    const markerPath = path.join(stateDir, "shields-timer-openclaw.json");
    const processToken = "6".repeat(32);
    fs.mkdirSync(stateDir, { recursive: true });
    const snapshotPolicy = writeBoundPolicySnapshot(snapshotPath);
    writeActivePolicyTransition(stateDir, "openclaw", processToken, snapshotPath, snapshotPolicy);
    fs.writeFileSync(
      path.join(stateDir, "shields-openclaw.json"),
      JSON.stringify({
        shieldsDown: true,
        shieldsDownAt: new Date().toISOString(),
        shieldsDownTimeout: 300,
        shieldsDownReason: "dead future timer",
        shieldsDownPolicy: "permissive",
        shieldsPolicySnapshotPath: snapshotPath,
        shieldsPolicySnapshot: snapshotPolicy,
      }),
    );
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        pid: 2_147_483_647,
        sandboxName: "openclaw",
        snapshotPath,
        restoreAt: new Date(Date.now() + 60_000).toISOString(),
        processToken,
        timerProcessStartIdentity: "dead-timer-start",
        agentName: "openclaw",
        configPath: "/sandbox/.openclaw/openclaw.json",
        configDir: "/sandbox/.openclaw",
      }),
    );

    harness.shieldsStatus("openclaw");

    expect(
      JSON.parse(fs.readFileSync(path.join(stateDir, "shields-openclaw.json"), "utf-8")),
    ).toMatchObject({ shieldsDown: false, shieldsDownAt: null });
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(harness.runSpy).toHaveBeenCalledWith(
      ["openshell", "policy", "set", "-g", "nemoclaw"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(harness.logSpy).toHaveBeenCalledWith("  Shields: UP (lockdown active)");
  });

  it.each(timerAuthorityFixtures)(
    "keeps lockdown recovery pending when DOWN timer authority is %s and no forward policy is bound",
    (markerState, writeMarker) => {
      const harness = createHarness({ confirmOpenClawInodeFlags: true });
      const stateDir = path.join(tmpDir, ".nemoclaw", "state");
      const snapshotPath = path.join(stateDir, `policy-snapshot-${markerState}-timer.yaml`);
      const markerPath = path.join(stateDir, "shields-timer-openclaw.json");
      fs.mkdirSync(stateDir, { recursive: true });
      const snapshotPolicy = writeBoundPolicySnapshot(snapshotPath);
      fs.writeFileSync(
        path.join(stateDir, "shields-openclaw.json"),
        JSON.stringify({
          shieldsDown: true,
          shieldsDownAt: new Date().toISOString(),
          shieldsDownTimeout: 300,
          shieldsDownReason: `${markerState} timer marker`,
          shieldsDownPolicy: "permissive",
          shieldsPolicySnapshotPath: snapshotPath,
          shieldsPolicySnapshot: snapshotPolicy,
        }),
      );
      writeMarker(markerPath);

      harness.shieldsStatus("openclaw");

      expect(
        JSON.parse(fs.readFileSync(path.join(stateDir, "shields-openclaw.json"), "utf-8")),
      ).toMatchObject({ shieldsDown: true });
      expect(fs.existsSync(markerPath)).toBe(markerState === "malformed");
      expect(harness.runSpy).not.toHaveBeenCalledWith(
        ["openshell", "policy", "set", "-g", "nemoclaw"],
        expect.anything(),
      );
    },
  );

  it("restores lockdown when a future marker PID has the wrong timer command identity", () => {
    const harness = createHarness({ confirmOpenClawInodeFlags: true });
    const timerControl = requireDist("./timer-control.js") as typeof import("./timer-control.js");
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    const snapshotPath = path.join(stateDir, "policy-snapshot-wrong-timer-command.yaml");
    const markerPath = path.join(stateDir, "shields-timer-openclaw.json");
    const processToken = "5".repeat(32);
    const startIdentity = timerControl.readProcessStartIdentity(process.pid);
    expect(startIdentity).toBeTypeOf("string");
    fs.mkdirSync(stateDir, { recursive: true });
    const snapshotPolicy = writeBoundPolicySnapshot(snapshotPath);
    writeActivePolicyTransition(stateDir, "openclaw", processToken, snapshotPath, snapshotPolicy);
    fs.writeFileSync(
      path.join(stateDir, "shields-openclaw.json"),
      JSON.stringify({
        shieldsDown: true,
        shieldsDownAt: new Date().toISOString(),
        shieldsDownTimeout: 300,
        shieldsDownReason: "wrong timer command",
        shieldsDownPolicy: "permissive",
        shieldsPolicySnapshotPath: snapshotPath,
        shieldsPolicySnapshot: snapshotPolicy,
      }),
    );
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        pid: process.pid,
        sandboxName: "openclaw",
        snapshotPath,
        restoreAt: new Date(Date.now() + 60_000).toISOString(),
        processToken,
        timerProcessStartIdentity: startIdentity,
        agentName: "openclaw",
        configPath: "/sandbox/.openclaw/openclaw.json",
        configDir: "/sandbox/.openclaw",
      }),
    );
    const killSpy = vi.spyOn(process, "kill");

    harness.shieldsStatus("openclaw");

    expect(
      JSON.parse(fs.readFileSync(path.join(stateDir, "shields-openclaw.json"), "utf-8")),
    ).toMatchObject({ shieldsDown: false, shieldsDownAt: null });
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(killSpy).not.toHaveBeenCalledWith(process.pid, "SIGTERM");
    expect(killSpy).not.toHaveBeenCalledWith(process.pid, "SIGKILL");
  });

  it("shieldsStatus contains an expired timer whose transition owner exited", () => {
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

    expect(() => harness.shieldsStatus("openclaw")).toThrow("durable containment");

    const state = JSON.parse(
      fs.readFileSync(path.join(stateDir, "shields-openclaw.json"), "utf-8"),
    );
    expect(state.shieldsDown).toBe(true);
    expect(fs.existsSync(timerMarkerPath)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.existsSync(containmentPath)).toBe(true);
    expect(fs.existsSync(sandboxMutationLockPath)).toBe(false);
    expect(harness.runSpy).not.toHaveBeenCalledWith(
      ["openshell", "policy", "set", "-g", "nemoclaw"],
      expect.anything(),
    );
  });

  it("retains the timer-bound lifecycle generation when a caller handles a failed containment write", () => {
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

    let result: string | undefined;
    try {
      harness.shieldsStatus("openclaw");
    } catch (error) {
      containmentFailure = error;
      result = "handled";
    }

    expect(result).toBe("handled");
    expect(containmentFailure).toMatchObject({
      code: "NEMOCLAW_DURABLE_CONTAINMENT",
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
      ["openshell", "policy", "set", "-g", "nemoclaw"],
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
        /Durable containment could not be committed after 11 attempts: state directory is read-only.*Correct the state-directory write failure/,
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
            "Durable containment commit failed; retrying behind the deadline gate: state directory is read-only",
        }),
      );
    },
  );
});
