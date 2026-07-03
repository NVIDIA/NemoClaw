// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createRebuildFlowHarness,
  makePreparedRecoveryManifest,
  type RebuildFlowHarness,
  resetRebuildFlowTestEnvironment,
  restoreRebuildFlowTestEnvironment,
  snapshotEnv,
} from "../../../../test/helpers/rebuild-flow-harness";

function makeDcodeSandboxEntry(): Record<string, unknown> {
  return {
    name: "alpha",
    agent: "langchain-deepagents-code",
    agentVersion: "0.1.12",
    nemoclawVersion: "0.0.72",
    provider: "compatible-endpoint",
    model: "nvidia/nemotron-3-super-120b-a12b",
    endpointUrl: "https://inference-api.nvidia.com/v1",
    credentialEnv: "COMPATIBLE_API_KEY",
    preferredInferenceApi: "openai-completions",
    nimContainer: null,
    policies: [],
    dashboardPort: 0,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    gpuEnabled: false,
    sandboxGpuEnabled: false,
    sandboxGpuMode: "0",
  };
}

function configureDcodeSession(harness: RebuildFlowHarness): void {
  Object.assign(harness.session, {
    agent: "langchain-deepagents-code",
    provider: "compatible-endpoint",
    model: "nvidia/nemotron-3-super-120b-a12b",
    endpointUrl: "https://inference-api.nvidia.com/v1",
    credentialEnv: "COMPATIBLE_API_KEY",
    preferredInferenceApi: "openai-completions",
    gpuPassthrough: false,
  });
}

function expectNoDcodeMutation(harness: RebuildFlowHarness): void {
  expect(harness.openShieldsSpy).not.toHaveBeenCalled();
  expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
  expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
    ["sandbox", "delete", "alpha"],
    expect.anything(),
  );
  expect(harness.removeSandboxRegistryEntrySpy).not.toHaveBeenCalled();
  expect(harness.onboardSpy).not.toHaveBeenCalled();
}

