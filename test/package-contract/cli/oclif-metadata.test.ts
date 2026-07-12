// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Config as OclifConfig } from "@oclif/core";
import { describe, expect, it } from "vitest";

import {
  getRegisteredOclifCommandMetadata,
  getRegisteredOclifCommandSummary,
  getRegisteredOclifCommandsMetadata,
} from "../../../dist/lib/cli/oclif-metadata";

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

  it("fails closed when compiled metadata has no generated manifest", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-oclif-metadata-"));
    const fixtureModule = path.join(fixtureRoot, "dist", "lib", "cli", "oclif-metadata.js");
    const sourceModule = path.join(process.cwd(), "dist", "lib", "cli", "oclif-metadata.js");
    const fixtureBranding = path.join(fixtureRoot, "dist", "lib", "cli", "branding.js");
    const sourceBranding = path.join(process.cwd(), "dist", "lib", "cli", "branding.js");
    const fixtureAliases = path.join(fixtureRoot, "dist", "lib", "agent", "aliases.js");
    const sourceAliases = path.join(process.cwd(), "dist", "lib", "agent", "aliases.js");
    const env = { ...process.env };
    delete env.OCLIF_METADATA_MANIFEST_GENERATION;

    try {
      fs.mkdirSync(path.dirname(fixtureModule), { recursive: true });
      fs.mkdirSync(path.dirname(fixtureAliases), { recursive: true });
      fs.copyFileSync(sourceModule, fixtureModule);
      fs.copyFileSync(sourceBranding, fixtureBranding);
      fs.copyFileSync(sourceAliases, fixtureAliases);
      const result = spawnSync(
        process.execPath,
        ["-e", `require(${JSON.stringify(fixtureModule)}).getRegisteredOclifCommandsMetadata()`],
        { encoding: "utf-8", env },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Missing generated oclif metadata manifest");
    } finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });
});
