// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Command, Interfaces } from "@oclif/core";
import { describe, expect, it } from "vitest";
import { SandboxScopedCommandHelp } from "./nemoclaw-sandbox-help";

class TestableHelp extends SandboxScopedCommandHelp {
  public callUsage(): string {
    return this.usage();
  }
}

function makeConfig(topicSeparator: string): Interfaces.Config {
  return { bin: "nemoclaw", topicSeparator } as unknown as Interfaces.Config;
}

function makeCommand(id: string, usage: string | string[] | undefined): Command.Loadable {
  return { id, usage } as unknown as Command.Loadable;
}

const opts = { maxWidth: 80, stripAnsi: false } as unknown as Interfaces.HelpOptions;

describe("SandboxScopedCommandHelp", () => {
  it("moves the action verb after <name> for a sandbox: id (unmutated colon form)", () => {
    const help = new TestableHelp(
      makeCommand("sandbox:exec", ["<name> [--workdir <dir>] -- <cmd>"]),
      makeConfig(" "),
      opts,
    );
    expect(help.callUsage()).toBe("$ nemoclaw <name> exec [--workdir <dir>] -- <cmd>");
  });

  it("still resolves the action when Help.formatCommand already rewrote id's colons to the topic separator", () => {
    // Help.formatCommand mutates command.id's `:` to the configured topicSeparator
    // before handing the command to this class (#10095's actual failure mode).
    const help = new TestableHelp(
      makeCommand("sandbox exec", ["<name> [--workdir <dir>] -- <cmd>"]),
      makeConfig(" "),
      opts,
    );
    expect(help.callUsage()).toBe("$ nemoclaw <name> exec [--workdir <dir>] -- <cmd>");
  });

  it("joins nested subcommand ids with a space", () => {
    const help = new TestableHelp(
      makeCommand("sandbox:share:mount", ["<name> [sandbox-path] [local-mount-point]"]),
      makeConfig(" "),
      opts,
    );
    expect(help.callUsage()).toBe(
      "$ nemoclaw <name> share mount [sandbox-path] [local-mount-point]",
    );
  });

  it("falls back to default rendering for a usage line that does not start with <name>", () => {
    const help = new TestableHelp(
      makeCommand("sandbox:share", ["<mount|unmount|status> <name>"]),
      makeConfig(" "),
      opts,
    );
    expect(help.callUsage()).toContain("$ nemoclaw sandbox:share <mount|unmount|status> <name>");
  });

  it("falls back to default rendering for a non-sandbox command", () => {
    const help = new TestableHelp(
      makeCommand("onboard", ["[--profile <name>]"]),
      makeConfig(" "),
      opts,
    );
    expect(help.callUsage()).toContain("$ nemoclaw onboard [--profile <name>]");
  });

  it("falls back to default rendering when the command declares no usage", () => {
    const help = new TestableHelp(makeCommand("sandbox:status", undefined), makeConfig(" "), opts);
    expect(help.callUsage()).not.toContain("undefined");
  });

  it("wraps a usage line longer than the allowed width, same as oclif's default", () => {
    const longUsage =
      "<name> [--yes|-y|--force] [--verbose|-v] [--tool-disclosure <progressive|direct>] [--dcode-auto-approval <disabled|thread-opt-in>] [--observability|--no-observability]";
    const help = new TestableHelp(
      makeCommand("sandbox:rebuild", [longUsage]),
      makeConfig(" "),
      opts,
    );
    const result = help.callUsage();
    const lines = result.split("\n");
    expect(result).toContain("$ nemoclaw <name> rebuild");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.length <= opts.maxWidth)).toBe(true);
  });
});
