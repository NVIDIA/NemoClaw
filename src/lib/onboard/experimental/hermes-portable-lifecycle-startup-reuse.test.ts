// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAgent } from "../../agent/defs";
import {
  withMcpLifecycleLock,
  withMcpLifecycleLockSync,
} from "../../state/mcp-lifecycle-lock-acquisition";
import { withHermesPortableStartupOperation } from "./hermes-portable-startup-operation";
import {
  buildHermesPortableOpenShellEnv,
  recoverHermesPortableSandboxLifecycle,
  stopHermesPortableSandboxLifecycle,
} from "./hermes-portable-lifecycle";
import { publishHermesPortableSuccessorReceipt } from "./hermes-portable-receipt";
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
  LABELS,
} from "./hermes-portable-lifecycle.test-fixture";

describe("Portable lifecycle startup handoff", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-lifecycle-reuse-"));
  });
  afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  function setup() {
    const policyPath = path.join(stateDir, "policy.yaml");
    fs.writeFileSync(policyPath, POLICY, { mode: 0o600 });
    const receipt = createHermesPortableLifecycleTestReceipt({
      agent: loadAgent("hermes"),
      stateDir,
      policyPath,
      homeDir: "/home/test",
      sandboxName: SANDBOX,
      gatewayName: GATEWAY,
      lifecycleGeneration: GENERATION,
      containerId: CONTAINER_ID,
      imageDigest: IMAGE,
      sandboxId: SANDBOX_ID,
      labels: LABELS,
    });
    const lockDir = path.join(stateDir, "state");
    withMcpLifecycleLockSync(
      SANDBOX,
      () => publishHermesPortableSuccessorReceipt(SANDBOX, stateDir),
      { stateDir: lockDir },
    );
    const fixture = createHermesPortableLifecycleTestDeps(stateDir, receipt, false);
    const deps = {
      ...fixture.deps,
      env: {
        ...fixture.deps.env,
        NEMOCLAW_EXPERIMENTAL_PROFILE: "portable",
      },
    };
    const context = {
      agent: "hermes",
      gatewayName: GATEWAY,
      lifecycleGeneration: GENERATION,
      openshellDriver: "docker",
      provider: "ollama",
    };
    const recover = () => recoverHermesPortableSandboxLifecycle(SANDBOX, context, deps);
    const stop = () => stopHermesPortableSandboxLifecycle(SANDBOX, context, () => undefined, deps);
    const run = (operation: () => Promise<void>, now: () => number = () => 0) =>
      withMcpLifecycleLock(
        SANDBOX,
        () => withHermesPortableStartupOperation(SANDBOX, lockDir, operation, deps.env, now),
        { stateDir: lockDir },
      );
    const execReadiness = () =>
      fixture.captureOpenShell.mock.calls.some(([args]) => args.at(-1) === "true");
    return {
      fixture,
      deps,
      recover,
      stop,
      run,
      execReadiness,
      commandEnv: buildHermesPortableOpenShellEnv(deps.env, receipt.runtimeAuthority),
    };
  }

  it("hands completed startup to the next probe while rechecking live authority (#11574)", async () => {
    const h = setup();
    await h.run(async () => {
      await expect(h.recover()).resolves.toEqual({ kind: "recovered" });
      h.fixture.captureOpenShell.mockClear();
      await expect(h.recover()).resolves.toEqual({ kind: "already-running" });
      expect(h.execReadiness()).toBe(false);
      expect(h.fixture.captureOpenShell.mock.calls.some(([args]) => args.includes("get"))).toBe(
        true,
      );
      expect(h.fixture.captureOpenShell.mock.calls.some(([args]) => args.includes("policy"))).toBe(
        true,
      );
      expect(h.fixture.launchOpenShell).toHaveBeenCalledOnce();
    });
  });

  it("hands startup to a probe using its exact sanitized command environment (#11574)", async () => {
    const h = setup();
    await h.run(async () => {
      await h.recover();
      Object.assign(h.deps, { env: h.commandEnv });
      h.fixture.captureOpenShell.mockClear();
      await expect(h.recover()).resolves.toEqual({ kind: "already-running" });
      expect(h.execReadiness()).toBe(false);
    });
  });

  it("does not treat a modified command environment as the startup environment (#11574)", async () => {
    const h = setup();
    await h.run(async () => {
      await h.recover();
      Object.assign(h.deps, { env: { ...h.commandEnv, UNEXPECTED_STARTUP_VALUE: "changed" } });
      h.fixture.captureOpenShell.mockClear();
      await expect(h.recover()).resolves.toEqual({ kind: "already-running" });
      expect(h.execReadiness()).toBe(true);
    });
  });

  it("rejects socket drift after startup (#11574)", async () => {
    const h = setup();
    await h.run(async () => {
      await h.recover();
      h.fixture.captureSocketAuthority.mockImplementation(() => {
        throw new Error("socket changed");
      });
      await expect(h.recover()).rejects.toThrow("socket changed");
      expect(h.fixture.launchOpenShell).toHaveBeenCalledOnce();
    });
  });

  it("rejects registry drift after startup (#11574)", async () => {
    const h = setup();
    await h.run(async () => {
      await h.recover();
      const entry = h.deps.readRegistry();
      h.deps.readRegistry = () => ({ ...entry, model: "changed" });
      await expect(h.recover()).rejects.toThrow("registry changed");
      expect(h.fixture.launchOpenShell).toHaveBeenCalledOnce();
    });
  });

  it.each(["policy", "get"])("rejects changed live %s after startup (#11574)", async (command) => {
    const h = setup();
    await h.run(async () => {
      await h.recover();
      const original = h.fixture.captureOpenShell.getMockImplementation()!;
      h.fixture.captureOpenShell.mockImplementation((args) =>
        args.includes(command)
          ? { status: 0, stdout: "invalid authority", stderr: "" }
          : original(args),
      );
      await expect(h.recover()).rejects.toThrow();
      expect(h.fixture.launchOpenShell).toHaveBeenCalledOnce();
    });
  });

  it("uses full recovery after the startup scope expires (#11574)", async () => {
    const h = setup();
    let now = 0;
    await h.run(
      async () => {
        await h.recover();
        now = 60_000;
        h.fixture.captureOpenShell.mockClear();
        await expect(h.recover()).resolves.toEqual({ kind: "already-running" });
        expect(h.execReadiness()).toBe(true);
      },
      () => now,
    );
  });

  it("falls back to fresh qualification when retained command time is exhausted (#11574)", async () => {
    const h = setup();
    let commandNow = 0;
    h.deps.now = () => commandNow;

    await h.run(async () => {
      await h.recover();
      commandNow = 240_001;
      h.fixture.captureOpenShell.mockClear();
      await expect(h.recover()).resolves.toEqual({ kind: "already-running" });
      expect(h.execReadiness()).toBe(true);
    });
  });

  it("recovers again after a supported stop (#11574)", async () => {
    const h = setup();
    await h.run(async () => {
      await h.recover();
      await h.stop();
      h.fixture.captureOpenShell.mockClear();
      await expect(h.recover()).resolves.toEqual({ kind: "recovered" });
      expect(h.execReadiness()).toBe(true);
      expect(h.fixture.launchOpenShell).toHaveBeenCalledTimes(2);
    });
  });

  it("returns to full recovery after an unhealthy observation (#11574)", async () => {
    const h = setup();
    await h.run(async () => {
      await h.recover();
      const original = h.fixture.captureOpenShell.getMockImplementation()!;
      h.fixture.captureOpenShell.mockClear();
      const unhealthy = vi
        .fn(() => ({ status: 0, stdout: "unavailable\n", stderr: "" }))
        .mockImplementationOnce(() => ({ status: 0, stdout: "unavailable\n", stderr: "" }));
      h.fixture.captureOpenShell.mockImplementation((args) =>
        args.includes("python3") && unhealthy.mock.calls.length === 0
          ? unhealthy()
          : original(args),
      );
      await expect(h.recover()).resolves.toEqual({ kind: "already-running" });
      expect(h.execReadiness()).toBe(true);
    });
  });

  it.each([
    { NEMOCLAW_EXPERIMENTAL_PORTABLE_STARTUP_REUSE: "0" },
    { TEST_STARTUP_VALUE: "changed" },
  ])("uses full recovery after environment changes to %j (#11574)", async (change) => {
    const h = setup();
    await h.run(async () => {
      await h.recover();
      Object.assign(h.deps.env, change);
      h.fixture.captureOpenShell.mockClear();
      await expect(h.recover()).resolves.toEqual({ kind: "already-running" });
      expect(h.execReadiness()).toBe(true);
    });
  });
});
