// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadAgent } from "../../agent/defs";
import DebugCliCommand from "../../../commands/debug";
import type { SandboxEntry } from "../../state/registry";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
import { withPortableHostFence } from "../../state/portable-uninstall-retirement";
import type { ContainerEngineCommandCapture } from "../../adapters/container-engine";
import { hermesPortableContainerInternals } from "./hermes-portable-container";
import {
  createHermesPortableLifecycleTestReceipt,
  createHermesPortableLifecycleTestDeps,
  SANDBOX,
  GATEWAY,
  GENERATION,
  CONTAINER_ID,
  IMAGE,
  SANDBOX_ID,
  POLICY,
  sandboxListJson,
  LABELS,
  testPodmanExecutableAuthorityDeps,
} from "./hermes-portable-lifecycle.test-fixture";
import {
  openshellMutationCalls,
  rebindAfterSandboxStart,
  driftRegistryAfterStartup,
  poisonUnexpectedCommand,
} from "./hermes-portable-lifecycle.test-fixtures";
import {
  hermesPortableLifecycleInternals,
  prepareHermesPortableSandboxRemoval,
  recoverHermesPortableSandboxLifecycle,
  requalifyHermesPortableSandboxAuthority,
  stopHermesPortableSandboxLifecycle,
  type HermesPortableLifecycleDeps,
} from "./hermes-portable-lifecycle";
import {
  publishHermesPortableSuccessorReceipt,
  readHermesPortableLifecycleReceipt,
  readHermesPortableLifecycleReceiptForRequalification,
  type HermesPortableConfiguredReceipt,
} from "./hermes-portable-receipt";

let stateDir: string;
let policyPath: string;
function activeReceipt(homeDir = "/home/test"): HermesPortableConfiguredReceipt {
  return createHermesPortableLifecycleTestReceipt({
    agent: loadAgent("hermes"),
    stateDir,
    policyPath,
    homeDir,
    sandboxName: SANDBOX,
    gatewayName: GATEWAY,
    lifecycleGeneration: GENERATION,
    containerId: CONTAINER_ID,
    imageDigest: IMAGE,
    sandboxId: SANDBOX_ID,
    labels: LABELS,
  });
}
function lifecycleDeps(
  receipt: HermesPortableConfiguredReceipt,
  initiallyRunning = true,
  options: Parameters<typeof createHermesPortableLifecycleTestDeps>[3] = {},
) {
  return createHermesPortableLifecycleTestDeps(stateDir, receipt, initiallyRunning, options);
}
async function publishSuccessor(): Promise<void> {
  await withMcpLifecycleLock(
    SANDBOX,
    () => publishHermesPortableSuccessorReceipt(SANDBOX, stateDir),
    { stateDir: path.join(stateDir, "state") },
  );
}
function lifecycleContext() {
  return {
    agent: "hermes",
    gatewayName: GATEWAY,
    lifecycleGeneration: GENERATION,
    openshellDriver: "docker",
    provider: "ollama",
  };
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-lifecycle-"));
  policyPath = path.join(stateDir, "policy.yaml");
  fs.writeFileSync(policyPath, POLICY, { mode: 0o600 });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function recoverWithLifecycleLock(deps: HermesPortableLifecycleDeps) {
  return withMcpLifecycleLock(
    SANDBOX,
    () => recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), deps),
    { stateDir: path.join(stateDir, "state") },
  );
}

