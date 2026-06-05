// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Config as OclifConfig } from "@oclif/core";
import { describe, expect, it } from "vitest";

type OclifCommandClass = {
  flags?: Record<string, unknown>;
};

function extendsNemoClawCommand(commandClass: unknown): boolean {
  if (typeof commandClass !== "function") return false;
  let current = Object.getPrototypeOf(commandClass) as { name?: string } | null;
  while (current) {
    if (current.name === "NemoClawCommand") return true;
    current = Object.getPrototypeOf(current) as { name?: string } | null;
  }
  return false;
}

function commandOwnsHelpFlag(commandClass: unknown): boolean {
  return (
    typeof commandClass === "function" &&
    Object.hasOwn(commandClass as OclifCommandClass, "flags") &&
    Object.hasOwn((commandClass as OclifCommandClass).flags ?? {}, "help")
  );
}

describe("oclif command metadata", () => {
  it("keeps discovered commands on the shared NemoClaw oclif base", async () => {
    const config = await OclifConfig.load(process.cwd());
    const nonConforming: string[] = [];

    for (const command of config.commands) {
      const commandClass = await command.load();
      if (!extendsNemoClawCommand(commandClass)) nonConforming.push(command.id);
    }

    expect(nonConforming).toEqual([]);
  });

  it("keeps the help flag centralized on the shared base command", async () => {
    const config = await OclifConfig.load(process.cwd());
    const duplicatedHelpFlags: string[] = [];

    for (const command of config.commands) {
      const commandClass = await command.load();
      if (commandOwnsHelpFlag(commandClass)) duplicatedHelpFlags.push(command.id);
    }

    expect(duplicatedHelpFlags).toEqual([]);
  });

  it("keeps public discovered commands documented in oclif statics", async () => {
    const config = await OclifConfig.load(process.cwd());
    const publicCommands = config.commands.filter((command) => command.hidden !== true);
    const missing: string[] = [];

    for (const command of publicCommands) {
      if (!command.summary) missing.push(`${command.id}: summary`);
      if (!command.description) missing.push(`${command.id}: description`);
      if (!Array.isArray(command.usage) || command.usage.length === 0) {
        missing.push(`${command.id}: usage`);
      }
      if (!Array.isArray(command.examples) || command.examples.length === 0) {
        missing.push(`${command.id}: examples`);
      }
    }

    expect(missing).toEqual([]);
  });
});
