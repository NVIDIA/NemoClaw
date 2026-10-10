// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as restoreWindow from "../actions/sandbox/runtime/openclaw-lifecycle";
import type { SandboxEntry } from "../state/registry";
import { finalizeCreatedSandbox } from "./created-sandbox-finalization";

beforeEach(() => {
  vi.spyOn(restoreWindow, "beginUnregisteredOpenClawBackupQuiesce").mockResolvedValue({
    ok: true,
    window: { sandboxName: "spark-box", kind: "backup" },
  });
  vi.spyOn(restoreWindow, "finishUnregisteredOpenClawPostRestoreDoctor").mockResolvedValue({
    ok: true,
  });
  vi.spyOn(restoreWindow, "abortUnregisteredOpenClawPostRestoreDoctor").mockResolvedValue({
    ok: true,
  });
});

function preparedRestoreAuthority(sandboxName: string) {
  const prepared = { name: sandboxName } as SandboxEntry;
  return {
    prepareRegistration: () => prepared,
    revalidatePreparedRegistration: (target: SandboxEntry) => target,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("restored OpenClaw selection reconciliation", () => {
  const options = {
    sandboxName: "openclaw",
    gatewayName: "nemoclaw-9090",
    restoreBackupPath: "/tmp/managed-openclaw-backup",
    preUpgradeBackup: false,
    targetAgentType: "openclaw",
    validateManagedDcode: false,
    provider: "compatible-endpoint",
    model: "changed-model",
    preferredInferenceApi: null,
    reconcileOpenClawInference: true,
  };

  function deps(order: string[]) {
    return {
      ...preparedRestoreAuthority("openclaw"),
      restoreRecreatedSandboxState: async () => {
        order.push("restore");
        return {
          success: true,
          restoredDirs: ["."],
          restoredFiles: [],
          failedDirs: [],
          failedFiles: [],
        };
      },
      writeRestoredOpenclawInferenceRoute: vi.fn(async () => {
        order.push("selection");
      }),
      getDcodeSelectionDrift: vi.fn(),
      register: vi.fn(() => {
        order.push("register");
      }),
      note: vi.fn(),
      error: vi.fn(),
      exitProcess: (code: number): never => {
        throw new Error(`unexpected exit ${code}`);
      },
    };
  }

  it("applies the selected model after restore and before restart and publication (#12667)", async () => {
    const order: string[] = [];
    const dependencies = deps(order);
    vi.mocked(restoreWindow.finishUnregisteredOpenClawPostRestoreDoctor).mockImplementation(
      async () => {
        order.push("restart");
        return { ok: true };
      },
    );
    await finalizeCreatedSandbox(options, dependencies);
    expect(order).toEqual(["restore", "selection", "restart", "register"]);
    expect(dependencies.writeRestoredOpenclawInferenceRoute).toHaveBeenCalledExactlyOnceWith(
      "openclaw",
      "changed-model",
      "compatible-endpoint",
      null,
      "nemoclaw-9090",
      undefined,
    );
  });

  it.each([
    {
      label: "ordinary rebuild",
      patch: { reconcileOpenClawInference: false, preUpgradeBackup: true },
    },
    { label: "custom image", patch: { customImage: true } },
    { label: "fresh creation", patch: { restoreBackupPath: null } },
  ])("preserves $label native configuration (#12667)", async ({ patch }) => {
    const dependencies = deps([]);
    await finalizeCreatedSandbox({ ...options, ...patch }, dependencies);
    expect(dependencies.writeRestoredOpenclawInferenceRoute).not.toHaveBeenCalled();
    expect(dependencies.register).toHaveBeenCalledOnce();
  });

  it("refuses reconciliation when the prepared runtime identity changes (#12667)", async () => {
    const dependencies = deps([]);
    dependencies.revalidatePreparedRegistration = () => {
      throw new Error("runtime identity changed");
    };
    await expect(finalizeCreatedSandbox(options, dependencies)).rejects.toThrow(
      "runtime identity changed",
    );
    expect(dependencies.writeRestoredOpenclawInferenceRoute).not.toHaveBeenCalled();
    expect(dependencies.register).not.toHaveBeenCalled();
    expect(restoreWindow.abortUnregisteredOpenClawPostRestoreDoctor).toHaveBeenCalledOnce();
  });

  it("aborts the offline window without publishing when reconciliation fails (#12667)", async () => {
    const dependencies = deps([]);
    dependencies.writeRestoredOpenclawInferenceRoute.mockRejectedValue(
      new Error("native write failed"),
    );
    await expect(finalizeCreatedSandbox(options, dependencies)).rejects.toThrow(
      "native write failed",
    );
    expect(dependencies.register).not.toHaveBeenCalled();
    expect(restoreWindow.finishUnregisteredOpenClawPostRestoreDoctor).not.toHaveBeenCalled();
    expect(restoreWindow.abortUnregisteredOpenClawPostRestoreDoctor).toHaveBeenCalledOnce();
  });
});