describe("Hermes portable lifecycle", () => {
  it.each([
    { outcome: "resolve", settle: () => undefined },
    {
      outcome: "reject",
      settle: () => {
        throw new Error("policy capture failed");
      },
    },
  ])(
    "holds the lifecycle lock and defers startup until policy observation settles ($outcome)",
    async ({ outcome, settle }) => {
      const receipt = activeReceipt();
      await publishSuccessor();
      const fixture = lifecycleDeps(receipt, false);
      let now = 0;
      const timing = vi.fn();
      let release!: () => void;
      let entered!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const observing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const capturePolicy = vi.fn(async () => {
        entered();
        await pending;
        settle();
        return { status: 0, stdout: Buffer.from(POLICY), stderr: Buffer.alloc(0) };
      });
      const operation = withMcpLifecycleLock(
        SANDBOX,
        () =>
          recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), {
            ...fixture.deps,
            capturePolicy,
            recoveryTiming: { now: () => now, onComplete: timing },
          }),
        { stateDir: path.join(stateDir, "state") },
      );
      const result =
        outcome === "reject"
          ? expect(operation).rejects.toThrow("policy capture failed")
          : expect(operation).resolves.toEqual({ kind: "recovered" });
      await observing;
      let competitorEntered = false;
      const competitor = withMcpLifecycleLock(
        SANDBOX,
        async () => {
          competitorEntered = true;
        },
        { stateDir: path.join(stateDir, "state"), pollIntervalMs: 1 },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(competitorEntered).toBe(false);
      expect(fixture.launchOpenShell).not.toHaveBeenCalled();
      expect(fixture.podman.mock.calls.some(([args]) => args[0] === "start")).toBe(false);
      now = 250;
      release();
      await result;
      await competitor;
      expect(competitorEntered).toBe(true);
      expect(timing).toHaveBeenCalledWith(expect.objectContaining({ entryQualificationMs: 250 }));
      expect(fixture.launchOpenShell).toHaveBeenCalledTimes(outcome === "resolve" ? 1 : 0);
    },
  );

  it("collects an offline public debug bundle for an actual receipt without exposing authority (#11651)", async () => {
    const home = stateDir;
    stateDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    vi.stubEnv("HOME", home);
    const output = path.join(home, "debug.tar.gz");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const receipt = activeReceipt(home);
      await DebugCliCommand.run(["--sandbox", SANDBOX, "--output", output], process.cwd());
      const entries = execFileSync("tar", ["tzf", output], { encoding: "utf8" }).trim().split("\n");
      expect(entries).toHaveLength(2);
      const report = execFileSync("tar", ["xOzf", output, entries[1]!], { encoding: "utf8" });
      expect(JSON.parse(report)).toMatchObject({
        sandboxName: SANDBOX,
        savedLifecyclePhase: "active",
        runtimeHealth: "not-probed",
        agentHealth: "not-probed",
      });
      expect(report).not.toContain(receipt.transactionId);
      expect(report).not.toContain(receipt.container.containerId);
      expect(report).not.toContain(home);
      expect(log.mock.calls.flat().join("\n")).toContain("Offline Portable lifecycle diagnostics");
    } finally {
      vi.unstubAllEnvs();
      stateDir = home;
    }
  });

  it("preserves sanitized command diagnostics and reports an attempted start (#11651)", async () => {
    const receipt = activeReceipt();
    const fixture = lifecycleDeps(receipt, false);
    const capture = fixture.captureOpenShell.getMockImplementation()!;
    fixture.captureOpenShell.mockImplementation((args) =>
      args[1] === "start"
        ? {
            status: 23,
            stdout: "startup stdout canary",
            stderr: "startup stderr canary\nNVIDIA_INFERENCE_API_KEY=nvapi-TEST-DIAGNOSTIC-SECRET",
          }
        : capture(args),
    );
    const evidence = vi.fn();
    const recover = vi.fn(() =>
      withMcpLifecycleLock(
        SANDBOX,
        () =>
          recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), {
            ...fixture.deps,
            recoveryTiming: { onComplete: evidence },
          }),
        { stateDir: path.join(stateDir, "state") },
      ),
    );
    const recovery = recover();
    await expect(recovery).rejects.toThrow("startup stderr canary");
    const error = await recovery.catch((cause: Error) => cause);
    expect((error as Error).message).toContain("status 23");
    expect((error as Error).message).toContain("startup stdout canary");
    expect((error as Error).message).not.toContain("nvapi-TEST-DIAGNOSTIC-SECRET");
    expect(evidence).toHaveBeenCalledWith(
      expect.objectContaining({
        containerStartCount: 1,
        containerAction: "start-attempted",
        result: "failed",
      }),
    );
  });

  it("rejects late exec readiness and rolls back (#11652)", async () => {
    const fixture = lifecycleDeps(activeReceipt(), false);
    const capture = fixture.captureOpenShell.getMockImplementation()!;
    let elapsed = 0;
    fixture.captureOpenShell.mockImplementation((args) => {
      elapsed += args.at(-1) === "true" ? 90_001 : 0;
      return capture(args);
    });
    await expect(recoverWithLifecycleLock({ ...fixture.deps, now: () => elapsed })).rejects.toThrow(
      "did not reconnect to the selected OpenShell gateway",
    );
    expect(openshellMutationCalls(fixture.captureOpenShell, "stop")).toHaveLength(1);
  });

  it.each([
    [20, "authenticated-health", 80, [20], 1],
    [100, "entry-qualification", undefined, [], 0],
  ] as const)(
    "bounds later phases after %s ms qualification (#11652)",
    async (qualificationMs, phase, startAllowance, expectedHealth, stops) => {
      const fixture = lifecycleDeps(activeReceipt(), false);
      const capture = fixture.captureOpenShell.getMockImplementation()!;
      let elapsed = 0;
      const healthAllowances: number[] = [];
      const command = vi.fn((args: readonly string[], allowance: number) => {
        elapsed += args[1] === "get" && elapsed === 0 ? qualificationMs : 0;
        elapsed += args[1] === "start" ? 60 : 0;
        const healthTimeout = () => {
          healthAllowances.push(allowance);
          elapsed += allowance;
          return { status: 1, stdout: "", stderr: "health timed out" };
        };
        return args.includes(hermesPortableLifecycleInternals.healthWaitProgram)
          ? healthTimeout()
          : capture(args);
      });
      await expect(
        recoverWithLifecycleLock({
          ...fixture.deps,
          startupTimeoutMs: 100,
          now: () => elapsed,
          captureOpenShell: command,
        }),
      ).rejects.toThrow(`allowance exhausted during ${phase}`);
      expect(command.mock.calls.find(([args]) => args[1] === "start")?.[1]).toBe(startAllowance);
      expect(healthAllowances).toEqual(expectedHealth);
      expect(elapsed).toBe(100);
      expect(openshellMutationCalls(command, "stop")).toHaveLength(stops);
    },
  );

  it.each(["authenticated-health", "final-authority"])(
    "reports %s timeout on the running fast path (#11652)",
    async (phase) => {
      const fixture = lifecycleDeps(activeReceipt(), true);
      const capture = fixture.captureOpenShell.getMockImplementation()!;
      let elapsed = 0;
      let healthSeen = false;
      fixture.captureOpenShell.mockImplementation((args: readonly string[]) => {
        const health = args.includes("python3");
        const expire = phase === "authenticated-health" ? health : healthSeen && args[1] === "get";
        elapsed += expire ? 100 : 0;
        healthSeen ||= health;
        return capture(args);
      });
      await expect(
        recoverWithLifecycleLock({ ...fixture.deps, startupTimeoutMs: 100, now: () => elapsed }),
      ).rejects.toThrow(`allowance exhausted during ${phase}`);
      expect(healthSeen).toBe(true);
      expect(elapsed).toBe(100);
      expect(fixture.launchOpenShell).not.toHaveBeenCalled();
      expect(openshellMutationCalls(fixture.captureOpenShell, "start")).toHaveLength(0);
      expect(openshellMutationCalls(fixture.captureOpenShell, "stop")).toHaveLength(0);
    },
  );

  it("reconciles and stops a partially applied start after its allowance expires (#11652)", async () => {
    const fixture = lifecycleDeps(activeReceipt(), false, { startStatus: 1 });
    const capture = fixture.captureOpenShell.getMockImplementation()!;
    let elapsed = 0;
    const command = vi.fn((args: readonly string[], allowance: number) => {
      const result = capture(args);
      elapsed += args[1] === "start" ? allowance : 0;
      return result;
    });
    await expect(
      recoverWithLifecycleLock({
        ...fixture.deps,
        startupTimeoutMs: 100,
        now: () => elapsed,
        captureOpenShell: command,
      }),
    ).rejects.toThrow("OpenShell start failed with status 1");
    expect(elapsed).toBe(100);
    expect(openshellMutationCalls(command, "stop")).toHaveLength(1);
    expect(fixture.deps.container.podman(["container", "inspect"])).toEqual(
      expect.objectContaining({ stdout: expect.stringContaining('"Running":false') }),
    );
  });

  it("shares the caller allowance across start and exec readiness, then rolls back (#11652)", async () => {
    const fixture = lifecycleDeps(activeReceipt(), false);
    const capture = fixture.captureOpenShell.getMockImplementation()!;
    let elapsed = 0;
    const command = vi.fn((args: readonly string[], allowance: number) => {
      const operation = args.slice(0, 2).join(":");
      elapsed += operation === "sandbox:start" ? 55_000 : 0;
      const execNotReady =
        operation === "sandbox:exec" && args.at(-1) === "true" && elapsed < 130_000;
      elapsed += execNotReady ? Math.min(5_000, allowance) : 0;
      return execNotReady ? { status: 1, stdout: "", stderr: "not ready" } : capture(args);
    });
    await expect(
      recoverWithLifecycleLock({
        ...fixture.deps,
        startupTimeoutMs: 120_000,
        now: () => elapsed,
        sleep: (milliseconds) => {
          elapsed += milliseconds;
        },
        captureOpenShell: command,
      }),
    ).rejects.toThrow("allowance exhausted during openshell-exec-readiness");
    expect(elapsed).toBe(120_000);
    expect(openshellMutationCalls(command, "start")).toHaveLength(1);
    expect(openshellMutationCalls(command, "stop")).toHaveLength(1);
  });

  it.each([
    { initialPhase: "Error" as const, status: "running" },
    { initialPhase: "Error" as const, status: "exited" },
    { initialPhase: "Ready" as const, status: "exited" },
    { initialPhase: "Ready" as const, status: "stopping" },
  ])(
    "rejects unsupported saved $initialPhase with container=$status before mutation (#11646)",
    async ({ initialPhase, status }) => {
      const fixture = lifecycleDeps(activeReceipt(), status === "running", {
        initialPhase,
        nonRunningStatus: status,
      });
      await expect(recoverWithLifecycleLock(fixture.deps)).rejects.toThrow(
        `saved OpenShell phase ${initialPhase}`,
      );
      expect(openshellMutationCalls(fixture.captureOpenShell, "start")).toHaveLength(0);
      expect(openshellMutationCalls(fixture.captureOpenShell, "stop")).toHaveLength(0);
      expect(fixture.launchOpenShell).not.toHaveBeenCalled();
      expect(
        fixture.podman.mock.calls.filter(([args]) => args[1] === "start" || args[1] === "stop"),
      ).toHaveLength(0);
    },
  );

  it("reconciles saved Stopped with a running container through OpenShell (#11646)", async () => {
    const fixture = lifecycleDeps(activeReceipt(), true, { initialPhase: "Stopped" });
    const evidence = vi.fn();
    const result = await recoverWithLifecycleLock({
      ...fixture.deps,
      recoveryTiming: { onComplete: evidence },
    });
    expect(result).toEqual({ kind: "recovered" });
    expect(evidence).toHaveBeenCalledWith(
      expect.objectContaining({ containerStartCount: 1, containerAction: "reused" }),
    );
    expect(openshellMutationCalls(fixture.captureOpenShell, "start")).toHaveLength(1);
    expect(openshellMutationCalls(fixture.captureOpenShell, "stop")).toHaveLength(0);
    expect(fixture.launchOpenShell).not.toHaveBeenCalled();
    expect(
      fixture.podman.mock.calls.filter(([args]) => args[1] === "start" || args[1] === "stop"),
    ).toHaveLength(0);
  });

  it("preserves the pre-existing container when saved-phase reconciliation fails (#11646)", async () => {
    const fixture = lifecycleDeps(activeReceipt(), true, {
      initialPhase: "Stopped",
      startStatus: 1,
    });
    await expect(recoverWithLifecycleLock(fixture.deps)).rejects.toThrow("OpenShell start failed");
    expect(openshellMutationCalls(fixture.captureOpenShell, "start")).toHaveLength(1);
    expect(openshellMutationCalls(fixture.captureOpenShell, "stop")).toHaveLength(0);
    expect(fixture.launchOpenShell).not.toHaveBeenCalled();
    expect(
      fixture.podman.mock.calls.filter(([args]) => args[1] === "start" || args[1] === "stop"),
    ).toHaveLength(0);
  });

  it("uses one entry and final qualification when the timing callback fails (#10423)", async () => {
    const receipt = activeReceipt();
    await publishSuccessor();
    const fixture = lifecycleDeps(receipt, false);
    const evidence = vi.fn(() => {
      throw new Error("timing sink unavailable");
    });
    let timingNow = 0;
    const result = await recoverWithLifecycleLock({
      ...fixture.deps,
      recoveryTiming: {
        now: () => (timingNow += 1),
        onComplete: evidence,
      },
    });
    expect(result).toEqual({ kind: "recovered" });
    expect(evidence).toHaveBeenCalledOnce();
    expect(evidence).toHaveBeenCalledWith(
      expect.objectContaining({
        qualificationCount: 2,
        containerStartCount: 1,
        execReadyAttempts: 1,
        authenticatedHealthCount: 1,
        startupLaunchCount: 1,
        rollbackCount: 0,
        containerAction: "started",
        result: "recovered",
      }),
    );
    const operations = fixture.captureOpenShell.mock.calls.map(([args]) =>
      args.slice(0, 2).join(":"),
    );
    // Entry and final qualification recheck identity after their awaited policy observation.
    expect(operations.filter((operation) => operation === "sandbox:list")).toHaveLength(6);
    expect(operations.filter((operation) => operation === "sandbox:get")).toHaveLength(6);
    expect(operations.filter((operation) => operation === "policy:get")).toHaveLength(3);
    expect(openshellMutationCalls(fixture.captureOpenShell, "start")).toHaveLength(1);
    expect(openshellMutationCalls(fixture.captureOpenShell, "stop")).toHaveLength(0);
    expect(fixture.assertOpenShellExecutableFileAuthority).toHaveBeenCalled();
    expect(fixture.capturePodmanExecutableFileAuthority).toHaveBeenCalled();
  });

  it("emits failed timing when entry qualification rejects socket authority (#10423)", async () => {
    const receipt = activeReceipt();
    await publishSuccessor();
    const fixture = lifecycleDeps(receipt, false);
    const entryError = new Error("socket authority changed during entry qualification");
    const evidence = vi.fn();
    fixture.captureSocketAuthority.mockImplementation(() => {
      throw entryError;
    });
    await expect(
      recoverWithLifecycleLock({
        ...fixture.deps,
        recoveryTiming: { onComplete: evidence },
      }),
    ).rejects.toThrow(entryError);
    expect(openshellMutationCalls(fixture.captureOpenShell, "start")).toHaveLength(0);
    expect(evidence).toHaveBeenCalledOnce();
    expect(evidence).toHaveBeenCalledWith(
      expect.objectContaining({
        qualificationCount: 1,
        containerStartCount: 0,
        result: "failed",
      }),
    );
  });

  it("fails before post-start work when retained socket authority drifts (#11248)", async () => {
    const receipt = activeReceipt();
    await publishSuccessor();
    const fixture = lifecycleDeps(receipt, false);
    const stableCapture = fixture.captureSocketAuthority.getMockImplementation()!;
    fixture.captureSocketAuthority.mockImplementation(() => {
      const socket = stableCapture();
      const started = openshellMutationCalls(fixture.captureOpenShell, "start").length > 0;
      return started ? { ...socket, inode: "changed-after-start" } : socket;
    });
    let failure: unknown;
    try {
      await recoverWithLifecycleLock(fixture.deps);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      errors: [expect.any(Error), expect.any(Error)],
      message:
        "Hermes portable lifecycle recovery failed (primary=container-start; rollback=pre-stop-authority-unproved)",
      primaryFailureClass: "container-start",
      rollbackFailureClass: "pre-stop-authority",
    });
    expect(fixture.captureOpenShell).not.toHaveBeenCalledWith(
      expect.arrayContaining(["true"]),
      expect.any(Number),
    );
    expect(openshellMutationCalls(fixture.captureOpenShell, "stop")).toHaveLength(0);
  });

  it("records polling failure and proves exact stopped rollback under retained authority (#10423)", async () => {
    const receipt = activeReceipt();
    await publishSuccessor();
    const fixture = lifecycleDeps(receipt, false);
    const defaultCapture = fixture.captureOpenShell.getMockImplementation()!;
    fixture.captureOpenShell.mockImplementation((args: readonly string[]) =>
      args.includes("python3")
        ? { status: 0, stdout: "unavailable\n", stderr: "" }
        : defaultCapture(args),
    );
    const evidence = vi.fn();
    let now = 0;
    await expect(
      recoverWithLifecycleLock({
        ...fixture.deps,
        now: () => now,
        sleep: (milliseconds) => {
          now += milliseconds;
        },
        recoveryTiming: { now: () => now, onComplete: evidence },
      }),
    ).rejects.toThrow("managed startup did not pass authenticated health");
    expect(openshellMutationCalls(fixture.captureOpenShell, "stop")).toHaveLength(1);
    expect(evidence).toHaveBeenCalledOnce();
    expect(evidence).toHaveBeenCalledWith(
      expect.objectContaining({
        qualificationCount: 2,
        containerStartCount: 1,
        startupLaunchCount: 1,
        rollbackCount: 1,
        containerAction: "started",
        result: "failed",
      }),
    );
    expect(evidence.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ authenticatedHealthSleepMs: 90_000 }),
    );
  });

  it("uses post-start authority to roll back a Stopped-origin OpenShell sandbox", async () => {
    const receipt = activeReceipt();
    await publishSuccessor();
    const fixture = lifecycleDeps(receipt, false, {
      sandboxPhase: () => "Stopped",
      stopRequiresAssist: true,
    });
    const defaultCapture = fixture.captureOpenShell.getMockImplementation()!;
    fixture.captureOpenShell.mockImplementation((args: readonly string[]) =>
      args.includes(hermesPortableLifecycleInternals.healthWaitProgram)
        ? { status: 0, stdout: "unavailable\n", stderr: "" }
        : defaultCapture(args),
    );
    let now = 0;

    await expect(
      recoverWithLifecycleLock({
        ...fixture.deps,
        now: () => now,
        sleep: (milliseconds) => {
          now += milliseconds;
        },
      }),
    ).rejects.toThrow("OpenShell sandbox identity disagrees with the receipt container");

    const calls = fixture.captureOpenShell.mock.calls.map(([args]) => args);
    const assist = calls.findIndex((args) =>
      args.includes(hermesPortableLifecycleInternals.openShellV0116StopAssistProgram),
    );
    const stop = calls.findIndex((args) => args[0] === "sandbox" && args[1] === "stop");
    expect(assist).toBeGreaterThanOrEqual(0);
    expect(stop).toBeGreaterThan(assist);
    expect(openshellMutationCalls(fixture.captureOpenShell, "stop")).toHaveLength(1);
  });

  it("rejects live sandbox rebind before the name-addressed startup launch (#10423)", async () => {
    const receipt = activeReceipt();
    await publishSuccessor();
    const fixture = lifecycleDeps(receipt, false);
    const defaultCapture = fixture.captureOpenShell.getMockImplementation()!;
    fixture.captureOpenShell.mockImplementation(
      rebindAfterSandboxStart(defaultCapture, {
        status: 0,
        stdout: sandboxListJson("rebound-sandbox-id", "Ready"),
        stderr: "",
      }),
    );
    await expect(
      withMcpLifecycleLock(
        SANDBOX,
        () => recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), fixture.deps),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).rejects.toThrow("OpenShell sandbox identity disagrees with the receipt container");
    expect(fixture.launchOpenShell).not.toHaveBeenCalled();
    expect(openshellMutationCalls(fixture.captureOpenShell, "start")).toHaveLength(1);
    expect(openshellMutationCalls(fixture.captureOpenShell, "stop")).toHaveLength(1);
  });

  it("rolls back when the final full qualification detects registry drift (#10423)", async () => {
    const receipt = activeReceipt();
    await publishSuccessor();
    const fixture = lifecycleDeps(receipt, false);
    const stableReadRegistry: NonNullable<HermesPortableLifecycleDeps["readRegistry"]> =
      fixture.deps.readRegistry!;
    const drift = driftRegistryAfterStartup(
      stableReadRegistry,
      () => fixture.launchOpenShell.mock.calls.length > 0,
    );
    await expect(
      withMcpLifecycleLock(
        SANDBOX,
        () =>
          recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), {
            ...fixture.deps,
            readRegistry: drift.readRegistry,
          }),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).rejects.toThrow("registry authority disagrees with the active receipt");
    expect(openshellMutationCalls(fixture.captureOpenShell, "start")).toHaveLength(1);
    expect(openshellMutationCalls(fixture.captureOpenShell, "stop")).toHaveLength(1);
    expect(drift.didDrift()).toBe(true);
  });

  it("reconciles an interrupted schema-8 publication inside both probe fences (#10423)", async () => {
    const receipt = activeReceipt(stateDir);
    await expect(
      withMcpLifecycleLock(
        SANDBOX,
        () =>
          publishHermesPortableSuccessorReceipt(SANDBOX, stateDir, {
            afterCanonicalLink: () => {
              throw new Error("simulated schema-8 process exit");
            },
          }),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).rejects.toThrow("simulated schema-8 process exit");
    const fixture = lifecycleDeps(receipt);
    Reflect.deleteProperty(fixture.deps.operatingAuthority!, "env");
    const recovered = await withPortableHostFence(stateDir, () =>
      withMcpLifecycleLock(
        SANDBOX,
        () => requalifyHermesPortableSandboxAuthority(SANDBOX, lifecycleContext(), fixture.deps),
        { stateDir: path.join(stateDir, "state") },
      ),
    );
    expect([
      recovered.kind,
      (fixture.capturePodmanExecutableAuthority.mock.calls.at(-1) as unknown[] | undefined)?.[2],
    ]).toEqual(["already-current", fixture.deps.env]);
    expect(readHermesPortableLifecycleReceipt(SANDBOX, stateDir)?.successor).toBeDefined();
  });

  it("rejects successor-publication generation drift between lifecycle snapshots (#10423)", async () => {
    const receipt = activeReceipt(stateDir);
    const fixture = lifecycleDeps(receipt);
    await withPortableHostFence(stateDir, () =>
      withMcpLifecycleLock(
        SANDBOX,
        async () => {
          const expected = readHermesPortableLifecycleReceiptForRequalification(SANDBOX, stateDir)!;
          expect(() =>
            publishHermesPortableSuccessorReceipt(SANDBOX, stateDir, {
              afterCanonicalLink: () => {
                throw new Error("simulated schema-8 process exit");
              },
            }),
          ).toThrow("simulated schema-8 process exit");
          await expect(
            hermesPortableLifecycleInternals.qualify(
              SANDBOX,
              lifecycleContext(),
              fixture.deps,
              expected,
              ["Ready", "Error", "Stopped"],
              { permitSchema5Requalification: true },
            ),
          ).rejects.toThrow("receipt authority changed");
        },
        { stateDir: path.join(stateDir, "state") },
      ),
    );
  });

  it("constructs production Podman dependencies from the receipt identity (#9203)", () => {
    const receipt = activeReceipt();
    const capture = vi.fn<ContainerEngineCommandCapture>(
      (_executable, args, _timeoutMs, _input, environment) => {
        expect(environment).toEqual({
          HOME: receipt.runtimeAuthority.homeDir,
          XDG_CONFIG_HOME: receipt.runtimeAuthority.configHome,
          XDG_RUNTIME_DIR: receipt.runtimeAuthority.runtimeDir,
        });
        const operation = args.includes("version")
          ? "version"
          : args.includes("info")
            ? "info"
            : "business";
        const responses = {
          version: {
            status: 0,
            stdout: JSON.stringify({
              Client: { Version: "5.7.0" },
              Server: { Version: "5.7.0" },
            }),
            stderr: "",
          },
          info: {
            status: 0,
            stdout: JSON.stringify({
              host: {
                arch: "amd64",
                os: "linux",
                cgroupVersion: "v2",
                networkBackend: "netavark",
                security: { rootless: true },
                idMappings: {
                  uidmap: [
                    { container_id: 0, host_id: receipt.runtimeAuthority.uid, size: 1 },
                    { container_id: 1, host_id: 100000, size: 65536 },
                  ],
                  gidmap: [
                    { container_id: 0, host_id: receipt.runtimeAuthority.uid, size: 1 },
                    { container_id: 1, host_id: 100000, size: 65536 },
                  ],
                },
              },
            }),
            stderr: "",
          },
          business: { status: 0, stdout: "exact container", stderr: "" },
        } as const;
        return responses[operation];
      },
    );
    const container = hermesPortableLifecycleInternals.createContainerDeps(
      receipt,
      {
        HOME: receipt.runtimeAuthority.homeDir,
        PATH: "/usr/bin",
        XDG_CONFIG_HOME: receipt.runtimeAuthority.configHome,
        XDG_RUNTIME_DIR: receipt.runtimeAuthority.runtimeDir,
      },
      {
        capture,
        executableAuthorityDeps: testPodmanExecutableAuthorityDeps(),
        assertSocketAuthority: vi.fn(),
        resolveExecutablePath: () => receipt.podmanExecutableAuthority.executable.executablePath,
        platform: "linux",
        architecture: "x64",
        uid: receipt.runtimeAuthority.uid,
      },
    );
    expect(container.podman(["container", "inspect", CONTAINER_ID], 5_000)).toMatchObject({
      status: 0,
      stdout: "exact container",
    });
    expect(capture).toHaveBeenLastCalledWith(
      receipt.podmanExecutableAuthority.executable.executablePath,
      [
        "--url",
        `unix://${receipt.socketAuthority.socketPath}`,
        "container",
        "inspect",
        CONTAINER_ID,
      ],
      5_000,
      undefined,
      expect.any(Object),
    );
  });

  it.each([0, 1])(
    "recovers a stopped container after %i credential-file waits (#9203)",
    async (credentialWaits) => {
      const receipt = activeReceipt();
      const { deps, podman, captureOpenShell } = lifecycleDeps(receipt, false);
      const defaultCapture = captureOpenShell.getMockImplementation()!;
      let unavailable = credentialWaits;
      captureOpenShell.mockImplementation((args: readonly string[]) =>
        args.includes(hermesPortableLifecycleInternals.healthWaitProgram) && unavailable-- > 0
          ? { status: 64, stdout: "", stderr: "" }
          : defaultCapture(args),
      );
      const result = await recoverWithLifecycleLock(deps);
      expect(result).toEqual({ kind: "recovered" });
      expect(captureOpenShell).toHaveBeenCalledWith(
        [
          "sandbox",
          "exec",
          "-g",
          GATEWAY,
          "--name",
          SANDBOX,
          "--no-tty",
          "--",
          "python3",
          "-I",
          "-c",
          hermesPortableLifecycleInternals.healthWaitProgram,
          "8642",
          "200",
          "18000",
          "100",
        ],
        20_000,
      );
      const commands = captureOpenShell.mock.calls.map(([args]) => args);
      expect(podman.mock.calls.some(([args]) => args[1] === "start")).toBe(false);
      const waiter = commands.findIndex((args) =>
        args.includes(hermesPortableLifecycleInternals.healthWaitProgram),
      );
      const observer = commands.findIndex((args) =>
        args.includes(hermesPortableContainerInternals.authenticatedHealthScript),
      );
      expect(observer).toBeGreaterThan(waiter);
      expect(deps.now()).toBe(credentialWaits * 1_000);
      expect(openshellMutationCalls(captureOpenShell, "start")).toHaveLength(1);
    },
  );

  it("starts through the exact OpenShell Stopped phase before proving Ready health (#9203)", async () => {
    const { deps, podman, captureOpenShell } = lifecycleDeps(activeReceipt(), false);
    const defaultCapture = captureOpenShell.getMockImplementation()!;
    let listObservations = 0;
    const observeList = () => {
      listObservations += 1;
      return {
        status: 0,
        stdout: sandboxListJson(SANDBOX_ID, listObservations <= 2 ? "Stopped" : "Ready"),
        stderr: "",
      };
    };
    captureOpenShell.mockImplementation((args: readonly string[]) => {
      const operation = args.slice(0, 2).join(":");
      return operation === "sandbox:list"
        ? observeList()
        : operation === "sandbox:get"
          ? {
              status: 0,
              stdout: `Name: ${SANDBOX}\nID: ${SANDBOX_ID}\nPhase: ${listObservations <= 2 ? "Stopped" : "Ready"}\n`,
              stderr: "",
            }
          : defaultCapture(args);
    });
    const result = await recoverWithLifecycleLock(deps);
    expect(result).toEqual({ kind: "recovered" });
    expect(listObservations).toBeGreaterThanOrEqual(3);
    const operations = captureOpenShell.mock.calls.map(([args]) => args.slice(0, 2).join(":"));
    const postStart = operations.slice(
      operations.indexOf("sandbox:start") + 1,
      operations.indexOf("sandbox:exec"),
    );
    // Post-start qualification observes identity on both sides of the policy await.
    expect(postStart.filter((operation) => operation === "sandbox:list")).toHaveLength(2);
    expect(postStart.filter((operation) => operation === "sandbox:get")).toHaveLength(2);
    expect(podman.mock.calls.filter(([args]) => args[1] === "start")).toHaveLength(0);
    expect(openshellMutationCalls(captureOpenShell, "start")).toHaveLength(1);
  });

  it("uses only the receipt-owned startup after restarting a stopped container (#9211)", async () => {
    const receipt = activeReceipt();
    const { deps, podman, captureOpenShell, launchOpenShell } = lifecycleDeps(receipt, false);
    const defaultCapture = captureOpenShell.getMockImplementation()!;
    const inspectCount = () =>
      podman.mock.calls.filter(([command]) => command[1] === "inspect").length;
    const healthBoundaries: number[] = [];
    const sleepBoundaries: Array<{ inspectsBefore: number; milliseconds: number }> = [];
    let healthAttempts = 0;
    let now = 0;
    const observeHealth = () => {
      healthBoundaries.push(inspectCount());
      healthAttempts += 1;
      return {
        status: 0,
        stdout:
          launchOpenShell.mock.calls.length === 1
            ? "schema=1 result=ready attempts=2 notReady=1 timeouts=0 errors=0 lastFailure=not-ready probeMs=10 sleepMs=100\n"
            : "unavailable\n",
        stderr: "",
      };
    };
    captureOpenShell.mockImplementation((args: readonly string[]) =>
      args.includes(hermesPortableLifecycleInternals.healthWaitProgram)
        ? observeHealth()
        : defaultCapture(args),
    );
    const result = await recoverWithLifecycleLock({
      ...deps,
      now: () => now,
      sleep: (milliseconds) => {
        sleepBoundaries.push({ inspectsBefore: inspectCount(), milliseconds });
        now += milliseconds;
      },
    });
    const healthRunInspects = podman.mock.calls.filter(
      ([args]) => args[0] === "container" && args[1] === "inspect",
    );
    expect(result).toEqual({ kind: "recovered" });
    expect(healthAttempts).toBe(1);
    expect(healthBoundaries).toHaveLength(1);
    expect(healthRunInspects.length).toBeGreaterThan(healthBoundaries[0]!);
    expect([sleepBoundaries, launchOpenShell.mock.calls]).toEqual([[], [expect.any(Array)]]);
    expect(openshellMutationCalls(captureOpenShell, "start")).toHaveLength(1);
  });

  it.each([
    [0, "final health-wait command did not return valid readiness evidence"],
    [64, "Hermes credential file was unavailable or invalid"],
    [
      255,
      "final health-wait command did not return valid readiness evidence; an earlier probe reported an unavailable or invalid Hermes credential file",
    ],
  ])(
    "rolls back unavailable health with waiter status %i and diagnostic %s (#9211)",
    async (status, diagnostic) => {
      const receipt = activeReceipt();
      const { deps, captureOpenShell, launchOpenShell } = lifecycleDeps(receipt, false);
      const defaultCapture = captureOpenShell.getMockImplementation()!;
      let now = 0;
      let healthAttempts = 0;
      captureOpenShell.mockImplementation((args: readonly string[]) =>
        args.includes("python3")
          ? {
              status: status === 255 && healthAttempts++ === 0 ? 64 : status,
              stdout: "unavailable\n",
              stderr: "",
            }
          : defaultCapture(args),
      );
      await expect(
        recoverWithLifecycleLock({
          ...deps,
          now: () => now,
          sleep: (milliseconds) => {
            now += milliseconds;
          },
        }),
      ).rejects.toThrow(diagnostic);
      expect(now).toBe(90_000);
      expect(launchOpenShell).toHaveBeenCalledTimes(1);
      expect(
        captureOpenShell.mock.calls.some(([args]) =>
          args.includes(hermesPortableContainerInternals.authenticatedHealthScript),
        ),
      ).toBe(false);
      expect(openshellMutationCalls(captureOpenShell, "stop")).toHaveLength(1);
    },
  );

  it("preserves startup and terminal-settlement failure classes together (#11248)", async () => {
    const receipt = activeReceipt();
    let observedRunning = false;
    const { deps, captureOpenShell, launchOpenShell } = lifecycleDeps(receipt, false, {
      sandboxPhase: (running) => {
        observedRunning ||= running;
        return observedRunning ? "Ready" : "Stopped";
      },
    });
    const defaultCapture = captureOpenShell.getMockImplementation()!;
    captureOpenShell.mockImplementation((args: readonly string[]) =>
      args.includes("python3")
        ? { status: 0, stdout: "unavailable\n", stderr: "" }
        : defaultCapture(args),
    );
    launchOpenShell.mockImplementation(() => {
      throw new Error("startup handoff failed");
    });
    let failure: unknown;
    try {
      await recoverWithLifecycleLock(deps);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      errors: [expect.any(Error), expect.any(Error)],
      message:
        "Hermes portable lifecycle recovery failed (primary=startup-launch; rollback=openshell-terminal-settlement-unproved)",
      primaryFailureClass: "startup-launch",
      rollbackFailureClass: "openshell-terminal-settlement",
    });
    expect(launchOpenShell).toHaveBeenCalledTimes(1);
    expect(openshellMutationCalls(captureOpenShell, "start")).toHaveLength(1);
    expect(openshellMutationCalls(captureOpenShell, "stop")).toHaveLength(1);
  });

  it("rejects authority drift after exec readiness without launching startup (#9211)", async () => {
    const receipt = activeReceipt();
    const { deps, captureOpenShell, launchOpenShell } = lifecycleDeps(receipt, false);
    const defaultCapture = captureOpenShell.getMockImplementation()!;
    const stableReadRegistry: NonNullable<HermesPortableLifecycleDeps["readRegistry"]> =
      deps.readRegistry!;
    let execReady = false;
    let driftPending = true;
    captureOpenShell.mockImplementation((args: readonly string[]) => {
      execReady ||= args.at(-1) === "true";
      return defaultCapture(args);
    });
    const driftLifecycleGeneration = (entry: SandboxEntry): SandboxEntry => {
      driftPending = false;
      return { ...entry, lifecycleGeneration: "f".repeat(64) };
    };
    const driftedDeps = {
      ...deps,
      readRegistry: (_sandboxName: string) => {
        const entry = stableReadRegistry(_sandboxName);
        return entry && execReady && driftPending ? driftLifecycleGeneration(entry) : entry;
      },
    };
    await expect(recoverWithLifecycleLock(driftedDeps)).rejects.toThrow(
      "registry authority disagrees with the active receipt",
    );
    expect(launchOpenShell).not.toHaveBeenCalled();
    expect(openshellMutationCalls(captureOpenShell, "start")).toHaveLength(1);
    expect(openshellMutationCalls(captureOpenShell, "stop")).toHaveLength(1);
  });

  it("rolls back its exact container when OpenShell does not reconnect (#9203)", async () => {
    const receipt = activeReceipt();
    const { deps, captureOpenShell } = lifecycleDeps(receipt, false);
    const defaultCapture = captureOpenShell.getMockImplementation()!;
    let now = 0;
    captureOpenShell.mockImplementation((args: readonly string[]) =>
      args.at(-1) === "true"
        ? { status: 1, stdout: "", stderr: "unavailable" }
        : defaultCapture(args),
    );
    await expect(
      recoverWithLifecycleLock({
        ...deps,
        now: () => now,
        sleep: (milliseconds) => {
          now += milliseconds;
        },
      }),
    ).rejects.toThrow("did not reconnect to the selected OpenShell gateway");
    expect(now).toBe(90_000);
    expect(openshellMutationCalls(captureOpenShell, "start")).toHaveLength(1);
    expect(openshellMutationCalls(captureOpenShell, "stop")).toHaveLength(1);
  });
  it.each([
    ["post-start inspection fails", { failPostStartInspectOnce: true }, "exact inspect failed"],
    ["OpenShell reports failure", { startStatus: 1 }, "OpenShell start failed with status 1"],
  ])("reconciles and rolls back when %s (#9203)", async (_case, options, failure) => {
    const receipt = activeReceipt();
    const { deps, captureOpenShell } = lifecycleDeps(receipt, false, options);
    await expect(recoverWithLifecycleLock(deps)).rejects.toThrow(failure);
    expect(openshellMutationCalls(captureOpenShell, "start")).toHaveLength(1);
    expect(openshellMutationCalls(captureOpenShell, "stop")).toHaveLength(1);
  });
  it.each(["Ready", "Stopped"] as const)(
    "preserves an already-running container after a health failure from %s (#11646)",
    async (initialPhase) => {
      const receipt = activeReceipt();
      const { deps, captureOpenShell, launchOpenShell } = lifecycleDeps(receipt, true, {
        initialPhase,
      });
      const defaultCapture = captureOpenShell.getMockImplementation()!;
      let now = 0;
      captureOpenShell.mockImplementation((args: readonly string[]) =>
        args.includes("python3")
          ? { status: 0, stdout: "unavailable\n", stderr: "" }
          : defaultCapture(args),
      );
      await expect(
        recoverWithLifecycleLock({
          ...deps,
          now: () => now,
          sleep: (milliseconds) => {
            now += milliseconds;
          },
        }),
      ).rejects.toThrow("managed startup did not pass authenticated health");
      expect(launchOpenShell).not.toHaveBeenCalled();
      expect(openshellMutationCalls(captureOpenShell, "start")).toHaveLength(
        initialPhase === "Stopped" ? 1 : 0,
      );
      expect(openshellMutationCalls(captureOpenShell, "stop")).toHaveLength(0);
    },
  );

  it("recovers against the current live OpenShell policy (#9211)", async () => {
    const receipt = activeReceipt();
    const registry = {} satisfies Partial<SandboxEntry>;
    const livePolicy = POLICY;
    const { deps } = lifecycleDeps(receipt, false, { livePolicy, registry });
    const result = await recoverWithLifecycleLock(deps);
    expect(result).toEqual({ kind: "recovered" });
    expect(
      openshellMutationCalls(deps.captureOpenShell as ReturnType<typeof vi.fn>, "start"),
    ).toHaveLength(1);
  });

  it("uses structured list phase when sandbox get omits phase (#9211)", async () => {
    const { deps, captureOpenShell } = lifecycleDeps(activeReceipt(), false);
    const defaultCapture = captureOpenShell.getMockImplementation()!;
    captureOpenShell.mockImplementation((args: readonly string[]) =>
      args.slice(0, 2).join(":") === "sandbox:get"
        ? {
            status: 0,
            stdout: `Name: ${SANDBOX}\nID: ${SANDBOX_ID}\n`,
            stderr: "",
          }
        : defaultCapture(args),
    );
    const result = await recoverWithLifecycleLock(deps);
    expect(result).toEqual({ kind: "recovered" });
    expect(captureOpenShell).toHaveBeenCalledWith(
      ["sandbox", "list", "-g", GATEWAY, "-o", "json"],
      5_000,
    );
  });

  it("accepts a valid host-edited policy without a finalized policy receipt (#9211)", async () => {
    const receipt = activeReceipt();
    const finalized = {
      name: SANDBOX,
      agent: "hermes",
    } as SandboxEntry;
    const livePolicy = POLICY;
    const { deps, podman } = lifecycleDeps(receipt, false, {
      livePolicy,
      registry: { ...finalized },
    });
    expect(await recoverWithLifecycleLock(deps)).toEqual({ kind: "recovered" });
    expect(podman).toHaveBeenCalled();
  });

  it("rejects an ambient OpenShell endpoint before Podman or OpenShell effects (#9203)", async () => {
    const { deps, podman, captureOpenShell } = lifecycleDeps(activeReceipt(), false);
    const endpointDeps = {
      ...deps,
      env: { OPENSHELL_GATEWAY_ENDPOINT: "https://ambient.example" },
    };
    await expect(recoverWithLifecycleLock(endpointDeps)).rejects.toThrow(
      "OPENSHELL_GATEWAY_ENDPOINT is set",
    );
    expect(podman).not.toHaveBeenCalled();
    expect(captureOpenShell).not.toHaveBeenCalled();
  });

  it("retries an incomplete identity before delayed OpenShell Error after stopping one full ID (#11302)", async () => {
    const receipt = activeReceipt();
    let elapsedMs = 0;
    const { deps, podman, captureOpenShell } = lifecycleDeps(receipt, true, {
      sandboxPhase: (running) => (running || elapsedMs < 2_000 ? "Ready" : "Error"),
      sandboxIdentity: (running) =>
        !running && elapsedMs < 1_000 ? `Name: ${SANDBOX}\nPhase: Ready\n` : undefined,
    });
    deps.now = () => elapsedMs;
    deps.sleep = vi.fn((milliseconds: number) => {
      elapsedMs += milliseconds;
    });
    const result = await withMcpLifecycleLock(
      SANDBOX,
      () => stopHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), vi.fn(), deps),
      { stateDir: path.join(stateDir, "state") },
    );
    expect(result).toEqual({ kind: "stopped" });
    expect(podman.mock.calls.filter(([args]) => args[1] === "stop")).toEqual([]);
    expect(captureOpenShell).toHaveBeenCalledWith(
      ["sandbox", "stop", "-g", GATEWAY, SANDBOX],
      60_000,
    );
    expect(captureOpenShell).toHaveBeenCalledWith(
      expect.arrayContaining([hermesPortableLifecycleInternals.openShellV0116StopAssistProgram]),
      5_000,
    );
    expect(captureOpenShell).toHaveReturnedWith({
      status: 0,
      stdout: sandboxListJson(SANDBOX_ID, "Error"),
      stderr: "",
    });
    expect(elapsedMs).toBe(2_000);
  });

  it("accepts the exact already-stopped Podman container and OpenShell Error phase without another stop (#9203)", async () => {
    const receipt = activeReceipt();
    const { deps, captureOpenShell } = lifecycleDeps(receipt, false);
    const result = await withMcpLifecycleLock(
      SANDBOX,
      () => stopHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), vi.fn(), deps),
      { stateDir: path.join(stateDir, "state") },
    );
    expect(result).toEqual({ kind: "already-stopped" });
    expect(openshellMutationCalls(captureOpenShell, "stop")).toHaveLength(0);
  });

  it("accepts the exact already-stopped Podman container and OpenShell Stopped phase (#9203)", async () => {
    const receipt = activeReceipt();
    const { deps, captureOpenShell } = lifecycleDeps(receipt, false, {
      sandboxPhase: () => "Stopped",
    });
    const result = await withMcpLifecycleLock(
      SANDBOX,
      () => stopHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), vi.fn(), deps),
      { stateDir: path.join(stateDir, "state") },
    );
    expect(result).toEqual({ kind: "already-stopped" });
    expect(openshellMutationCalls(captureOpenShell, "stop")).toHaveLength(0);
  });

  it("rejects OpenShell Stopped while the receipt-owned container is running (#9203)", async () => {
    const receipt = activeReceipt();
    const beforeStop = vi.fn();
    const { deps, captureOpenShell } = lifecycleDeps(receipt, true, {
      sandboxPhase: () => "Stopped",
    });
    await expect(
      withMcpLifecycleLock(
        SANDBOX,
        () => stopHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), beforeStop, deps),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).rejects.toThrow("OpenShell Stopped phase disagrees with the running receipt container");
    expect(beforeStop).not.toHaveBeenCalled();
    expect(openshellMutationCalls(captureOpenShell, "stop")).toHaveLength(0);
  });

  it("reconciles an already-stopped container whose OpenShell phase remains Ready (#11248)", async () => {
    const receipt = activeReceipt();
    let stopRequested = false;
    const { deps, captureOpenShell } = lifecycleDeps(receipt, false, {
      sandboxPhase: () => (stopRequested ? "Error" : "Ready"),
    });
    const defaultCapture = captureOpenShell.getMockImplementation()!;
    captureOpenShell.mockImplementation((args: readonly string[]) => {
      stopRequested ||= args.slice(0, 2).join(":") === "sandbox:stop";
      return defaultCapture(args);
    });
    const result = await withMcpLifecycleLock(
      SANDBOX,
      () => stopHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), vi.fn(), deps),
      { stateDir: path.join(stateDir, "state") },
    );
    expect(result).toEqual({ kind: "already-stopped" });
    expect(openshellMutationCalls(captureOpenShell, "stop")).toHaveLength(1);
  });

  it("times out a stopped container when OpenShell identity remains incomplete (#11302)", async () => {
    const receipt = activeReceipt();
    const { deps, podman, captureOpenShell } = lifecycleDeps(receipt, true, {
      sandboxIdentity: (running) => (running ? undefined : `Name: ${SANDBOX}\nPhase: Error\n`),
    });
    await expect(
      withMcpLifecycleLock(
        SANDBOX,
        () => stopHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), vi.fn(), deps),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).rejects.toThrow(
      "OpenShell sandbox did not settle in Error or Stopped after exact container exit",
    );
    expect(podman.mock.calls.filter(([args]) => args[1] === "stop")).toHaveLength(0);
    expect(openshellMutationCalls(captureOpenShell, "stop")).toHaveLength(1);
  });

  it("reconciles a receipt-owned stopping state through OpenShell control (#9203)", async () => {
    const receipt = activeReceipt();
    const { deps, podman, captureOpenShell } = lifecycleDeps(receipt, false);
    let inspectionCount = 0;
    podman.mockImplementation((args: readonly string[]) => {
      inspectionCount += args[1] === "inspect" ? 1 : 0;
      const status = inspectionCount < 4 ? "stopping" : "exited";
      return args[1] === "inspect"
        ? {
            status: 0,
            stdout: JSON.stringify([
              {
                Id: CONTAINER_ID,
                Image: IMAGE,
                Name: receipt.container.name,
                Config: { Labels: LABELS },
                State: { Running: false, Paused: false, Status: status },
                HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
              },
            ]),
            stderr: "",
          }
        : poisonUnexpectedCommand("podman", args);
    });
    let now = 0;
    const result = await withMcpLifecycleLock(
      SANDBOX,
      () =>
        stopHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), vi.fn(), {
          ...deps,
          now: () => now,
          sleep: (milliseconds) => {
            now += milliseconds;
          },
        }),
      { stateDir: path.join(stateDir, "state") },
    );
    expect(result).toEqual({ kind: "stopped" });
    expect(openshellMutationCalls(captureOpenShell, "stop")).toHaveLength(1);
  });

  it("fails closed when OpenShell same-name identity changes (#9203)", async () => {
    const receipt = activeReceipt();
    const { deps } = lifecycleDeps(receipt);
    deps.captureOpenShell = vi.fn((args: readonly string[]) =>
      args[0] === "policy"
        ? { status: 0, stdout: POLICY, stderr: "" }
        : args[1] === "list"
          ? { status: 0, stdout: sandboxListJson("replacement", "Ready"), stderr: "" }
          : {
              status: 0,
              stdout: `Name: ${SANDBOX}\nID: replacement\n`,
              stderr: "",
            },
    );
    await expect(recoverWithLifecycleLock(deps)).rejects.toThrow(
      "OpenShell sandbox identity disagrees",
    );
  });

  it("fails closed when the exact OpenShell sandbox is no longer Ready (#9608)", async () => {
    const receipt = activeReceipt();
    const { deps, podman } = lifecycleDeps(receipt);
    deps.captureOpenShell = vi.fn((args: readonly string[]) =>
      args[0] === "policy"
        ? { status: 0, stdout: POLICY, stderr: "" }
        : args[1] === "list"
          ? { status: 0, stdout: sandboxListJson(SANDBOX_ID, "Creating"), stderr: "" }
          : {
              status: 0,
              stdout: `Name: ${SANDBOX}\nID: ${SANDBOX_ID}\n`,
              stderr: "",
            },
    );
    await expect(recoverWithLifecycleLock(deps)).rejects.toThrow(
      "OpenShell sandbox identity disagrees",
    );
    expect(podman).not.toHaveBeenCalled();
  });

  it.each(["Ready", "Stopped", "Error"] as const)(
    "removes one exact %s sandbox and rejects a same-name replacement on retry (#9608)",
    async (phase) => {
      const receipt = activeReceipt();
      const { deps, podman } = lifecycleDeps(receipt, phase === "Ready");
      const originalPodman = podman.getMockImplementation()!;
      let sandboxPresent = true;
      let containerPresent = true;
      let replacement = false;
      const live = `Name: ${SANDBOX}\nID: ${SANDBOX_ID}\nPhase: ${phase}\n`;
      podman.mockImplementation((args: readonly string[]) => {
        switch (args[0]) {
          case "container":
            return args[1] === "inspect" && !containerPresent
              ? { status: 125, stdout: "", stderr: "no such container" }
              : originalPodman(args);
          case "ps":
            return { status: 0, stdout: containerPresent ? `${CONTAINER_ID}\n` : "", stderr: "" };
          default:
            return originalPodman(args);
        }
      });
      deps.captureOpenShell = vi.fn((args: readonly string[]) => {
        const command = args.slice(0, 2).join(":");
        switch (command) {
          case "policy:get":
            return { status: 0, stdout: POLICY, stderr: "" };
          case "sandbox:list":
            return {
              status: 0,
              stdout: args.includes("json")
                ? sandboxPresent
                  ? sandboxListJson(SANDBOX_ID, phase)
                  : "[]"
                : live,
              stderr: "",
            };
          case "sandbox:delete":
            sandboxPresent = false;
            containerPresent = false;
            return { status: 0, stdout: "", stderr: "" };
          case "sandbox:get":
            return replacement
              ? {
                  status: 0,
                  stdout: `Name: ${SANDBOX}\nID: replacement\nPhase: Ready\n`,
                  stderr: "",
                }
              : sandboxPresent
                ? { status: 0, stdout: live, stderr: "" }
                : {
                    status: 1,
                    stdout: "",
                    stderr: `Error: sandbox '${SANDBOX}' not found`,
                  };
          default:
            return poisonUnexpectedCommand("OpenShell", args);
        }
      });
      await withMcpLifecycleLock(
        SANDBOX,
        async () => {
          const prepared = await prepareHermesPortableSandboxRemoval(
            SANDBOX,
            lifecycleContext(),
            deps,
            {
              allowAbsent: true,
            },
          );
          expect(prepared.present).toBe(true);
          await prepared.removeAndVerify();
          await prepared.verifyAbsent();
          expect(
            (
              await prepareHermesPortableSandboxRemoval(SANDBOX, lifecycleContext(), deps, {
                allowAbsent: true,
              })
            ).present,
          ).toBe(false);
          replacement = true;
          await expect(
            prepareHermesPortableSandboxRemoval(SANDBOX, lifecycleContext(), deps, {
              allowAbsent: true,
            }),
          ).rejects.toThrow("OpenShell sandbox identity disagrees");
        },
        { stateDir: path.join(stateDir, "state") },
      );
      expect(
        deps.captureOpenShell.mock.calls.filter(([args]) => args[1] === "delete"),
      ).toHaveLength(1);
    },
  );
  it("rejects rendered absence text when the JSON sandbox list is malformed (#9608)", async () => {
    const receipt = activeReceipt();
    const { deps, podman } = lifecycleDeps(receipt);
    deps.captureOpenShell = vi.fn((args: readonly string[]) => {
      const command = args.slice(0, 2).join(":");
      switch (command) {
        case "sandbox:get":
          return { status: 1, stdout: "", stderr: `sandbox ${SANDBOX} not found` };
        case "sandbox:list":
          return { status: 0, stdout: "warning: stale cache", stderr: "" };
        default:
          return poisonUnexpectedCommand("OpenShell", args);
      }
    });
    await expect(
      withMcpLifecycleLock(
        SANDBOX,
        () =>
          prepareHermesPortableSandboxRemoval(SANDBOX, lifecycleContext(), deps, {
            allowAbsent: true,
          }),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).rejects.toThrow("cannot prove the current OpenShell sandbox");
    expect(podman).not.toHaveBeenCalled();
  });
});
