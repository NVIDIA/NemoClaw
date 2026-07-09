// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "./logger";
import { type CommandExitResult, NemoClawCommand } from "./nemoclaw-oclif-command";

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

  public json(value: unknown): void {
    this.logJson(value);
  }
}

class ParsingTestCommand extends NemoClawCommand {
  static id = "parsing-test";
  static flags = {};

  public async run(): Promise<void> {
    await this.parse(ParsingTestCommand);
  }
}

function makeCommand(): TestCommand {
  return Object.create(TestCommand.prototype) as TestCommand;
}

describe("NemoClawCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    log.configure();
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

  it("redacts sensitive JSON output before logging", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    makeCommand().json({ provider: "build", apiKey: "nvapi-" + "a".repeat(24) });

    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ provider: "build", apiKey: "<REDACTED>" }, null, 2),
    );
  });

  it("applies host logging flags from oclif parser output", async () => {
    const configure = vi.spyOn(log, "configure").mockImplementation(() => undefined);

    await ParsingTestCommand.run(["--quiet"], process.cwd());
    await ParsingTestCommand.run(["--debug"], process.cwd());

    expect(configure).toHaveBeenCalledWith({ debug: false, quiet: true });
    expect(configure).toHaveBeenCalledWith({ debug: true, quiet: false });
  });

  it("keeps NEMOCLAW_LOG_LEVEL precedence unless a CLI flag overrides it", async () => {
    vi.stubEnv("NEMOCLAW_LOG_LEVEL", "error");
    vi.stubEnv("NEMOCLAW_DEBUG", "true");

    await ParsingTestCommand.run([], process.cwd());
    expect(log.level).toBe("error");

    await ParsingTestCommand.run(["--debug"], process.cwd());
    expect(log.level).toBe("debug");
  });
});
