// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Config as OclifConfig } from "@oclif/core";
import { describe, expect, it } from "vitest";

import { getRegisteredOclifCommandsMetadata } from "./oclif-metadata";
import { COMMANDS, visibleCommands } from "./command-registry";

describe("public command display metadata", () => {
  it("derives command display entries from oclif command-class metadata", () => {
    const metadata = getRegisteredOclifCommandsMetadata();
    const discoveredDisplay = Object.entries(metadata).flatMap(([commandId, commandMetadata]) =>
      (commandMetadata.display ?? []).map((entry) => ({ commandId, usage: entry.usage })),
    );

    expect(discoveredDisplay).toHaveLength(COMMANDS.length);
    expect(discoveredDisplay).toEqual(
      expect.arrayContaining(
        COMMANDS.map((command) => ({ commandId: command.commandId, usage: command.usage })),
      ),
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
