// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { COMMANDS, visibleCommands } from "./command-registry";
import commands from "../../dist/lib/commands/index.js";

describe("public command display metadata", () => {
  it("maps every command display entry to a registered oclif command", () => {
    const registered = new Set(Object.keys(commands));
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
