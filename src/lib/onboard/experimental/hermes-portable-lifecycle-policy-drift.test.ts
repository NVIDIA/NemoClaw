// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { loadAgent } from "../../agent/defs";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
import { recoverHermesPortableSandboxLifecycle } from "./hermes-portable-lifecycle";
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
import { openshellMutationCalls } from "./hermes-portable-lifecycle.test-fixtures";

it("rejects registry drift during policy observation before recovery mutations (#11479)", async (context) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-drift-"));
  context.onTestFinished(() => fs.rmSync(stateDir, { recursive: true, force: true }));
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
  const lockOptions = { stateDir: path.join(stateDir, "state") };
  await withMcpLifecycleLock(
    SANDBOX,
    () => publishHermesPortableSuccessorReceipt(SANDBOX, stateDir),
    lockOptions,
  );
  const fixture = createHermesPortableLifecycleTestDeps(stateDir, receipt, false);
  let row = fixture.deps.readRegistry();
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const observing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const operation = withMcpLifecycleLock(
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
        {
          ...fixture.deps,
          readRegistry: () => row,
          capturePolicy: async () => {
            entered();
            await pending;
            return { status: 0, stdout: Buffer.from(POLICY), stderr: Buffer.alloc(0) };
          },
        },
      ),
    lockOptions,
  );
  const rejected = expect(operation).rejects.toThrow(
    "registry authority disagrees with the active receipt",
  );
  await observing;
  row = { ...row!, lifecycleGeneration: "f".repeat(64) };
  release();
  await rejected;
  expect(fixture.launchOpenShell).not.toHaveBeenCalled();
  expect(fixture.podman.mock.calls.some(([args]) => args[1] === "start")).toBe(false);
  expect(openshellMutationCalls(fixture.captureOpenShell, "start")).toHaveLength(0);
});
