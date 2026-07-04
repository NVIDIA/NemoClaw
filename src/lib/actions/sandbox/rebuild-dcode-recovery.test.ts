// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configureDcodeSession,
  makeDcodeSandboxEntry,
} from "../../../../test/helpers/rebuild-dcode-flow-support";
import {
  createRebuildFlowHarness,
  makePreparedRecoveryManifest,
  resetRebuildFlowTestEnvironment,
  restoreRebuildFlowTestEnvironment,
} from "../../../../test/helpers/rebuild-flow-harness";

describe("rebuildSandbox DCode flow: recovery", () => {
  beforeEach(resetRebuildFlowTestEnvironment);
  afterEach(restoreRebuildFlowTestEnvironment);

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
  it("replays captured custom policies during stale DCode recovery without a backup (#6195)", async () => {
    const customPolicy = {
      name: "custom-egress",
      content: "network_policies:\n  custom-egress: {}\n",
      sourcePath: "/tmp/custom-egress.yaml",
    };
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: {
        ...makeDcodeSandboxEntry(),
        customPolicies: [customPolicy],
        policyPresetsFinalized: true,
      },
      sandboxListOutput: "",
      reconciledSandboxGatewayState: { state: "missing", output: "" },
    });
    configureDcodeSession(harness);

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.applyPresetSpy).not.toHaveBeenCalled();
    expect(harness.applyPresetContentSpy).toHaveBeenCalledWith(
      "alpha",
      customPolicy.name,
      customPolicy.content,
      { custom: { sourcePath: customPolicy.sourcePath } },
    );
    expect(harness.registryUpdateSpy).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ policies: [], policyPresetsFinalized: true }),
    );
  });
});
