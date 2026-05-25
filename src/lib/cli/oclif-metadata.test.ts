// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Config as OclifConfig } from "@oclif/core";
import { describe, expect, it } from "vitest";

import {
  getRegisteredOclifCommandMetadata,
  getRegisteredOclifCommandSummary,
  getRegisteredOclifCommandsMetadata,
} from "./oclif-metadata";

describe("oclif metadata lookup", () => {
  it("returns generated-manifest command summaries", () => {
    expect(getRegisteredOclifCommandSummary("sandbox:logs")).toBe("Stream sandbox logs");
  });

  it("looks up internal commands from the generated manifest", () => {
    expect(getRegisteredOclifCommandSummary("internal:uninstall:plan")).toBe(
      "Internal: build the NemoClaw uninstall plan",
    );
  });

  it("keeps generated manifest command IDs aligned with oclif Config", async () => {
    const config = await OclifConfig.load(process.cwd());
    const expectedIds = config.commands.map((command) => command.id).sort();
    const manifestIds = Object.keys(getRegisteredOclifCommandsMetadata()).sort();

    expect(manifestIds).toEqual(expectedIds);
  });

  it("returns null for unknown command IDs", () => {
    expect(getRegisteredOclifCommandMetadata("missing:nope")).toBeNull();
  });
});
