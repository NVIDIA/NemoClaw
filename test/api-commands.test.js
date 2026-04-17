// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "vitest";
import childProcess from "child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const commandsPath = path.join(import.meta.dirname, "..", "dist", "lib", "api-commands");

describe("readConfig / writeConfig", () => {
  let tmpDir;
  let tmpConfigPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-api-cmd-"));
    tmpConfigPath = path.join(tmpDir, "nemoclaw-config.json");
    delete require.cache[require.resolve(commandsPath)];
  });

  it("readConfig returns empty object when file does not exist", () => {
    const { readConfig } = require(commandsPath);
    const config = readConfig(tmpConfigPath);
    expect(config).toEqual({});
  });

  it("writeConfig persists data and readConfig reads it back", () => {
    const { readConfig, writeConfig } = require(commandsPath);
    writeConfig({ provider: "nim" }, tmpConfigPath);
    expect(readConfig(tmpConfigPath)).toMatchObject({ provider: "nim" });
  });

  it("writeConfig merges with existing config", () => {
    const { readConfig, writeConfig } = require(commandsPath);
    writeConfig({ provider: "nim" }, tmpConfigPath);
    writeConfig({ model: "nemotron" }, tmpConfigPath);
    expect(readConfig(tmpConfigPath)).toMatchObject({ provider: "nim", model: "nemotron" });
  });
});

describe("stopSandbox", () => {
  it("returns ok:true when openshell sandbox delete exits 0", () => {
    const original = childProcess.spawnSync;
    childProcess.spawnSync = () => ({ status: 0, stdout: "deleted\n", stderr: "" });
    try {
      delete require.cache[require.resolve(commandsPath)];
      const { stopSandbox } = require(commandsPath);
      const result = stopSandbox("my-sandbox", "/usr/local/bin/openshell");
      expect(result.ok).toBe(true);
    } finally {
      childProcess.spawnSync = original;
      delete require.cache[require.resolve(commandsPath)];
    }
  });

  it("returns ok:false when openshell exits non-zero", () => {
    const original = childProcess.spawnSync;
    childProcess.spawnSync = () => ({ status: 1, stdout: "", stderr: "not found\n" });
    try {
      delete require.cache[require.resolve(commandsPath)];
      const { stopSandbox } = require(commandsPath);
      const result = stopSandbox("missing", "/usr/local/bin/openshell");
      expect(result.ok).toBe(false);
      expect(result.output).toContain("not found");
    } finally {
      childProcess.spawnSync = original;
      delete require.cache[require.resolve(commandsPath)];
    }
  });
});