describe("rebuildSandbox DCode flow", () => {
  beforeEach(resetRebuildFlowTestEnvironment);
  afterEach(restoreRebuildFlowTestEnvironment);

  it("rejects a stored DCode route failure before any rebuild mutation (#6195)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: makeDcodeSandboxEntry(),
      dcodeRouteResults: [
        { ok: false, detail: "existing sandbox inference probe returned HTTP 401" },
      ],
    });
    configureDcodeSession(harness);

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Recorded inference route smoke check failed");

    expect(harness.preflightDcodeRouteSpy).toHaveBeenCalledOnce();
    expect(harness.prepareManagedDcodeRebuildImageSpy).not.toHaveBeenCalled();
    expect(harness.disposePreparedDcodeRebuildImageSpy).not.toHaveBeenCalled();
    expectNoDcodeMutation(harness);
  });

  it("keeps DCode intact when its recorded gateway cannot become healthy (#6195)", async () => {
    const restoreEnv = snapshotEnv(["OPENSHELL_GATEWAY"]);
    process.env.OPENSHELL_GATEWAY = "previous-gateway";

    try {
      const harness = createRebuildFlowHarness({
        agentName: "langchain-deepagents-code",
        sandboxEntry: makeDcodeSandboxEntry(),
        gatewayRecoveryResult: {
          recovered: false,
          attempted: true,
          before: { state: "named_unhealthy" },
          after: { state: "named_unhealthy" },
        },
      });
      configureDcodeSession(harness);

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("Could not select healthy gateway 'nemoclaw'");

      expect(process.env.OPENSHELL_GATEWAY).toBe("previous-gateway");
      expect(harness.preflightDcodeRouteSpy).not.toHaveBeenCalled();
      expect(harness.prepareManagedDcodeRebuildImageSpy).not.toHaveBeenCalled();
      expectNoDcodeMutation(harness);
    } finally {
      restoreEnv();
    }
  });

  it("restores the prior gateway when messaging conflict preflight throws after target pin (#6195)", async () => {
    const restoreEnv = snapshotEnv(["OPENSHELL_GATEWAY"]);
    process.env.OPENSHELL_GATEWAY = "previous-gateway";

    try {
      const harness = createRebuildFlowHarness({
        agentName: "langchain-deepagents-code",
        sandboxEntry: makeDcodeSandboxEntry(),
        preflightMessagingConflicts: () => {
          throw new Error("messaging conflict preflight failed");
        },
      });
      configureDcodeSession(harness);

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("messaging conflict preflight failed");

      expect(harness.preflightMessagingConflictsSpy).toHaveBeenCalledOnce();
      expect(process.env.OPENSHELL_GATEWAY).toBe("previous-gateway");
      expect(harness.preflightDcodeRouteSpy).not.toHaveBeenCalled();
      expect(harness.prepareManagedDcodeRebuildImageSpy).not.toHaveBeenCalled();
      expect(harness.disposePreparedDcodeRebuildImageSpy).not.toHaveBeenCalled();
      expectNoDcodeMutation(harness);
    } finally {
      restoreEnv();
    }
  });

  it("rejects a DCode replacement-image failure before any rebuild mutation (#6195)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: makeDcodeSandboxEntry(),
      dcodeImageResult: { ok: false, detail: "replacement image build failed" },
    });
    configureDcodeSession(harness);

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow();

    expect(harness.preflightDcodeRouteSpy).toHaveBeenCalledOnce();
    expect(harness.prepareManagedDcodeRebuildImageSpy).toHaveBeenCalledOnce();
    expect(harness.disposePreparedDcodeRebuildImageSpy).not.toHaveBeenCalled();
    expectNoDcodeMutation(harness);
  });

  it("rejects a managed DCode session with a recorded custom Dockerfile before image preparation (#6195)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: makeDcodeSandboxEntry(),
    });
    configureDcodeSession(harness);
    harness.session.metadata = { fromDockerfile: "/tmp/custom/Dockerfile" };

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Managed DCode rebuild cannot use a recorded custom Dockerfile");

    expect(harness.preflightDcodeRouteSpy).not.toHaveBeenCalled();
    expect(harness.prepareManagedDcodeRebuildImageSpy).not.toHaveBeenCalled();
    expect(harness.disposePreparedDcodeRebuildImageSpy).not.toHaveBeenCalled();
    expectNoDcodeMutation(harness);
  });

  it("rejects registry drift during the final DCode preflight before shields and backup (#6195)", async () => {
    const originalEntry = makeDcodeSandboxEntry();
    const driftedEntry = { ...originalEntry, model: "nvidia/changed-during-preflight" };
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: originalEntry,
      sandboxEntryReads: [
        originalEntry, // Initial rebuild target.
        originalEntry, // Messaging-conflict gateway selection (#5954).
        originalEntry, // Prepared DCode target capture.
        driftedEntry, // Final pre-backup target verification.
      ],
      dcodeRouteResults: [{ ok: true }, { ok: true }],
    });
    configureDcodeSession(harness);

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("the recorded sandbox target changed during preflight");

    expect(harness.preflightDcodeRouteSpy).toHaveBeenCalledTimes(2);
    expect(harness.prepareManagedDcodeRebuildImageSpy).toHaveBeenCalledOnce();
    expect(harness.disposePreparedDcodeRebuildImageSpy).toHaveBeenCalledWith(
      harness.preparedDcodeBuildContext,
    );
    expectNoDcodeMutation(harness);
  });

  it("disposes the prepared DCode image when the final route recheck fails (#6195)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: makeDcodeSandboxEntry(),
      dcodeRouteResults: [
        { ok: true },
        { ok: false, detail: "existing sandbox inference probe returned HTTP 401" },
      ],
    });
    configureDcodeSession(harness);

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Recorded inference route smoke check failed");

    expect(harness.preflightDcodeRouteSpy).toHaveBeenCalledTimes(2);
    expect(harness.prepareManagedDcodeRebuildImageSpy).toHaveBeenCalledOnce();
    expect(harness.disposePreparedDcodeRebuildImageSpy).toHaveBeenCalledWith(
      harness.preparedDcodeBuildContext,
    );
    expectNoDcodeMutation(harness);
  });

  it("preserves the live DCode sandbox when its registry target drifts after backup (#6195)", async () => {
    const originalEntry = makeDcodeSandboxEntry();
    const driftedEntry = { ...originalEntry, model: "nvidia/changed-at-delete-edge" };
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: originalEntry,
      sandboxEntryReads: [
        originalEntry, // Initial rebuild target.
        originalEntry, // Messaging-conflict gateway selection (#5954).
        originalEntry, // Prepared DCode target capture.
        originalEntry, // Final pre-backup target verification.
        originalEntry, // Delete-edge target verification input.
        driftedEntry, // Registry reread at the destructive boundary.
      ],
      dcodeRouteResults: [{ ok: true }, { ok: true }, { ok: true }],
    });
    configureDcodeSession(harness);

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("the recorded sandbox target changed during preflight");

    expect(harness.openShieldsSpy).toHaveBeenCalledOnce();
    expect(harness.backupSandboxStateSpy).toHaveBeenCalledOnce();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(harness.removeSandboxRegistryEntrySpy).not.toHaveBeenCalled();
    expect(harness.onboardSpy).not.toHaveBeenCalled();
    expect(harness.relockSpy).toHaveBeenCalledWith("alpha", expect.any(Object), true, "nemoclaw");
    expect(harness.disposePreparedDcodeRebuildImageSpy).toHaveBeenCalledWith(
      harness.preparedDcodeBuildContext,
    );
  });

  it("preserves the live DCode sandbox when its credential route drifts after backup (#6195)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: makeDcodeSandboxEntry(),
      dcodeRouteResults: [
        { ok: true },
        { ok: true },
        { ok: false, detail: "existing sandbox inference probe returned HTTP 401" },
      ],
    });
    configureDcodeSession(harness);

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Recorded inference route smoke check failed");

    expect(harness.preflightDcodeRouteSpy).toHaveBeenCalledTimes(3);
    expect(harness.openShieldsSpy).toHaveBeenCalledOnce();
    expect(harness.backupSandboxStateSpy).toHaveBeenCalledOnce();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(harness.removeSandboxRegistryEntrySpy).not.toHaveBeenCalled();
    expect(harness.onboardSpy).not.toHaveBeenCalled();
    expect(harness.relockSpy).toHaveBeenCalledWith("alpha", expect.any(Object), true, "nemoclaw");
    expect(harness.disposePreparedDcodeRebuildImageSpy).toHaveBeenCalledWith(
      harness.preparedDcodeBuildContext,
    );
  });

  it("preserves live DCode when retained replacement inputs drift after backup (#6195)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: makeDcodeSandboxEntry(),
      dcodeRouteResults: [{ ok: true }, { ok: true }, { ok: true }],
      dcodeImageVerificationResults: [true, false],
    });
    configureDcodeSession(harness);

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("the prepared DCode replacement inputs changed before deletion");

    expect(harness.openShieldsSpy).toHaveBeenCalledOnce();
    expect(harness.backupSandboxStateSpy).toHaveBeenCalledOnce();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(harness.removeSandboxRegistryEntrySpy).not.toHaveBeenCalled();
    expect(harness.onboardSpy).not.toHaveBeenCalled();
    expect(harness.relockSpy).toHaveBeenCalledWith("alpha", expect.any(Object), true, "nemoclaw");
    expect(harness.disposePreparedDcodeRebuildImageSpy).toHaveBeenCalledWith(
      harness.preparedDcodeBuildContext,
    );
  });

  it("preserves live DCode when its pinned base image drifts after backup (#6195)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: makeDcodeSandboxEntry(),
      dcodeRouteResults: [{ ok: true }, { ok: true }, { ok: true }],
      dcodeBaseImageIds: ["sha256:dcode-base", "sha256:dcode-base", "sha256:changed"],
    });
    configureDcodeSession(harness);

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("the prepared DCode replacement inputs changed before deletion");

    expect(harness.openShieldsSpy).toHaveBeenCalledOnce();
    expect(harness.backupSandboxStateSpy).toHaveBeenCalledOnce();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(harness.removeSandboxRegistryEntrySpy).not.toHaveBeenCalled();
    expect(harness.onboardSpy).not.toHaveBeenCalled();
    expect(harness.relockSpy).toHaveBeenCalledWith("alpha", expect.any(Object), true, "nemoclaw");
    expect(harness.disposePreparedDcodeRebuildImageSpy).toHaveBeenCalledWith(
      harness.preparedDcodeBuildContext,
    );
  });

  it("restores the prior gateway and disposes DCode inputs when shields opening throws (#6195)", async () => {
    const restoreEnv = snapshotEnv(["OPENSHELL_GATEWAY"]);
    process.env.OPENSHELL_GATEWAY = "previous-gateway";
    let gatewayAtShields: string | undefined;

    try {
      const harness = createRebuildFlowHarness({
        agentName: "langchain-deepagents-code",
        sandboxEntry: makeDcodeSandboxEntry(),
        dcodeRouteResults: [{ ok: true }, { ok: true }],
        openShieldsWindow: () => {
          gatewayAtShields = process.env.OPENSHELL_GATEWAY;
          throw new Error("shields opening threw unexpectedly");
        },
      });
      configureDcodeSession(harness);

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("shields opening threw unexpectedly");

      expect(gatewayAtShields).toBe("nemoclaw");
      expect(process.env.OPENSHELL_GATEWAY).toBe("previous-gateway");
      expect(harness.prepareManagedDcodeRebuildImageSpy).toHaveBeenCalledOnce();
      expect(harness.openShieldsSpy).toHaveBeenCalledOnce();
      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
        ["sandbox", "delete", "alpha"],
        expect.anything(),
      );
      expect(harness.onboardSpy).not.toHaveBeenCalled();
      expect(harness.disposePreparedDcodeRebuildImageSpy).toHaveBeenCalledWith(
        harness.preparedDcodeBuildContext,
      );
    } finally {
      restoreEnv();
    }
  });

  it("finishes DCode preparation and recheck before backup, delete, and recreate (#6195)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: makeDcodeSandboxEntry(),
      dcodeRouteResults: [{ ok: true }, { ok: true }, { ok: true }],
    });
    configureDcodeSession(harness);

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.preflightDcodeRouteSpy).toHaveBeenCalledTimes(3);
    expect(harness.prepareManagedDcodeRebuildImageSpy).toHaveBeenCalledOnce();
    expect(harness.onboardSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "langchain-deepagents-code",
        preparedDcodeRebuild: expect.objectContaining({
          buildContext: harness.preparedDcodeBuildContext,
          gatewayName: "nemoclaw",
        }),
      }),
    );

    const [firstRouteOrder, preBackupRouteOrder, deleteEdgeRouteOrder] =
      harness.preflightDcodeRouteSpy.mock.invocationCallOrder;
    const imageOrder = harness.prepareManagedDcodeRebuildImageSpy.mock.invocationCallOrder[0];
    const shieldsOrder = harness.openShieldsSpy.mock.invocationCallOrder[0];
    const backupOrder = harness.backupSandboxStateSpy.mock.invocationCallOrder[0];
    const deleteCall = harness.runOpenshellSpy.mock.calls.findIndex(
      ([args]) => Array.isArray(args) && args.join(" ") === "sandbox delete alpha",
    );
    const deleteOrder = harness.runOpenshellSpy.mock.invocationCallOrder[deleteCall];
    const onboardOrder = harness.onboardSpy.mock.invocationCallOrder[0];

    expect(firstRouteOrder).toBeLessThan(imageOrder);
    expect(imageOrder).toBeLessThan(preBackupRouteOrder);
    expect(preBackupRouteOrder).toBeLessThan(shieldsOrder);
    expect(shieldsOrder).toBeLessThan(backupOrder);
    expect(backupOrder).toBeLessThan(deleteEdgeRouteOrder);
    expect(deleteEdgeRouteOrder).toBeLessThan(deleteOrder);
    expect(deleteOrder).toBeLessThan(onboardOrder);
    expect(harness.disposePreparedDcodeRebuildImageSpy).toHaveBeenCalledWith(
      harness.preparedDcodeBuildContext,
    );
  });

  it("recreates non-Ready DCode from a validated backup without requiring a live route (#6195)", async () => {
    const recoveryManifest = {
      ...makePreparedRecoveryManifest(),
      agentType: "langchain-deepagents-code",
      agentVersion: "0.1.12",
      dir: "/sandbox/.deepagents",
    };
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: makeDcodeSandboxEntry(),
      sandboxListOutput: "alpha Error",
      preDeleteLatestManifest: recoveryManifest,
    });
    configureDcodeSession(harness);

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest,
      }),
    ).resolves.toBeUndefined();

    expect(harness.preflightDcodeRouteSpy).not.toHaveBeenCalled();
    expect(harness.prepareManagedDcodeRebuildImageSpy).toHaveBeenCalledOnce();
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(harness.onboardSpy).toHaveBeenCalledOnce();
    expect(harness.restoreSandboxStateSpy).toHaveBeenCalledWith(
      "alpha",
      recoveryManifest.backupPath,
    );
  });
});
