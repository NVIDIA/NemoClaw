// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configureDcodeSession,
  expectNoDcodeMutation,
  makeDcodeSandboxEntry,
} from "../../../../test/helpers/rebuild-dcode-flow-support";
import {
  createRebuildFlowHarness,
  resetRebuildFlowTestEnvironment,
  restoreRebuildFlowTestEnvironment,
  snapshotEnv,
} from "../../../../test/helpers/rebuild-flow-harness";

describe("rebuildSandbox DCode flow: preflight", () => {
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
  it("rejects a registry-owned DCode custom Dockerfile before image preparation (#6195)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: {
        ...makeDcodeSandboxEntry(),
        fromDockerfile: "/tmp/registry-owned-custom.Dockerfile",
      },
    });
    configureDcodeSession(harness);

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Managed DCode rebuild cannot use a recorded custom Dockerfile");

    expect(harness.prepareManagedDcodeRebuildImageSpy).not.toHaveBeenCalled();
    expectNoDcodeMutation(harness);
  });
  it("lets explicit registry-managed DCode state override stale session Dockerfile metadata (#6195)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: { ...makeDcodeSandboxEntry(), fromDockerfile: null },
    });
    configureDcodeSession(harness);
    harness.session.metadata = { fromDockerfile: "/tmp/stale-session.Dockerfile" };

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.prepareManagedDcodeRebuildImageSpy).toHaveBeenCalledOnce();
    expect(harness.onboardSpy).toHaveBeenCalledWith(
      expect.objectContaining({ fromDockerfile: null }),
    );
  });
});
