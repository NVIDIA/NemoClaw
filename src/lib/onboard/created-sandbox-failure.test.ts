// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  reportSandboxCreateFailure,
  type SandboxCreateFailureReportDeps,
  type SandboxCreateFailureReportOptions,
} from "./created-sandbox-failure";

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit:${code}`);
  }
}

function createFailureDeps(
  overrides: Partial<SandboxCreateFailureReportDeps> = {},
): SandboxCreateFailureReportDeps {
  return {
    printCreateFailureDiagnostics: vi.fn(),
    printRecoveryHints: vi.fn(),
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
  });

  it("redacts create output before classification and echoing", () => {
    // With output: leading blank + headline + blank + output echo + "Try:" hint = 5 error() calls.
    const withOutput = createFailureDeps();
    expect(() =>
      reportSandboxCreateFailure(
        createFailureOptions({ createOutput: "failed with Authorization: Bearer secret-token" }),
        withOutput,
      ),
    ).toThrow(ExitSignal);
    expect(withOutput.error).toHaveBeenCalledWith("failed with Authorization: Bearer secr********");
    expect(withOutput.error).not.toHaveBeenCalledWith(
      "failed with Authorization: Bearer secret-token",
    );
    expect(withOutput.printRecoveryHints).toHaveBeenCalledWith(
      "failed with Authorization: Bearer secr********",
      expect.any(Object),
    );
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

  it("redacts multiple known token formats in create output", () => {
    const deps = createFailureDeps();
    const createOutput = [
      "Authorization: Bearer secret-token",
      "github ghp_abcdefghijklmnopqrstuvwxyz1234567890",
      "openai sk-abcdefghijklmnopqrstuvwxyz1234567890",
      "aws AKIAABCDEFGHIJKLMNOP", // gitleaks:allow
    ].join("\n");

    expect(() => reportSandboxCreateFailure(createFailureOptions({ createOutput }), deps)).toThrow(
      ExitSignal,
    );

    const echoed = (deps.error as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String(call[0]))
      .join("\n");
    expect(echoed).not.toContain("secret-token");
    expect(echoed).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234567890");
    expect(echoed).not.toContain("sk-abcdefghijklmnopqrstuvwxyz1234567890");
    expect(echoed).not.toContain("AKIAABCDEFGHIJKLMNOP"); // gitleaks:allow
    const hinted = (deps.printRecoveryHints as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String(call[0]))
      .join("\n");
    expect(hinted).not.toContain("secret-token");
    expect(hinted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234567890");
    expect(hinted).not.toContain("sk-abcdefghijklmnopqrstuvwxyz1234567890");
    expect(hinted).not.toContain("AKIAABCDEFGHIJKLMNOP"); // gitleaks:allow
  });

  it("falls back to exit code 1 when the create status is zero", () => {
    const deps = createFailureDeps();
    expect(() =>
      reportSandboxCreateFailure(createFailureOptions({ createStatus: 0 }), deps),
    ).toThrow(ExitSignal);
    expect(deps.exitProcess).toHaveBeenCalledWith(1);
  });
});
