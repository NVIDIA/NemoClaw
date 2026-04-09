// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Extract the two functions from nemoclaw-start.sh so they can be tested
// in isolation without sourcing the full startup script.
const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");
const scriptContent = fs.readFileSync(SCRIPT, "utf-8");

// Pull ensure_identity_symlink and fix_openclaw_data_ownership function bodies
// from the script. They are defined as shell functions we can source directly.
function extractFunction(name) {
  const re = new RegExp(`^  ${name}\\(\\) \\{$`, "m");
  const start = scriptContent.search(re);
  if (start === -1) throw new Error(`Function ${name} not found in ${SCRIPT}`);
  // Find matching closing brace (same indent level)
  let depth = 0;
  let i = scriptContent.indexOf("{", start);
  for (; i < scriptContent.length; i++) {
    if (scriptContent[i] === "{") depth++;
    if (scriptContent[i] === "}") depth--;
    if (depth === 0) break;
  }
  // Remove the 2-space indent since we'll source it at top level
  return scriptContent
    .slice(start, i + 1)
    .split("\n")
    .map((line) => (line.startsWith("  ") ? line.slice(2) : line))
    .join("\n");
}

const ENSURE_IDENTITY_SYMLINK = extractFunction("ensure_identity_symlink");
const FIX_OPENCLAW_DATA_OWNERSHIP = extractFunction("fix_openclaw_data_ownership");

function runShell(script, env = {}) {
  return spawnSync("bash", ["-euo", "pipefail", "-c", script], {
    cwd: path.join(import.meta.dirname, ".."),
    encoding: "utf-8",
    env: { PATH: process.env.PATH, PS1: "", BASH_ENV: "", ...env },
    timeout: 10_000,
  });
}

describe("ensure_identity_symlink", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-identity-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates symlink when identity dir exists and no link present", () => {
    const dataDir = path.join(tmpDir, ".openclaw-data");
    const openclawDir = path.join(tmpDir, ".openclaw");
    fs.mkdirSync(path.join(dataDir, "identity"), { recursive: true });

    const result = runShell(
      `${ENSURE_IDENTITY_SYMLINK}\nensure_identity_symlink "${dataDir}" "${openclawDir}"`,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("created identity symlink");
    expect(fs.lstatSync(path.join(openclawDir, "identity")).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(openclawDir, "identity"))).toBe(
      path.join(dataDir, "identity"),
    );
  });

  it("does nothing when identity dir does not exist in data_dir", () => {
    const dataDir = path.join(tmpDir, ".openclaw-data");
    const openclawDir = path.join(tmpDir, ".openclaw");
    fs.mkdirSync(dataDir, { recursive: true });
    // No identity subdir

    const result = runShell(
      `${ENSURE_IDENTITY_SYMLINK}\nensure_identity_symlink "${dataDir}" "${openclawDir}"`,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("[setup]");
    expect(fs.existsSync(path.join(openclawDir, "identity"))).toBe(false);
  });

  it("leaves correct symlink untouched", () => {
    const dataDir = path.join(tmpDir, ".openclaw-data");
    const openclawDir = path.join(tmpDir, ".openclaw");
    fs.mkdirSync(path.join(dataDir, "identity"), { recursive: true });
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.symlinkSync(path.join(dataDir, "identity"), path.join(openclawDir, "identity"));

    const result = runShell(
      `${ENSURE_IDENTITY_SYMLINK}\nensure_identity_symlink "${dataDir}" "${openclawDir}"`,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("[setup]"); // no action taken
  });

  it("repairs symlink pointing to wrong target", () => {
    const dataDir = path.join(tmpDir, ".openclaw-data");
    const openclawDir = path.join(tmpDir, ".openclaw");
    fs.mkdirSync(path.join(dataDir, "identity"), { recursive: true });
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.symlinkSync("/wrong/target", path.join(openclawDir, "identity"));

    const result = runShell(
      `${ENSURE_IDENTITY_SYMLINK}\nensure_identity_symlink "${dataDir}" "${openclawDir}"`,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("repaired identity symlink");
    expect(fs.readlinkSync(path.join(openclawDir, "identity"))).toBe(
      path.join(dataDir, "identity"),
    );
  });

  it("backs up non-symlink entry and creates symlink", () => {
    const dataDir = path.join(tmpDir, ".openclaw-data");
    const openclawDir = path.join(tmpDir, ".openclaw");
    fs.mkdirSync(path.join(dataDir, "identity"), { recursive: true });
    fs.mkdirSync(path.join(openclawDir, "identity"), { recursive: true });
    fs.writeFileSync(path.join(openclawDir, "identity", "marker"), "old-data");

    const result = runShell(
      `${ENSURE_IDENTITY_SYMLINK}\nensure_identity_symlink "${dataDir}" "${openclawDir}"`,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("replaced non-symlink identity path");
    expect(fs.lstatSync(path.join(openclawDir, "identity")).isSymbolicLink()).toBe(true);
    // Backup should exist
    const backups = fs.readdirSync(openclawDir).filter((f) => f.startsWith("identity.bak."));
    expect(backups.length).toBe(1);
    expect(fs.readFileSync(path.join(openclawDir, backups[0], "marker"), "utf-8")).toBe("old-data");
  });
});

describe("fix_openclaw_data_ownership", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ownership-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates expected subdirectories", () => {
    const dataDir = path.join(tmpDir, ".openclaw-data");
    fs.mkdirSync(dataDir, { recursive: true });

    const funcs = `${ENSURE_IDENTITY_SYMLINK}\n${FIX_OPENCLAW_DATA_OWNERSHIP}`;
    const result = runShell(`${funcs}\nfix_openclaw_data_ownership`, { HOME: tmpDir });

    expect(result.status).toBe(0);
    for (const sub of [
      "agents/main/agent",
      "extensions",
      "workspace",
      "skills",
      "hooks",
      "identity",
      "devices",
      "canvas",
      "cron",
    ]) {
      expect(fs.existsSync(path.join(dataDir, sub))).toBe(true);
    }
  });

  it("does nothing when .openclaw-data does not exist", () => {
    const funcs = `${ENSURE_IDENTITY_SYMLINK}\n${FIX_OPENCLAW_DATA_OWNERSHIP}`;
    const result = runShell(`${funcs}\nfix_openclaw_data_ownership`, { HOME: tmpDir });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("[setup]"); // no action taken
  });
});
