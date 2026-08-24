// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `nemoclaw <name> exec --help` must show the documented grammar
 * (`nemoclaw <name> exec ...`), not oclif's internal topic:command id form
 * (`nemoclaw sandbox exec <name> ...`) (#10095).
 *
 * Drives the real `oclif.helpClass` wired in package.json through
 * `loadHelpClass`, the same entry point oclif itself uses for `--help`, so
 * this proves the package.json wiring and the Help class together.
 */

import { type Command, Config as OclifConfig, Help, loadHelpClass } from "@oclif/core";
import { describe, expect, it } from "vitest";

async function renderCommandHelp(id: string): Promise<string> {
  const config = await OclifConfig.load(process.cwd());
  // Asserted, not guarded: a missing id is a broken test fixture, and the
  // resulting TypeError names the id-lookup line directly.
  const loadable = config.commands.find((command) => command.id === id) as Command.Loadable;
  // loadHelpClass reads config.pjson.oclif.helpClass, the same entry point oclif
  // uses for --help; ExposedHelp only republishes its protected formatCommand
  // for the assertion below, it does not change what gets rendered.
  const HelpClass = (await loadHelpClass(config)) as typeof Help;
  class ExposedHelp extends HelpClass {
    public renderCommand(command: Command.Loadable): string {
      return this.formatCommand(command);
    }
  }
  const help = new ExposedHelp(config);
  return help.renderCommand(loadable);
}

describe("sandbox command --help grammar", () => {
  it("renders the documented <name> exec form, not the internal sandbox exec <name> form", async () => {
    const text = await renderCommandHelp("sandbox:exec");
    expect(text).toContain("$ nemoclaw <name> exec");
    expect(text).not.toContain("$ nemoclaw sandbox exec <name>");
  });

  it("rewrites every affected sandbox-scoped command, not just exec", async () => {
    const text = await renderCommandHelp("sandbox:policy:restore");
    expect(text).toContain("$ nemoclaw <name> policy restore");
    expect(text).not.toContain("$ nemoclaw sandbox policy restore <name>");
  });

  it("leaves a non-sandbox command's usage untouched", async () => {
    const text = await renderCommandHelp("onboard");
    expect(text).toContain("USAGE");
  });
});
