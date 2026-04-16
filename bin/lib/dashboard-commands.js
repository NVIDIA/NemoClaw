// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

"use strict";

const childProcess = require("child_process");
const path = require("path");
const { resolveOpenshell } = require("./resolve-openshell");
const { readConfigFile, writeConfigFile } = require("./config-io");

const DEFAULT_CONFIG_PATH = path.join(
  process.env.HOME || "/tmp",
  ".nemoclaw",
  "nemoclaw-config.json",
);

function getOpenshellBin() {
  const bin = resolveOpenshell();
  if (!bin) throw new Error("openshell CLI not found — install OpenShell first");
  return bin;
}

function runOpenshell(args, openshellBin) {
  const bin = openshellBin || getOpenshellBin();
  const result = childProcess.spawnSync(bin, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ok: result.status === 0,
    output: ((result.stdout || "") + (result.stderr || "")).trim(),
  };
}

function stopSandbox(name, openshellBin) {
  return runOpenshell(["sandbox", "delete", name], openshellBin);
}

function startSandbox() {
  const nemoclawBin = path.resolve(__dirname, "..", "nemoclaw.js");
  const result = childProcess.spawnSync(process.execPath, [nemoclawBin, "start"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ok: result.status === 0,
    output: ((result.stdout || "") + (result.stderr || "")).trim(),
  };
}

function restartSandbox(name, openshellBin) {
  const stopResult = stopSandbox(name, openshellBin);
  if (!stopResult.ok) return stopResult;
  return startSandbox();
}

function runSandboxCommand(name, command, openshellBin) {
  return runOpenshell(["sandbox", "exec", name, "--", command], openshellBin);
}

function readConfig(configPath) {
  return readConfigFile(configPath || DEFAULT_CONFIG_PATH, {});
}

function writeConfig(updates, configPath) {
  const filePath = configPath || DEFAULT_CONFIG_PATH;
  const current = readConfigFile(filePath, {});
  writeConfigFile(filePath, { ...current, ...updates });
}

module.exports = {
  stopSandbox,
  startSandbox,
  restartSandbox,
  runSandboxCommand,
  readConfig,
  writeConfig,
};
