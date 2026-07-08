// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  reportSandboxCreateFailure,
  reportSandboxReadinessFailure,
  type SandboxCreateFailureReportDeps,
  type SandboxCreateFailureReportOptions,
  type SandboxReadinessFailureReportDeps,
  type SandboxReadinessFailureReportOptions,
} from "./created-sandbox-failure";
import type { CreatedSandboxReadinessResult } from "./sandbox-readiness-tracing";

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit:${code}`);
  }
}

function createFailureDeps(
  overrides: Partial<SandboxCreateFailureReportDeps> = {},
): SandboxCreateFailureReportDeps {
  return {
    classifyCreateFailure: vi.fn(() => ({ kind: "unknown" })),
    printCreateFailureDiagnostics: vi.fn(),
    printRecoveryHints: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    exitProcess: vi.fn((code: number): never => {
      throw new ExitSignal(code);
    }),
    ...overrides,
  };
}

function createFailureOptions(
  overrides: Partial<SandboxCreateFailureReportOptions> = {},
): SandboxCreateFailureReportOptions {
  return {
    sandboxName: "alpha",
    createStatus: 3,
    createOutput: "boom",
    restoreBackupPath: null,
    createArgs: ["sandbox", "create", "alpha"],
    ...overrides,
  };
}

describe("reportSandboxCreateFailure", () => {
  it("warns and returns (does not exit) when the create is merely incomplete", () => {
    const deps = createFailureDeps({
      classifyCreateFailure: vi.fn(() => ({ kind: "sandbox_create_incomplete" })),
    });
    expect(() => reportSandboxCreateFailure(createFailureOptions(), deps)).not.toThrow();
    expect(deps.warn).toHaveBeenCalledWith(
      "  Create stream exited with code 3 after sandbox was created.",
    );
    expect(deps.printCreateFailureDiagnostics).not.toHaveBeenCalled();
    expect(deps.printRecoveryHints).not.toHaveBeenCalled();
    expect(deps.exitProcess).not.toHaveBeenCalled();
  });

  it("prints diagnostics + recovery hints and exits with the create status on a hard failure", () => {
    const deps = createFailureDeps();
    expect(() =>
      reportSandboxCreateFailure(
        createFailureOptions({ createStatus: 42, restoreBackupPath: "/tmp/backup" }),
        deps,
      ),
    ).toThrow(ExitSignal);
    expect(deps.printCreateFailureDiagnostics).toHaveBeenCalledWith("alpha", {
      backupPath: "/tmp/backup",
    });
    expect(deps.printRecoveryHints).toHaveBeenCalledWith("boom", {
      createArgs: ["sandbox", "create", "alpha"],
    });
    expect(deps.exitProcess).toHaveBeenCalledWith(42);
    expect(deps.warn).not.toHaveBeenCalled();
  });

  it("echoes create output only when present", () => {
    // With output: leading blank + headline + blank + output echo + "Try:" hint = 5 error() calls.
    const withOutput = createFailureDeps();
    expect(() =>
      reportSandboxCreateFailure(createFailureOptions({ createOutput: "detail" }), withOutput),
    ).toThrow(ExitSignal);
    expect(withOutput.error).toHaveBeenCalledWith("detail");
    expect(withOutput.error).toHaveBeenCalledTimes(5);

    // Without output: the echo block is skipped, so only 3 error() calls remain.
    const noOutput = createFailureDeps();
    expect(() =>
      reportSandboxCreateFailure(createFailureOptions({ createOutput: "" }), noOutput),
    ).toThrow(ExitSignal);
    expect(noOutput.error).toHaveBeenCalledTimes(3);
    // still exits (createStatus || 1)
    expect(noOutput.exitProcess).toHaveBeenCalledWith(3);
  });

  it("falls back to exit code 1 when the create status is zero", () => {
    const deps = createFailureDeps();
    expect(() =>
      reportSandboxCreateFailure(createFailureOptions({ createStatus: 0 }), deps),
    ).toThrow(ExitSignal);
    expect(deps.exitProcess).toHaveBeenCalledWith(1);
  });
});

const NOT_READY: CreatedSandboxReadinessResult = {
  ready: false,
  reason: "timeout",
  failurePhase: null,
};

function readinessDeps(
  overrides: Partial<SandboxReadinessFailureReportDeps> = {},
): SandboxReadinessFailureReportDeps {
  return {
    printReadinessFailure: vi.fn(),
    printCreateFailureDiagnostics: vi.fn(),
    printDockerGpuReadinessFailure: vi.fn(),
    deleteSandbox: vi.fn(() => ({ status: 0 })),
    cliName: vi.fn(() => "nemoclaw"),
    error: vi.fn(),
    exitProcess: vi.fn((code: number): never => {
      throw new ExitSignal(code);
    }),
    ...overrides,
  };
}

function readinessOptions(
  overrides: Partial<SandboxReadinessFailureReportOptions> = {},
): SandboxReadinessFailureReportOptions {
  return {
    sandboxName: "alpha",
    readiness: NOT_READY,
    timeoutSecs: 300,
    restoreBackupPath: null,
    useDockerGpuPatch: false,
    ...overrides,
  };
}

describe("reportSandboxReadinessFailure", () => {
  it("deletes the failed sandbox on the non-GPU path and exits 1", () => {
    const deps = readinessDeps();
    expect(() => reportSandboxReadinessFailure(readinessOptions(), deps)).toThrow(ExitSignal);
    expect(deps.printReadinessFailure).toHaveBeenCalledWith(NOT_READY, "alpha", 300);
    expect(deps.printCreateFailureDiagnostics).toHaveBeenCalledWith("alpha", { backupPath: null });
    expect(deps.deleteSandbox).toHaveBeenCalledWith("alpha");
    expect(deps.printDockerGpuReadinessFailure).not.toHaveBeenCalled();
    expect(deps.error).toHaveBeenCalledWith(
      "  The failed sandbox has been removed; retry will recreate it.",
    );
    expect(deps.error).toHaveBeenCalledWith("  Retry: nemoclaw onboard");
    expect(deps.exitProcess).toHaveBeenCalledWith(1);
  });

  it("surfaces manual cleanup when deletion fails", () => {
    const deps = readinessDeps({ deleteSandbox: vi.fn(() => ({ status: 1 })) });
    expect(() => reportSandboxReadinessFailure(readinessOptions(), deps)).toThrow(ExitSignal);
    expect(deps.error).toHaveBeenCalledWith(
      "  Could not remove the failed sandbox. Manual cleanup:",
    );
    expect(deps.error).toHaveBeenCalledWith('    openshell sandbox delete "alpha"');
  });

  it("defers cleanup to the Docker-GPU patch and never deletes the sandbox", () => {
    const deps = readinessDeps();
    expect(() =>
      reportSandboxReadinessFailure(readinessOptions({ useDockerGpuPatch: true }), deps),
    ).toThrow(ExitSignal);
    expect(deps.printDockerGpuReadinessFailure).toHaveBeenCalledTimes(1);
    expect(deps.deleteSandbox).not.toHaveBeenCalled();
    expect(deps.exitProcess).toHaveBeenCalledWith(1);
  });
});
