// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Config as OclifConfig } from "@oclif/core";
import { describe, expect, it } from "vitest";

describe("oclif command metadata", () => {
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
