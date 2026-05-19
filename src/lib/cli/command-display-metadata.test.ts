// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { Config as OclifConfig } from "@oclif/core";
import { describe, expect, it } from "vitest";

import { getRegisteredOclifCommandsMetadata } from "./oclif-metadata";
import { COMMANDS, visibleCommands } from "./command-registry";

function* walkTsFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkTsFiles(fullPath);
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) yield fullPath;
  }
}

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

  it("keeps public command discovery wrappers free of display metadata", () => {
    const commandFiles = [...walkTsFiles(path.join(process.cwd(), "src", "commands"))].filter(
      (file) => !file.includes(`${path.sep}internal${path.sep}`),
    );
    const wrappersWithDisplayHelpers = commandFiles
      .filter((file) => fs.readFileSync(file, "utf-8").includes("withCommandDisplay"))
      .map((file) => path.relative(process.cwd(), file));

    expect(wrappersWithDisplayHelpers).toEqual([]);
  });

  it("keeps non-internal command discovery files independent from legacy lib command re-exports", () => {
    const commandFiles = [...walkTsFiles(path.join(process.cwd(), "src", "commands"))].filter(
      (file) => !file.includes(`${path.sep}internal${path.sep}`),
    );
    const legacyCommandReExports = commandFiles
      .filter((file) => {
        const body = fs.readFileSync(file, "utf-8");
        return /export \{ default \} from "[^"]*\/lib\/commands\//.test(body);
      })
      .map((file) => path.relative(process.cwd(), file));

    expect(legacyCommandReExports).toEqual([]);
  });
});
