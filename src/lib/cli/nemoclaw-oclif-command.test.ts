// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { NemoClawCommand, type CommandExitResult } from "./nemoclaw-oclif-command";

class TestCommand extends NemoClawCommand {
  static id = "test";

  public async run(): Promise<void> {
    // Test-only command wrapper.
  }

  public apply(result: CommandExitResult): void {
    this.applyExitResult(result);
  }

  public fail(lines: readonly string[], code?: number): void {
    this.failWithLines(lines, code);
  }
}

function makeCommand(): TestCommand {
  return Object.create(TestCommand.prototype) as TestCommand;
}

describe("NemoClawCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("records status-like command results without throwing", () => {
    makeCommand().apply({ status: 7 });

    expect(process.exitCode).toBe(7);
  });

  it("prefers exitCode and prints failure messages", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    makeCommand().apply({ exitCode: 3, message: "boom", status: 7 });

    expect(process.exitCode).toBe(3);
    expect(error).toHaveBeenCalledWith("boom");
  });

  it("prints multi-line failures and records the requested code", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    makeCommand().fail(["line 1", "line 2"], 9);

    expect(process.exitCode).toBe(9);
    expect(error.mock.calls).toEqual([["line 1"], ["line 2"]]);
  });
});
