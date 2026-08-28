// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import {
  expectFailedHardeningRefusesForcedCleanup,
  expectShieldsRecoveryOrder,
} from "../../../../test/helpers/destroy-flow-test-assertions";
import {
  createDestroyHarness,
  resetDestroyModuleCache,
} from "../../../../test/helpers/destroy-flow-test-harness";
import { SANDBOX_DESTROY_TIMEOUT_MS } from "./destroy-gateway";

describe("destroy timeout recovery", () => {
  let exitSpy: MockInstance;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetDestroyModuleCache();
  });

  it.each([false, true])(
    "sets a 60-second delete timeout and preserves a registered sandbox with force=%s (#10106)",
    async (force) => {
      const deleteError = Object.assign(new Error("OpenShell delete exceeded its deadline"), {
        code: "ETIMEDOUT",
      });
      const harness = createDestroyHarness({
        deleteError,
        deleteStatus: null,
        dockerRunResult: { status: 0, stdout: "" },
        registeredSandboxCount: 1,
      });

      await expect(harness.destroySandbox("alpha", { force, yes: true })).rejects.toThrow(
        "process.exit(1)",
      );

      expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
        ["sandbox", "delete", "alpha"],
        expect.objectContaining({
          killSignal: "SIGKILL",
          timeout: SANDBOX_DESTROY_TIMEOUT_MS,
        }),
      );
      const errorOutput = harness.errorSpy.mock.calls
        .map(([message]) => String(message))
        .join("\n");
      expect(errorOutput).toContain("OpenShell sandbox delete timed out after 60 seconds");
      expect(errorOutput).toContain("--force cannot discard the record after a timeout");
      expect(errorOutput).not.toContain("re-run with --force to remove the local sandbox record");
      expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    },
  );

  it("stops when workspace cleanup times out before sandbox deletion (#10106)", async () => {
    const wipeError = Object.assign(new Error("OpenShell exec exceeded its deadline"), {
      code: "ETIMEDOUT",
    });
    const harness = createDestroyHarness({
      dockerRunResult: { status: 0, stdout: "" },
      mcpServers: ["github"],
      registeredSandboxCount: 1,
      wipeError,
      wipeStatus: null,
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      expect.arrayContaining(["sandbox", "exec", "--name", "alpha"]),
      expect.objectContaining({
        killSignal: "SIGKILL",
        timeout: SANDBOX_DESTROY_TIMEOUT_MS,
      }),
    );
    expect(harness.events).toEqual(["mcp-prepare", "wipe", "mcp-restore"]);
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    const errorOutput = harness.errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
    expect(errorOutput).toContain("OpenShell workspace cleanup timed out after 60 seconds");
    expect(errorOutput).toContain("nemoclaw alpha status");
    expect(errorOutput).toContain("then retry destroy");
  });

  it("requires Shields recovery when workspace cleanup times out with an active timer (#10106)", async () => {
    const wipeError = Object.assign(new Error("OpenShell exec exceeded its deadline"), {
      code: "ETIMEDOUT",
    });
    const harness = createDestroyHarness({
      activeTimer: true,
      registeredSandboxCount: 1,
      wipeError,
      wipeStatus: null,
    });

    await expect(harness.destroySandbox("alpha", { force: true, yes: true })).rejects.toThrow(
      "process.exit(1)",
    );

    const errorOutput = harness.errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
    expect(errorOutput).toContain("workspace cleanup timeout left an active shields timer");
    expectShieldsRecoveryOrder(errorOutput);
    expect(errorOutput).toContain("--force cannot safely discard a record while shields recovery");
    expect(harness.killTimerSpy).not.toHaveBeenCalled();
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
  });

  it("requires Shields recovery when deletion times out after failed re-lock (#10106)", async () => {
    const deleteError = Object.assign(new Error("OpenShell delete exceeded its deadline"), {
      code: "ETIMEDOUT",
    });
    const harness = createDestroyHarness({
      activeTimer: true,
      deleteError,
      deleteStatus: null,
      registeredSandboxCount: 1,
      shieldsUpError: new Error("injected hardening failure"),
    });

    await expect(harness.destroySandbox("alpha", { force: true, yes: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expectFailedHardeningRefusesForcedCleanup(harness);
    const errorOutput = harness.errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
    expect(errorOutput).toContain("OpenShell sandbox delete timed out after 60 seconds");
    expect(errorOutput).not.toContain("--force cannot discard the record after a timeout");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
