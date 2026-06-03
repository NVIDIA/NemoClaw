// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { Config as OclifConfig } from "@oclif/core";
import { describe, expect, it } from "vitest";

describe("oclif pattern command discovery", () => {
  it("discovers representative command ids from oclif's pattern config", async () => {
    const config = await OclifConfig.load(process.cwd());
    const discoveredIds = config.commands.map((command) => command.id).sort();

    expect(discoveredIds).toEqual(
      expect.arrayContaining([
        "onboard",
        "sandbox:status",
        "sandbox:channels:start",
        "inference:get",
      ]),
    );
  });

  it("does not rely on the removed compatibility command index", () => {
    expect(fs.existsSync(path.join(process.cwd(), "src", "lib", "commands", "index.ts"))).toBe(
      false,
    );
  });
});
