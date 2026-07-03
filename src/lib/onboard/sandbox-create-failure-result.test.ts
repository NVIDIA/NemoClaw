// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { handleSandboxCreateResultFailure } from "./sandbox-create-failure";

function deps(overrides: Record<string, unknown> = {}) {
  const warn = vi.fn();
  const error = vi.fn();
  const printRecoveryHints = vi.fn();
  const exit = vi.fn((_code: number) => {
    throw new Error("exit");
  }) as unknown as (code: number) => never;
  return {
    warn,
    error,
    printRecoveryHints,
    exit,
    createArgs: ["--from", "/ctx/Dockerfile"],
    classifyFailure: (_output: string) => ({ kind: "sandbox_create_generic" }),
    ...overrides,
  };
}

describe("handleSandboxCreateResultFailure", () => {
  it("does nothing on a successful (status 0) result", () => {
    const d = deps();
    handleSandboxCreateResultFailure({ status: 0, output: "" }, d);
    expect(d.warn).not.toHaveBeenCalled();
    expect(d.error).not.toHaveBeenCalled();
    expect(d.printRecoveryHints).not.toHaveBeenCalled();
  });

  it("warns and returns (does not exit) for an incomplete create", () => {
    const d = deps({ classifyFailure: () => ({ kind: "sandbox_create_incomplete" }) });
    handleSandboxCreateResultFailure({ status: 255, output: "ssh 255" }, d);
    expect(d.warn).toHaveBeenCalled();
    expect(d.exit).not.toHaveBeenCalled();
    expect(d.printRecoveryHints).not.toHaveBeenCalled();
  });

  it("prints recovery hints and exits non-zero for a fatal failure", () => {
    const d = deps();
    expect(() => handleSandboxCreateResultFailure({ status: 3, output: "boom" }, d)).toThrow(
      "exit",
    );
    expect(d.error).toHaveBeenCalled();
    expect(d.printRecoveryHints).toHaveBeenCalledWith("boom", {
      createArgs: ["--from", "/ctx/Dockerfile"],
    });
    expect(d.exit).toHaveBeenCalledWith(3);
  });

  it("forwards the post-prebuild image-ref create args to the recovery hints (#6002)", () => {
    // After the BuildKit prebuild rewrites `--from <Dockerfile>` to a local
    // image ref, the launch args passed here already carry that image ref. The
    // handler must forward exactly those args so the hints reconstruct the
    // create command from the real, post-rewrite --from value (not a stale
    // Dockerfile path).
    const createArgs = ["--from", "nemoclaw/sandbox-local:asst", "--name", "asst"];
    const d = deps({ createArgs });
    expect(() => handleSandboxCreateResultFailure({ status: 5, output: "upload 404" }, d)).toThrow(
      "exit",
    );
    expect(d.printRecoveryHints).toHaveBeenCalledWith("upload 404", { createArgs });
    expect(d.exit).toHaveBeenCalledWith(5);
  });

  it("exits with code 1 when the failure status is falsy but non-zero-branch is reached", () => {
    // status !== 0 gate is the caller's; here we assert the `|| 1` fallback path
    // by passing a NaN-like status the caller would not normally send.
    const d = deps();
    expect(() => handleSandboxCreateResultFailure({ status: Number.NaN, output: "" }, d)).toThrow(
      "exit",
    );
    expect(d.exit).toHaveBeenCalledWith(1);
  });
});
