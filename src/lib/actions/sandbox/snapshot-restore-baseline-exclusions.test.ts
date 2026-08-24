// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as f from "./snapshot-restore-test-fixture";

beforeEach(f.resetSnapshotRestoreMocks);
afterEach(f.cleanupSnapshotRestoreMocks);

describe("runSandboxSnapshot restore: baseline exclusions", () => {
  it("uses the OpenClaw baseline in the shared fixture when the agent is absent", () => {
    const openClawBaseline = {
      agent: "openclaw",
      policyPath: "/repo/nemoclaw-blueprint/policies/openclaw-sandbox.yaml",
      content: "version: 1\nnetwork_policies: {}\n",
    };

    expect(f.resolveAgentBaselinePolicyMock(undefined)).toEqual(openClawBaseline);
    expect(f.resolveAgentBaselinePolicyMock(null)).toEqual(openClawBaseline);
    expect(f.resolveAgentBaselinePolicyMock("openclaw")).toEqual(openClawBaseline);
  });

  it("creates a clone with the source exclusions applied to its live policy (#7178)", async () => {
    const exclusion = {
      version: 1 as const,
      agent: "hermes",
      key: "nous_research",
      digest: "a".repeat(64),
      acknowledgedAt: "2026-07-19T00:00:00.000Z",
      appliedAgentVersion: "0.18.0",
    };
    const cleanup = vi.fn(() => true);
    let registeredClone: f.SandboxRecord | null = null;
    f.registerSandboxMock.mockImplementation(
      (entry) => (registeredClone = entry as f.SandboxRecord),
    );
    f.getSandboxMock.mockImplementation((name) =>
      name === "alpha"
        ? {
            name: "alpha",
            agent: "hermes",
            imageTag: "nemoclaw-alpha:test",
            openshellDriver: "docker",
            provider: "nvidia-nim",
            model: "nvidia/model-a",
            baselineExclusions: [exclusion],
          }
        : registeredClone,
    );
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.prepareInitialSandboxCreatePolicyMock.mockReturnValue({
      policyPath: "/tmp/snapshot-clone-policy.yaml",
      appliedPresets: [],
      cleanup,
    });

    const { runSandboxSnapshot } = await import("./snapshot");
    await runSandboxSnapshot("alpha", { kind: "restore", to: "beta" });

    expect(f.resolveAgentBaselinePolicyMock).toHaveBeenCalledWith("hermes");
    expect(f.prepareInitialSandboxCreatePolicyMock).toHaveBeenCalledWith(
      "/repo/agents/hermes/policy-additions.yaml",
      [],
      { agentName: "hermes", sandboxName: "beta", baselineExclusions: [exclusion] },
    );
    const createArgs = f.streamSandboxCreateMock.mock.calls[0]?.[1] ?? [];
    expect(createArgs[createArgs.indexOf("--policy") + 1]).toBe("/tmp/snapshot-clone-policy.yaml");
    expect(f.registerSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "beta", baselineExclusions: [exclusion] }),
      undefined,
      { pending: true },
    );
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
