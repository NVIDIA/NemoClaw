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
  snapshotEnv,
} from "../../../../test/helpers/rebuild-flow-harness";

const overrideEnvName = "NEMOCLAW_LANGCHAIN_DEEPAGENTS_CODE_SANDBOX_BASE_IMAGE_REF";
const trustedLocalOverride = {
  ref: "nemoclaw-langchain-deepagents-code-base:test",
  provenance: `${"b".repeat(64)}.${"c".repeat(64)}`,
};

describe("rebuildSandbox DCode flow: base-image trust lease", () => {
  beforeEach(resetRebuildFlowTestEnvironment);
  afterEach(restoreRebuildFlowTestEnvironment);

  it("keeps the current base-image trust lease active through replacement preparation (#6195)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: makeDcodeSandboxEntry(),
    });
    configureDcodeSession(harness);
    let leaseActive = false;
    harness.restoreTrustedAgentBaseImageOverrideSpy.mockImplementation(() => {
      leaseActive = false;
    });
    harness.pinTrustedAgentBaseImageOverrideForOperationSpy.mockImplementation(() => {
      leaseActive = true;
      return harness.restoreTrustedAgentBaseImageOverrideSpy;
    });
    harness.prepareManagedDcodeRebuildImageSpy.mockImplementation(async () => {
      expect(leaseActive).toBe(true);
      expect(process.env[overrideEnvName]).toBe(trustedLocalOverride.ref);
      return { ok: true, prepared: harness.preparedDcodeBuildContext };
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.pinTrustedAgentBaseImageOverrideForOperationSpy).toHaveBeenCalledWith(
      overrideEnvName,
      trustedLocalOverride,
    );
    expect(harness.restoreTrustedAgentBaseImageOverrideSpy).toHaveBeenCalledOnce();
    expect(leaseActive).toBe(false);
  });

  it("restores the base-image trust lease when replacement preparation throws (#6195)", async () => {
    const restoreEnv = snapshotEnv([overrideEnvName]);
    process.env[overrideEnvName] = "caller-selected-base:current";
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: makeDcodeSandboxEntry(),
    });
    configureDcodeSession(harness);
    let leaseActive = false;
    harness.restoreTrustedAgentBaseImageOverrideSpy.mockImplementation(() => {
      leaseActive = false;
    });
    harness.pinTrustedAgentBaseImageOverrideForOperationSpy.mockImplementation(() => {
      leaseActive = true;
      return harness.restoreTrustedAgentBaseImageOverrideSpy;
    });
    harness.prepareManagedDcodeRebuildImageSpy.mockImplementation(async () => {
      expect(leaseActive).toBe(true);
      expect(process.env[overrideEnvName]).toBe(trustedLocalOverride.ref);
      throw new Error("fixture preparation failed");
    });

    try {
      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("fixture preparation failed");

      expect(harness.pinTrustedAgentBaseImageOverrideForOperationSpy).toHaveBeenCalledWith(
        overrideEnvName,
        trustedLocalOverride,
      );
      expect(harness.restoreTrustedAgentBaseImageOverrideSpy).toHaveBeenCalledOnce();
      expect(leaseActive).toBe(false);
      expect(process.env[overrideEnvName]).toBe("caller-selected-base:current");
    } finally {
      restoreEnv();
    }
  });
});
