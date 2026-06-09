// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("../../policy/context", () => ({
  buildPolicyContext: vi.fn(),
  renderPolicyContextMarkdown: vi.fn(),
}));

import {
  POLICY_CONTEXT_SANDBOX_PATH,
  refreshSandboxPolicyContextFile,
} from "./policy-context-refresh";

describe("refreshSandboxPolicyContextFile", () => {
  it("reports `ok` when the write succeeds and does not warn", () => {
    const warn = vi.fn();
    const unexpected = vi.fn();
    const write = vi.fn(() => ({ written: true }));

    const outcome = refreshSandboxPolicyContextFile("alpha", { warn, unexpected, write });

    expect(outcome.outcome).toBe("ok");
    expect(warn).not.toHaveBeenCalled();
    expect(unexpected).not.toHaveBeenCalled();
  });

  it("treats `sandbox unreachable` as a non-fatal `unreachable` outcome without warning", () => {
    const warn = vi.fn();
    const unexpected = vi.fn();
    const write = vi.fn(() => ({ written: false, reason: "sandbox unreachable" }));

    const outcome = refreshSandboxPolicyContextFile("alpha", { warn, unexpected, write });

    expect(outcome.outcome).toBe("unreachable");
    expect(warn).not.toHaveBeenCalled();
    expect(unexpected).not.toHaveBeenCalled();
  });

  it("warns about explicit `failed` outcomes when the sandbox returns a non-zero exit", () => {
    const warn = vi.fn();
    const unexpected = vi.fn();
    const write = vi.fn(() => ({
      written: false,
      reason: "write failed (status 13): denied",
    }));

    const outcome = refreshSandboxPolicyContextFile("alpha", { warn, unexpected, write });

    expect(outcome.outcome).toBe("failed");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(POLICY_CONTEXT_SANDBOX_PATH);
    expect(warn.mock.calls[0][0]).toContain("status 13");
    expect(unexpected).not.toHaveBeenCalled();
  });

  it("routes unexpected exceptions through the `unexpected` sink instead of swallowing them", () => {
    const warn = vi.fn();
    const unexpected = vi.fn();
    const write = vi.fn(() => {
      throw new Error("import regression: cannot find module");
    });

    const outcome = refreshSandboxPolicyContextFile("alpha", { warn, unexpected, write });

    expect(outcome.outcome).toBe("crashed");
    expect(unexpected).toHaveBeenCalledTimes(1);
    const arg = unexpected.mock.calls[0][0];
    expect(arg instanceof Error ? arg.message : String(arg)).toContain("import regression");
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats loader crashes from writePolicyContextToSandbox as `crashed` even when the write returns instead of throwing", () => {
    const warn = vi.fn();
    const unexpected = vi.fn();
    const write = vi.fn(() => ({
      written: false,
      reason: "policy-context executor failed to load: missing module",
      failure: "unexpected-loader" as const,
      errorMessage: "missing module",
    }));

    const outcome = refreshSandboxPolicyContextFile("alpha", { warn, unexpected, write });

    expect(outcome.outcome).toBe("crashed");
    expect(unexpected).toHaveBeenCalledTimes(1);
    const arg = unexpected.mock.calls[0][0];
    expect(arg instanceof Error ? arg.message : String(arg)).toContain("missing module");
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats `loader-vitest` and `no-runtime` loader signals as non-warning `unreachable` outcomes", () => {
    const warn = vi.fn();
    const unexpected = vi.fn();
    const writeVitest = vi.fn(() => ({
      written: false,
      reason: "sandbox unreachable",
      failure: "loader-vitest" as const,
    }));
    const writeNoRuntime = vi.fn(() => ({
      written: false,
      reason: "sandbox unreachable",
      failure: "no-runtime" as const,
    }));

    expect(
      refreshSandboxPolicyContextFile("alpha", { warn, unexpected, write: writeVitest }).outcome,
    ).toBe("unreachable");
    expect(
      refreshSandboxPolicyContextFile("alpha", { warn, unexpected, write: writeNoRuntime }).outcome,
    ).toBe("unreachable");
    expect(warn).not.toHaveBeenCalled();
    expect(unexpected).not.toHaveBeenCalled();
  });
});
