// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Config as OclifConfig } from "@oclif/core";
import { describe, expect, it } from "vitest";

import { getRegisteredOclifCommandsMetadata } from "./oclif-metadata";
import { COMMANDS, visibleCommands } from "./command-registry";

describe("public command display metadata", () => {
  it("loads public display entries for root help and docs checks", () => {
    expect(COMMANDS.length).toBeGreaterThan(0);
    expect(COMMANDS.map((command) => ({ commandId: command.commandId, usage: command.usage }))).toEqual(
      expect.arrayContaining([
        { commandId: "onboard", usage: "nemoclaw onboard" },
        { commandId: "sandbox:status", usage: "nemoclaw <name> status" },
        { commandId: "inference:get", usage: "nemoclaw inference get" },
      ]),
    );
  });

  it("maps every command display entry to a discovered oclif command", async () => {
    const config = await OclifConfig.load(process.cwd());
    const registered = new Set(config.commands.map((command) => command.id));
    const missing = COMMANDS.filter((command) => !registered.has(command.commandId)).map(
      (command) => `${command.usage} -> ${command.commandId}`,
    );

    expect(missing).toEqual([]);
  });

  it("keeps visible command display metadata scoped and grouped", () => {
    const invalid = visibleCommands()
      .filter((command) => !command.group || !command.scope || !command.commandId)
      .map((command) => command.usage);

    expect(invalid).toEqual([]);
  });

});
