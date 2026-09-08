// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags, Parser } from "@oclif/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { describeCommandErrorForJson, NemoClawCommand } from "./nemoclaw-oclif-command";

/** The exact parse failure `doctor --text --json` produces, built from the real parser. */
async function rejectedExclusiveFlagCombination(): Promise<unknown> {
  return await Parser.parse(["--text", "--json"], {
    flags: { text: Flags.boolean({ exclusive: ["json"] }), json: Flags.boolean({}) },
  }).then(
    () => null,
    (error: unknown) => error,
  );
}

/**
 * Capture the raw failure a command's own `this.parse` produces.
 *
 * The size only appears on this path: `Command.parse` passes `context: this`,
 * so the error reaches `this.config` and the manifests behind it. A bare
 * `Parser.parse` call carries no context and stays small, which is why the
 * defect is reproduced through a command rather than the parser.
 */
class DefaultEnvelopeCommand extends NemoClawCommand {
  static id = "default-envelope-test";
  static enableJsonFlag = true;
  static flags = { text: Flags.boolean({ exclusive: ["json"] }) };
  static captured: unknown = null;

  public async run(): Promise<unknown> {
    await this.parse(DefaultEnvelopeCommand);
    return null;
  }

  protected override async catch(err: Error): Promise<unknown> {
    DefaultEnvelopeCommand.captured = err;
    return null;
  }
}

class ExclusiveFlagCommand extends NemoClawCommand {
  static id = "exclusive-flag-test";
  static enableJsonFlag = true;
  static flags = { text: Flags.boolean({ exclusive: ["json"] }) };
  static emitted: unknown[] = [];

  public async run(): Promise<unknown> {
    await this.parse(ExclusiveFlagCommand);
    return { unreachable: true };
  }

  /** Capture what reaches stdout without writing to the test runner's own stream. */
  public override logJson(value: unknown): void {
    ExclusiveFlagCommand.emitted.push(value);
  }
}

describe("a command that fails under --json (#11150)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("loses the message and carries the whole config graph in oclif's default envelope", async () => {
    await DefaultEnvelopeCommand.run(["--text", "--json"], process.cwd());
    const defaultEnvelope = JSON.stringify({ error: DefaultEnvelopeCommand.captured });

    expect(defaultEnvelope).not.toContain("cannot also be provided");
    expect(defaultEnvelope.length).toBeGreaterThan(100_000);
  });

  it("reduces that same failure to an envelope a caller can read", async () => {
    await DefaultEnvelopeCommand.run(["--text", "--json"], process.cwd());
    const described = describeCommandErrorForJson(DefaultEnvelopeCommand.captured);

    expect(described.message).toContain("cannot also be provided when using");
    expect(JSON.stringify(described).length).toBeLessThan(1_000);
  });

  it("keeps the rejected combination as the message", async () => {
    const error = await rejectedExclusiveFlagCombination();

    expect(describeCommandErrorForJson(error).message).toContain(
      "--json=true cannot also be provided when using --text",
    );
  });

  it("drops the config graph the default envelope dragged in", async () => {
    const error = await rejectedExclusiveFlagCombination();

    expect(JSON.stringify(describeCommandErrorForJson(error)).length).toBeLessThan(1_000);
  });

  it("carries the parser's exit code", async () => {
    const error = await rejectedExclusiveFlagCombination();

    expect(describeCommandErrorForJson(error).exit).toBe(2);
  });

  it("redacts an inline credential the rejected argv put in the message", () => {
    const described = describeCommandErrorForJson(
      new Error("Nonexistent flag: --api-key=sk-live-should-not-appear"),
    );

    expect(described.message).not.toContain("sk-live-should-not-appear");
  });

  it("describes a thrown non-Error without inventing a message", () => {
    expect(describeCommandErrorForJson(undefined).message).toBe(
      "The command failed without reporting a reason.",
    );
  });

  it("prints the diagnostic on stderr and a small envelope on stdout", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    ExclusiveFlagCommand.emitted = [];

    await ExclusiveFlagCommand.run(["--text", "--json"], process.cwd());
    const emitted = ExclusiveFlagCommand.emitted;

    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("cannot also be provided when using"),
    );
    expect(JSON.stringify(emitted[0])).toContain("cannot also be provided when using");
    expect(JSON.stringify(emitted[0]).length).toBeLessThan(1_000);
  });
});
