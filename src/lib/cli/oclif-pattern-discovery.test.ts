// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { Config as OclifConfig } from "@oclif/core";
import { describe, expect, it } from "vitest";

const COMMANDS_ROOT = path.join(process.cwd(), "src", "commands");

function expectedCommandIdsFromSourceCommands(dir = COMMANDS_ROOT, prefix = ""): string[] {
  const ids: string[] = [];
  for (const entry of fs.readdirSync(dir).sort()) {
    const absolute = path.join(dir, entry);
    const relative = path.join(prefix, entry);
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      ids.push(...expectedCommandIdsFromSourceCommands(absolute, relative));
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    const parsed = path.parse(relative);
    const topics = parsed.dir.split(path.sep).filter(Boolean);
    const command = parsed.name === "index" ? null : parsed.name;
    ids.push([...topics, command].filter(Boolean).join(":"));
  }
  return ids.sort();
}

describe("oclif pattern command discovery", () => {
  it("discovers every command id from src/commands", async () => {
    const config = await OclifConfig.load(process.cwd());
    const discoveredIds = config.commands.map((command) => command.id).sort();

    expect(discoveredIds).toEqual(expectedCommandIdsFromSourceCommands());
  });

  it("does not rely on the removed compatibility command index", () => {
    expect(fs.existsSync(path.join(process.cwd(), "src", "lib", "commands", "index.ts"))).toBe(
      false,
    );
  });
});
