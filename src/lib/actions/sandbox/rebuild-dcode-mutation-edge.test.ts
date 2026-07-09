// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configureDcodeSession,
  makeDcodeSandboxEntry,
} from "../../../../test/helpers/rebuild-dcode-flow-support";
import {
  createRebuildFlowHarness,
  resetRebuildFlowTestEnvironment,
  restoreRebuildFlowTestEnvironment,
} from "../../../../test/helpers/rebuild-flow-harness";

describe("rebuildSandbox DCode flow: mutation edge", () => {
  beforeEach(resetRebuildFlowTestEnvironment);
  afterEach(restoreRebuildFlowTestEnvironment);

  it("finishes DCode preparation and recheck before backup, delete, and recreate (#6195)", async () => {
    const mcpEntry = { server: "search", providerName: "mcp-search" };
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: makeDcodeSandboxEntry(),
      dcodeRouteResults: [{ ok: true }, { ok: true }, { ok: true }, { ok: true }],
      mcpPreparation: {
        entries: [mcpEntry],
        detachedProviderEntries: [],
        scrubbedAdapterEntries: [],
      },
    });
    configureDcodeSession(harness);

    await expect(
      harness.rebuildSandbox(
        "alpha",
        ["--yes", "--tool-disclosure", "direct", "--dcode-auto-approval", "thread-opt-in"],
        {
          throwOnError: true,
        },
      ),
    ).resolves.toBeUndefined();

    expect(harness.preflightDcodeRouteSpy).toHaveBeenCalledTimes(4);
    expect(harness.prepareManagedDcodeRebuildImageSpy).toHaveBeenCalledOnce();
    expect(harness.prepareManagedDcodeRebuildImageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        compatibleEndpointReasoning: null,
        dcodeAutoApprovalMode: "thread-opt-in",
        toolDisclosure: "direct",
        webSearchConfig: null,
      }),
    );
    expect(harness.onboardSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "langchain-deepagents-code",
        dcodeAutoApprovalMode: "thread-opt-in",
        dcodeAutoApprovalRequestedExplicitly: true,
        toolDisclosure: "direct",
        preparedDcodeRebuild: expect.objectContaining({
          buildContext: harness.preparedDcodeBuildContext,
          dcodeAutoApprovalMode: "thread-opt-in",
          gatewayName: "nemoclaw",
        }),
      }),
    );

    const [firstRouteOrder, preBackupRouteOrder, preMcpRouteOrder, deleteEdgeRouteOrder] =
      harness.preflightDcodeRouteSpy.mock.invocationCallOrder;
    const imageOrder = harness.prepareManagedDcodeRebuildImageSpy.mock.invocationCallOrder[0];
    const shieldsOrder = harness.openShieldsSpy.mock.invocationCallOrder[0];
    const backupOrder = harness.backupSandboxStateSpy.mock.invocationCallOrder[0];
    const mcpPreparationOrder = harness.prepareMcpBridgesForRebuildSpy.mock.invocationCallOrder[0];
    const warningProbeOrder =
      harness.warnUnpreservedUserManagedFilesSpy.mock.invocationCallOrder[0];
    const deleteCall = harness.runOpenshellSpy.mock.calls.findIndex(
      ([args]) => Array.isArray(args) && args.join(" ") === "sandbox delete alpha",
    );
    const deleteOrder = harness.runOpenshellSpy.mock.invocationCallOrder[deleteCall];
    const onboardOrder = harness.onboardSpy.mock.invocationCallOrder[0];

    expect(firstRouteOrder).toBeLessThan(imageOrder);
    expect(imageOrder).toBeLessThan(preBackupRouteOrder);
    expect(preBackupRouteOrder).toBeLessThan(shieldsOrder);
    expect(shieldsOrder).toBeLessThan(backupOrder);
    expect(backupOrder).toBeLessThan(preMcpRouteOrder);
    expect(preMcpRouteOrder).toBeLessThan(mcpPreparationOrder);
    expect(mcpPreparationOrder).toBeLessThan(warningProbeOrder);
    expect(warningProbeOrder).toBeLessThan(deleteEdgeRouteOrder);
    expect(deleteEdgeRouteOrder).toBeLessThan(deleteOrder);
    expect(deleteOrder).toBeLessThan(onboardOrder);
    expect(harness.disposePreparedDcodeRebuildImageSpy).toHaveBeenCalledWith(
      harness.preparedDcodeBuildContext,
    );
    expect(harness.restoreMcpBridgesAfterRebuildSpy).toHaveBeenCalledWith("alpha", [mcpEntry]);
  });
  it("rolls back managed MCP mutation when DCode inputs drift during MCP preparation (#6195)", async () => {
    const detached = { server: "search", providerName: "mcp-search" };
    const scrubbed = { server: "filesystem", adapter: "deepagents-config" };
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: makeDcodeSandboxEntry(),
      dcodeRouteResults: [{ ok: true }, { ok: true }, { ok: true }, { ok: true }],
      dcodeImageVerificationResults: [true, true, false],
      mcpPreparation: {
        entries: [detached],
        detachedProviderEntries: [detached],
        scrubbedAdapterEntries: [scrubbed],
      },
    });
    configureDcodeSession(harness);

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("the prepared DCode replacement inputs changed before deletion");

    expect(harness.prepareMcpBridgesForRebuildSpy).toHaveBeenCalledWith("alpha");
    expect(harness.reattachMcpProvidersAfterRebuildAbortSpy).toHaveBeenCalledWith(
      "alpha",
      [detached],
      [scrubbed],
    );
    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(harness.onboardSpy).not.toHaveBeenCalled();
    expect(harness.relockSpy).toHaveBeenCalledWith("alpha", expect.any(Object), true, "nemoclaw");
  });
});
