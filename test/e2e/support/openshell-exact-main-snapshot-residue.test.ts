// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DCODE_MCP_SNAPSHOT_RESIDUE_PROBE } from "../live/openshell-exact-main-mcp-proof.ts";

describe("Deep Agents snapshot residue verification", () => {
  let root: string;
  let directory: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "nemoclaw-snapshot-residue-"));
    directory = path.join(root, "snapshot");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function runProbe() {
    const source = DCODE_MCP_SNAPSHOT_RESIDUE_PROBE.replace(
      'Path("/run/nemoclaw-dcode-mcp")',
      `Path(${JSON.stringify(directory)})`,
    );
    return spawnSync("python3", ["-I", "-c", source], { encoding: "utf8" });
  }

  it("accepts an empty directory", () => {
    mkdirSync(directory);
    const result = runProbe();
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects a directory with a leftover file", () => {
    mkdirSync(directory);
    writeFileSync(path.join(directory, "leftover"), "proof");
    const result = runProbe();
    expect(result.status, result.stderr).toBe(1);
  });

  it("rejects a missing directory", () => {
    const result = runProbe();
    expect(result.status, result.stderr).toBe(1);
  });

  it("rejects a regular file in place of the directory", () => {
    writeFileSync(directory, "proof");
    const result = runProbe();
    expect(result.status, result.stderr).toBe(1);
  });

  it("rejects a directory read error", () => {
    const harness = [
      "import sys",
      "from unittest.mock import patch",
      "with patch('pathlib.Path.iterdir', side_effect=PermissionError('directory read denied')):",
      "    exec(sys.argv[1])",
    ].join("\n");
    const result = spawnSync("python3", ["-I", "-c", harness, DCODE_MCP_SNAPSHOT_RESIDUE_PROBE], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("PermissionError: directory read denied");
  });
});
