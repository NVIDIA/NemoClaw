// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDestroyHarness,
  resetDestroyModuleCache,
} from "../../../../test/helpers/destroy-flow-test-harness";
import { testTimeoutOptions } from "../../../../test/helpers/timeouts";
import type { SandboxDestroyExecutionResult } from "./destroy-execution";

const TERMINATING_ALPHA_LIST =
  "NAME              CREATED              PHASE\nalpha             now                  Terminating\n";
const READY_BETA_LIST =
  "NAME              CREATED              PHASE\nbeta              now                  Ready\n";
const SUCCESSFUL_DESTROY_RESULT: SandboxDestroyExecutionResult = {
  ok: true,
  alreadyGone: false,
  deleteOutput: "",
  deleteResult: { kind: "accepted", diagnostic: "", exitCode: 0 },
  detachOutcome: { detached: [], failures: [] },
  forcedLocalCleanup: false,
};

function warnOutput(harness: ReturnType<typeof createDestroyHarness>): string {
  return harness.warnSpy.mock.calls.map((call) => String(call[0])).join("\n");
}

describe("destroySandbox final gateway decision", testTimeoutOptions(30_000), () => {
  let originalGatewayEnv: string | undefined;

  beforeEach(() => {
    originalGatewayEnv = process.env.OPENSHELL_GATEWAY;
  });

  afterEach(() => {
    originalGatewayEnv === undefined
      ? delete process.env.OPENSHELL_GATEWAY
      : (process.env.OPENSHELL_GATEWAY = originalGatewayEnv);
    vi.restoreAllMocks();
    resetDestroyModuleCache();
  });

  it("waits for the deleted sandbox to leave the live list before applying --cleanup-gateway", async () => {
    const harness = createDestroyHarness({
      executeSandboxDestroyResult: SUCCESSFUL_DESTROY_RESULT,
    });
    harness.captureOpenshellSpy
      .mockReturnValueOnce({ status: 0, output: TERMINATING_ALPHA_LIST })
      .mockReturnValue({ status: 0, output: "" });

    await expect(
      harness.destroySandbox("alpha", { yes: true, cleanupGateway: true }),
    ).resolves.toBeUndefined();

    expect(harness.captureOpenshellSpy).toHaveBeenCalledTimes(2);
    expect(harness.finalGatewaySleepSpy).toHaveBeenCalledOnce();
    expect(harness.cleanupGatewaySpy).toHaveBeenCalledWith(
      "nemoclaw-19080",
      harness.runOpenshellSpy,
    );
    expect(warnOutput(harness)).not.toContain("gateway left running");
  });

  it("skips final live-sandbox probes when gateway cleanup is disabled", async () => {
    const harness = createDestroyHarness({
      executeSandboxDestroyResult: SUCCESSFUL_DESTROY_RESULT,
      liveListOutput: TERMINATING_ALPHA_LIST,
    });

    await expect(
      harness.destroySandbox("alpha", { yes: true, cleanupGateway: false }),
    ).resolves.toBeUndefined();

    expect(harness.captureOpenshellSpy).not.toHaveBeenCalled();
    expect(harness.finalGatewaySleepSpy).not.toHaveBeenCalled();
    expect(harness.cleanupGatewaySpy).not.toHaveBeenCalled();
    expect(harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "Shared NemoClaw gateway preserved",
    );
  });

  it("reports the live sandbox that blocks --cleanup-gateway after the last registered destroy", async () => {
    const harness = createDestroyHarness({
      executeSandboxDestroyResult: SUCCESSFUL_DESTROY_RESULT,
      liveListOutput: READY_BETA_LIST,
    });

    await expect(
      harness.destroySandbox("alpha", { yes: true, cleanupGateway: true }),
    ).resolves.toBeUndefined();

    expect(harness.finalGatewaySleepSpy).not.toHaveBeenCalled();
    expect(harness.cleanupGatewaySpy).not.toHaveBeenCalled();
    expect(warnOutput(harness)).toContain("Shared NemoClaw gateway left running");
    expect(warnOutput(harness)).toContain("--cleanup-gateway was not applied");
    expect(warnOutput(harness)).toContain("OpenShell still reports sandbox 'beta'");
    expect(warnOutput(harness)).toContain("openshell sandbox list -g nemoclaw-19080");
    expect(warnOutput(harness)).toContain("openshell gateway remove nemoclaw-19080");
    expect(harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain(
      "Shared NemoClaw gateway preserved",
    );
  });

  it("reports a failed live list when gateway cleanup is explicitly requested", async () => {
    const harness = createDestroyHarness({
      executeSandboxDestroyResult: SUCCESSFUL_DESTROY_RESULT,
    });
    harness.captureOpenshellSpy.mockReturnValue({ status: 1, output: "transport error" });

    await expect(
      harness.destroySandbox("alpha", { yes: true, cleanupGateway: true }),
    ).resolves.toBeUndefined();

    expect(harness.captureOpenshellSpy).toHaveBeenCalledOnce();
    expect(harness.cleanupGatewaySpy).not.toHaveBeenCalled();
    expect(warnOutput(harness)).toContain("Shared NemoClaw gateway left running");
    expect(warnOutput(harness)).toContain("--cleanup-gateway was not applied");
    expect(warnOutput(harness)).toContain("'openshell sandbox list' failed");
    expect(warnOutput(harness)).toContain("openshell sandbox list -g nemoclaw-19080");
    expect(warnOutput(harness)).toContain("openshell gateway remove nemoclaw-19080");
  });

  it("reports a sandbox registered between the initial and final cleanup checks", async () => {
    const harness = createDestroyHarness({
      executeSandboxDestroyResult: SUCCESSFUL_DESTROY_RESULT,
      finalGatewayRegisteredSandboxCount: 1,
    });

    await expect(
      harness.destroySandbox("alpha", { yes: true, cleanupGateway: true }),
    ).resolves.toBeUndefined();

    expect(harness.captureOpenshellSpy).not.toHaveBeenCalled();
    expect(harness.cleanupGatewaySpy).not.toHaveBeenCalled();
    expect(warnOutput(harness)).toContain("Shared NemoClaw gateway left running");
    expect(warnOutput(harness)).toContain("--cleanup-gateway was not applied");
    expect(warnOutput(harness)).toContain(
      "the local sandbox registry no longer confirms this was the last sandbox",
    );
  });
});
