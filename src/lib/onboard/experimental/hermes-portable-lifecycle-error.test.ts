// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAgent } from "../../agent/defs";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
import {
  recoverHermesPortableSandboxLifecycle,
  type HermesPortableLifecycleDeps,
} from "./hermes-portable-lifecycle";
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
import { openshellMutationCalls } from "./hermes-portable-lifecycle.test-fixtures";
import { withOpenShellErrorFields } from "./hermes-portable-lifecycle-error.test-fixture";

let stateDir: string;
let policyPath: string;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-error-"));
  policyPath = path.join(stateDir, "policy.yaml");
  fs.writeFileSync(policyPath, POLICY, { mode: 0o600 });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(stateDir, { recursive: true, force: true });
});
function fixture(running: boolean, startStatus = 0) {
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
  return createHermesPortableLifecycleTestDeps(stateDir, receipt, running, {
    initialPhase: "Error",
    startStatus,
  });
}
function recover(deps: HermesPortableLifecycleDeps) {
  return withMcpLifecycleLock(
    SANDBOX,
    () =>
      recoverHermesPortableSandboxLifecycle(
        SANDBOX,
        {
          agent: "hermes",
          gatewayName: GATEWAY,
          lifecycleGeneration: GENERATION,
          openshellDriver: "docker",
          provider: "ollama",
        },
        deps,
      ),
    { stateDir: path.join(stateDir, "state") },
  );
}
const restartable = [
  {
    name: "failed main process",
    fields: {
      exit_code: 7,
      conditions: [{ type: "Ready", status: "False", reason: "MainProcessFailed" }],
    },
  },
  {
    name: "reclaimed provisioning timeout",
    fields: {
      provisioning: {
        timeout_time: "2026-10-09T01:00:00Z",
        cleanup_completed_time: "2026-10-09T01:00:01Z",
      },
    },
  },
].flatMap((scenario) => [false, true].map((running) => ({ ...scenario, running })));

describe("Hermes OpenShell 0.1.2 Error recovery", () => {
  it.each(restartable)(
    "recovers $name with running=$running through native start",
    async ({ fields, running }) => {
      const f = fixture(running);
      const command = withOpenShellErrorFields(f.captureOpenShell, fields);
      await expect(recover({ ...f.deps, captureOpenShell: command })).resolves.toEqual({
        kind: "recovered",
      });
      expect(openshellMutationCalls(command, "start")).toHaveLength(1);
      expect(openshellMutationCalls(command, "stop")).toHaveLength(0);
      expect(f.deps.container.podman(["container", "inspect"])).toEqual(
        expect.objectContaining({ stdout: expect.stringContaining('"Running":true') }),
      );
      expect(f.podman.mock.calls.filter(([args]) => args[1] === "start")).toHaveLength(0);
    },
  );
  it.each(restartable)(
    "rolls back only a new start after $name fails with running=$running",
    async ({ fields, running }) => {
      const f = fixture(running, 1);
      const command = withOpenShellErrorFields(f.captureOpenShell, fields);
      await expect(recover({ ...f.deps, captureOpenShell: command })).rejects.toThrow(
        "OpenShell start failed with status 1",
      );
      expect(f.launchOpenShell).not.toHaveBeenCalled();
      expect(openshellMutationCalls(command, "start")).toHaveLength(1);
      expect(openshellMutationCalls(command, "stop")).toHaveLength(running ? 0 : 1);
      expect(f.deps.container.podman(["container", "inspect"])).toEqual(
        expect.objectContaining({ stdout: expect.stringContaining(`"Running":${running}`) }),
      );
      expect(f.podman.mock.calls.filter(([args]) => args[1] === "start")).toHaveLength(0);
    },
  );
  it.each([
    {
      name: "missing exit code",
      fields: { conditions: [{ type: "Ready", status: "False", reason: "MainProcessFailed" }] },
    },
    {
      name: "infrastructure failure",
      fields: {
        exit_code: 7,
        conditions: [{ type: "Ready", status: "False", reason: "InfrastructureFailed" }],
      },
    },
    {
      name: "pending cleanup",
      fields: {
        exit_code: 7,
        conditions: [{ type: "Ready", status: "False", reason: "MainProcessFailed" }],
        provisioning: { timeout_time: "2026-10-09T01:00:00Z", cleanup_completed_time: null },
      },
    },
    {
      name: "invalid cleanup timestamp",
      fields: {
        provisioning: { timeout_time: "2026-10-09T01:00:00Z", cleanup_completed_time: "invalid" },
      },
    },
    {
      name: "another workspace",
      fields: {
        workspace: "another",
        exit_code: 7,
        conditions: [{ type: "Ready", status: "False", reason: "MainProcessFailed" }],
      },
    },
  ])("preserves an Error workload with $name without mutation", async ({ fields }) => {
    const f = fixture(false);
    const command = withOpenShellErrorFields(f.captureOpenShell, fields);
    await expect(recover({ ...f.deps, captureOpenShell: command })).rejects.toThrow(
      "saved OpenShell phase Error",
    );
    expect(openshellMutationCalls(command, "start")).toHaveLength(0);
    expect(openshellMutationCalls(command, "stop")).toHaveLength(0);
    expect(f.launchOpenShell).not.toHaveBeenCalled();
  });
});
