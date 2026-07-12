// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { describe, expect, it } from "vitest";

import { CLI_DISPLAY_NAME } from "./branding";
import {
  getRegisteredOclifCommandMetadata,
  getRegisteredOclifCommandSummary,
  getRegisteredOclifCommandsMetadata,
} from "./oclif-metadata";

describe("source oclif metadata lookup", () => {
  it("discovers source command IDs and static metadata without loading command modules", () => {
    const loadedBefore = new Set(Object.keys(require.cache));
    const metadata = getRegisteredOclifCommandsMetadata();
    const sourceCommandsRoot = `${path.join(process.cwd(), "src", "commands")}${path.sep}`;
    const newlyLoadedCommandModules = Object.keys(require.cache).filter(
      (file) => file.startsWith(sourceCommandsRoot) && !loadedBefore.has(file),
    );

    expect(Object.keys(metadata)).toEqual(
      expect.arrayContaining([
        "onboard",
        "sandbox:status",
        "sandbox:channels:start",
        "internal:uninstall:plan",
      ]),
    );
    expect(metadata["sandbox:sessions"]).toMatchObject({
      id: "sandbox:sessions",
      strict: false,
      summary: "List conversation sessions in a sandbox",
    });
    expect(metadata["root:help"]).toMatchObject({
      hidden: true,
      id: "root:help",
      strict: false,
      summary: "Show help",
    });
    expect(newlyLoadedCommandModules).toEqual([]);
  });

  it("looks up source summaries and rejects unknown command IDs", () => {
    expect(getRegisteredOclifCommandSummary("sandbox:logs")).toBe("Stream sandbox logs");
    expect(getRegisteredOclifCommandSummary("update")).toBe(
      `Run the maintained ${CLI_DISPLAY_NAME} installer update flow`,
    );
    expect(getRegisteredOclifCommandSummary("internal:uninstall:run-plan")).toBe(
      `${CLI_DISPLAY_NAME} Uninstaller`,
    );
    expect(getRegisteredOclifCommandMetadata("missing:nope")).toBeNull();
  });
});
