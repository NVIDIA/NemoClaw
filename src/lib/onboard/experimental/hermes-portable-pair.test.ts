// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
import { SANDBOX, GATEWAY, GENERATION, POLICY } from "./hermes-portable-lifecycle.test-fixture";
import { createHermesPortablePairFixture } from "./hermes-portable-pair.test-fixture";
import { openshellMutationCalls } from "./hermes-portable-lifecycle.test-fixtures";
import {
  hermesPortableLifecycleInternals,
  recoverHermesPortableSandboxLifecycle,
  stopHermesPortableSandboxLifecycle,
  type HermesPortableLifecycleDeps,
} from "./hermes-portable-lifecycle";
import { publishHermesPortableSuccessorReceipt } from "./hermes-portable-receipt";

let stateDir: string;
let policyPath: string;
function pairedStopFixture(initiallyRunning: boolean) {
  return createHermesPortablePairFixture(stateDir, policyPath, initiallyRunning);
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
  vi.unstubAllEnvs();
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

describe("Hermes portable paired-container stop", () => {
  it.each([true, false])(
    "verifies supervisor exit during Hermes rollback (supervisor remains running=%s)",
    async (supervisorRemainsRunning) => {
      const { deps, captureOpenShell, failStartupAndSetSupervisorStopState } =
        pairedStopFixture(false);
      await publishSuccessor();
      failStartupAndSetSupervisorStopState(supervisorRemainsRunning);
      await expect(recoverWithLifecycleLock(deps)).rejects.toThrow(
        supervisorRemainsRunning
          ? "rollback=openshell-terminal-settlement-unproved"
          : "managed startup did not pass authenticated health",
      );
      expect(openshellMutationCalls(captureOpenShell, "stop")).toHaveLength(1);
    },
  );

  it.each([true, false])(
    "rejects stopped Hermes success when its supervisor is running (workload initially running=%s)",
    async (initiallyRunning) => {
      const { deps, podman } = pairedStopFixture(initiallyRunning);
      await expect(
        withMcpLifecycleLock(
          SANDBOX,
          () => stopHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), vi.fn(), deps),
          { stateDir: path.join(stateDir, "state") },
        ),
      ).rejects.toThrow("did not settle");
      expect(podman.mock.calls.some(([args]) => args[1] === "stop" || args[1] === "rm")).toBe(
        false,
      );
    },
  );

  it.each([true, false])(
    "waits for both Hermes containers to exit (workload initially running=%s)",
    async (initiallyRunning) => {
      const { deps, captureOpenShell, exitSupervisorAfter } = pairedStopFixture(initiallyRunning);
      exitSupervisorAfter(2_000);
      const result = await withMcpLifecycleLock(
        SANDBOX,
        () => stopHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), vi.fn(), deps),
        { stateDir: path.join(stateDir, "state") },
      );
      expect(result).toEqual({ kind: initiallyRunning ? "stopped" : "already-stopped" });
      expect(deps.now()).toBe(2_000);
      expect(
        captureOpenShell.mock.calls.some(([args]) =>
          args.includes(hermesPortableLifecycleInternals.openShellV0116StopAssistProgram),
        ),
      ).toBe(false);
    },
  );

  it.each([
    "openshell.ai/isolation-role",
    "openshell.ai/sandbox-id",
    "openshell.ai/sandbox-workspace",
    "openshell.ai/sandbox-namespace",
  ] as const)("rejects a Hermes supervisor with changed %s before stop", async (label) => {
    const { deps, supervisor, captureOpenShell } = pairedStopFixture(true);
    supervisor.Config.Labels[label] = "wrong-identity";
    const beforeStop = vi.fn();
    await expect(
      withMcpLifecycleLock(
        SANDBOX,
        () => stopHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), beforeStop, deps),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).rejects.toThrow(/inspect (isolation role|label)/);
    expect(beforeStop).not.toHaveBeenCalled();
    expect(openshellMutationCalls(captureOpenShell, "stop")).toHaveLength(0);
  });

  it("rejects a replaced Hermes supervisor after the stop callback without mutation", async () => {
    const { deps, supervisor, captureOpenShell } = pairedStopFixture(true);
    await expect(
      withMcpLifecycleLock(
        SANDBOX,
        () =>
          stopHermesPortableSandboxLifecycle(
            SANDBOX,
            lifecycleContext(),
            () => {
              supervisor.Id = "d".repeat(64);
            },
            deps,
          ),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).rejects.toThrow("inspect returned another container ID");
    expect(openshellMutationCalls(captureOpenShell, "stop")).toHaveLength(0);
  });

  it.each(["", `${"c".repeat(64)}\n${"d".repeat(64)}`])(
    "rejects a missing or ambiguous Hermes supervisor before stop (%j)",
    async (inventory) => {
      const { deps, podman, captureOpenShell } = pairedStopFixture(true);
      const capture = podman.getMockImplementation()!;
      podman.mockImplementation((args) =>
        args[0] === "ps" ? { status: 0, stdout: inventory, stderr: "" } : capture(args),
      );
      const beforeStop = vi.fn();
      await expect(
        withMcpLifecycleLock(
          SANDBOX,
          () => stopHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), beforeStop, deps),
          { stateDir: path.join(stateDir, "state") },
        ),
      ).rejects.toThrow("requires exactly one full supervisor container ID");
      expect(beforeStop).not.toHaveBeenCalled();
      expect(openshellMutationCalls(captureOpenShell, "stop")).toHaveLength(0);
    },
  );
});
