// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  configureDcodeSession,
  expectNoDcodeMutation,
  makeDcodeSandboxEntry,
  setGatewayProviderMetadata,
} from "../../../../test/helpers/rebuild-dcode-flow-helpers";
import {
  createRebuildFlowHarness,
  makePreparedRecoveryManifest,
  resetRebuildFlowTestEnvironment,
  restoreRebuildFlowTestEnvironment,
  snapshotEnv,
} from "../../../../test/helpers/rebuild-flow-harness";

describe("rebuildSandbox DCode recovered provider", () => {
  beforeEach(resetRebuildFlowTestEnvironment);
  afterEach(restoreRebuildFlowTestEnvironment);

  it("rejects incompatible keyless provider reuse after the live DCode route proof", async () => {
    const restoreEnv = snapshotEnv(["COMPATIBLE_API_KEY"]);
    delete process.env.COMPATIBLE_API_KEY;

    try {
      const harness = createRebuildFlowHarness({
        agentName: "langchain-deepagents-code",
        sandboxEntry: makeDcodeSandboxEntry(),
        dcodeRouteResults: [{ ok: true }, { ok: true }],
      });
      configureDcodeSession(harness);
      setGatewayProviderMetadata(
        harness,
        "Name: compatible-endpoint\nType: anthropic\nCredential keys: COMPATIBLE_API_KEY\nConfig keys: OPENAI_BASE_URL\n",
      );

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("Unsafe gateway credential reuse");

      expect(harness.preflightDcodeRouteSpy).toHaveBeenCalledTimes(2);
      expect(harness.prepareManagedDcodeRebuildImageSpy).toHaveBeenCalledOnce();
      expect(harness.disposePreparedDcodeRebuildImageSpy).toHaveBeenCalledWith(
        harness.preparedDcodeBuildContext,
      );
      expectNoDcodeMutation(harness);
    } finally {
      restoreEnv();
    }
  });

  it("rejects incomplete keyless provider reuse for backup recovery before deletion", async () => {
    const restoreEnv = snapshotEnv(["COMPATIBLE_API_KEY"]);
    delete process.env.COMPATIBLE_API_KEY;
    const recoveryManifest = {
      ...makePreparedRecoveryManifest(),
      agentType: "langchain-deepagents-code",
      agentVersion: "0.1.12",
      dir: "/sandbox/.deepagents",
    };

    try {
      const harness = createRebuildFlowHarness({
        agentName: "langchain-deepagents-code",
        sandboxEntry: makeDcodeSandboxEntry(),
        sandboxListOutput: "alpha Error",
        preDeleteLatestManifest: recoveryManifest,
      });
      configureDcodeSession(harness);
      setGatewayProviderMetadata(
        harness,
        "Name: compatible-endpoint\nType: openai\nCredential keys: COMPATIBLE_API_KEY\n",
      );

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], {
          throwOnError: true,
          recoveryManifest,
        }),
      ).rejects.toThrow("Unsafe gateway credential reuse");

      expect(harness.preflightDcodeRouteSpy).not.toHaveBeenCalled();
      expect(harness.prepareManagedDcodeRebuildImageSpy).toHaveBeenCalledOnce();
      expect(harness.disposePreparedDcodeRebuildImageSpy).toHaveBeenCalledWith(
        harness.preparedDcodeBuildContext,
      );
      expectNoDcodeMutation(harness);
    } finally {
      restoreEnv();
    }
  });
});
