// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadAgent } from "../../agent/defs";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
import {
  HermesPortableGatewayUnavailableError,
  recoverHermesPortableSandboxLifecycle,
} from "./hermes-portable-lifecycle";
import {
  CONTAINER_ID,
  createHermesPortableLifecycleTestDeps,
  createHermesPortableLifecycleTestReceipt,
  GATEWAY,
  GENERATION,
  IMAGE,
  LABELS,
  POLICY,
  SANDBOX,
  SANDBOX_ID,
} from "./hermes-portable-lifecycle.test-fixture";
import { openshellMutationCalls } from "./hermes-portable-lifecycle.test-fixtures";

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-gateway-unavailable-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("Hermes portable lifecycle gateway availability", () => {
  it("classifies an unavailable receipt-bound gateway before container mutation", async () => {
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
    const fixture = createHermesPortableLifecycleTestDeps(stateDir, receipt, false);
    const capture = fixture.captureOpenShell.getMockImplementation()!;
    fixture.captureOpenShell.mockImplementation((args) =>
      args[0] === "sandbox" && args[1] === "list"
        ? { status: 1, stdout: "", stderr: "connection refused" }
        : capture(args),
    );

    const recovery = withMcpLifecycleLock(
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
          fixture.deps,
        ),
      { stateDir: path.join(stateDir, "state") },
    );

    await expect(recovery).rejects.toBeInstanceOf(HermesPortableGatewayUnavailableError);
    expect(openshellMutationCalls(fixture.captureOpenShell, "start")).toHaveLength(0);
    expect(fixture.launchOpenShell).not.toHaveBeenCalled();
  });
});
