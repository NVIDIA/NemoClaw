// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureDcodeSession,
  expectNoDcodeMutation,
  makeDcodeSandboxEntry,
} from "../../../../test/helpers/rebuild-dcode-flow-support";
import {
  createRebuildFlowHarness,
  resetRebuildFlowTestEnvironment,
  restoreRebuildFlowTestEnvironment,
} from "../../../../test/helpers/rebuild-flow-harness";
import { revalidateDcodeReplacementAtMutationEdge } from "./rebuild-dcode-preflight";

describe("rebuildSandbox DCode flow: pre-delete drift", () => {
  beforeEach(resetRebuildFlowTestEnvironment);
  afterEach(restoreRebuildFlowTestEnvironment);

  it("rejects prepared-image tool-disclosure drift before gateway or mutation work", async () => {
    const checkGatewaySchema = vi.fn(() => true);
    const verify = vi.fn(() => true);
    const dispose = vi.fn(() => true);

    await expect(
      revalidateDcodeReplacementAtMutationEdge({
        sandboxName: "alpha",
        entry: {
          name: "alpha",
          agent: "langchain-deepagents-code",
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
        },
        resumeConfig: {
          agent: "langchain-deepagents-code",
          provider: "compatible-endpoint",
          model: "nvidia/nemotron-3-super-120b-a12b",
          endpointUrl: "https://inference-api.nvidia.com/v1",
          credentialEnv: "COMPATIBLE_API_KEY",
          preferredInferenceApi: "openai-completions",
          compatibleEndpointReasoning: "false",
          nimContainer: null,
          pinEndpoint: true,
          registryInferenceRoute: null,
          ambient: { presentVars: [], agentMismatch: null },
        },
        toolDisclosure: "direct",
        dcodeAutoApprovalMode: "disabled",
        skipLiveRoute: true,
        gatewayPort: 8080,
        log: vi.fn(),
        bail: (message): never => {
          throw new Error(message);
        },
        checkGatewaySchema,
        replacement: {
          buildContext: {} as never,
          gatewayName: "nemoclaw",
          toolDisclosure: "progressive",
          dcodeAutoApprovalMode: "disabled",
          verify,
          dispose,
        },
      }),
    ).rejects.toThrow("prepared DCode tool-disclosure mode changed before deletion");

    expect(checkGatewaySchema).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });

  it("rejects prepared-image DCode auto-approval drift before gateway or mutation work (#6478)", async () => {
    const checkGatewaySchema = vi.fn(() => true);
    const verify = vi.fn(() => true);

    await expect(
      revalidateDcodeReplacementAtMutationEdge({
        sandboxName: "alpha",
        entry: {
          name: "alpha",
          agent: "langchain-deepagents-code",
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
        },
        resumeConfig: {
          agent: "langchain-deepagents-code",
          provider: "compatible-endpoint",
          model: "nvidia/nemotron-3-super-120b-a12b",
          endpointUrl: "https://inference-api.nvidia.com/v1",
          credentialEnv: "COMPATIBLE_API_KEY",
          preferredInferenceApi: "openai-completions",
          compatibleEndpointReasoning: "false",
          nimContainer: null,
          pinEndpoint: true,
          registryInferenceRoute: null,
          ambient: { presentVars: [], agentMismatch: null },
        },
        toolDisclosure: "progressive",
        dcodeAutoApprovalMode: "thread-opt-in",
        skipLiveRoute: true,
        gatewayPort: 8080,
        log: vi.fn(),
        bail: (message): never => {
          throw new Error(message);
        },
        checkGatewaySchema,
        replacement: {
          buildContext: {} as never,
          gatewayName: "nemoclaw",
          toolDisclosure: "progressive",
          dcodeAutoApprovalMode: "disabled",
          verify,
          dispose: vi.fn(() => true),
        },
      }),
    ).rejects.toThrow("prepared DCode auto-approval mode changed before deletion");

    expect(checkGatewaySchema).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it("rejects registry drift during the final DCode preflight before shields and backup (#6195)", async () => {
    const originalEntry = makeDcodeSandboxEntry();
    const driftedEntry = { ...originalEntry, model: "nvidia/changed-during-preflight" };
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: originalEntry,
      sandboxEntryReads: [
        originalEntry, // Initial rebuild target.
        originalEntry, // Exact post-confirmation lock guard.
        originalEntry, // Messaging config hydration.
        originalEntry, // Messaging-conflict gateway lookup (#5954).
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
        originalEntry, // Exact post-confirmation lock guard.
        originalEntry, // Messaging config hydration.
        originalEntry, // Messaging-conflict gateway lookup (#5954).
        originalEntry, // Final pre-backup target verification.
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
});
