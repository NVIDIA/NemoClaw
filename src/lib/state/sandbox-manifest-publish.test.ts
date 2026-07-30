// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { __test, type RebuildManifest } from "./sandbox.js";

const tempDirs: string[] = [];

function manifest(backupPath: string): RebuildManifest {
  return {
    version: 1,
    sandboxName: "alpha",
    timestamp: "2026-07-27T21-00-00-000Z",
    agentType: "openclaw",
    agentVersion: null,
    expectedVersion: null,
    stateDirs: [],
    failedBackupDirs: [],
    stateFiles: [],
    dir: "/sandbox",
    backupPath,
    blueprintDigest: "digest",
    policyPresets: [],
    customPolicies: [],
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("rebuild manifest publication", () => {
  it("publishes a complete private manifest with no visible temporary file", () => {
    const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-manifest-"));
    tempDirs.push(backupPath);

    const expected = manifest(backupPath);
    __test.writeManifest(backupPath, expected);

    const manifestPath = path.join(backupPath, "rebuild-manifest.json");
    expect(JSON.parse(fs.readFileSync(manifestPath, "utf8"))).toEqual(expected);
    expect(fs.statSync(manifestPath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(backupPath)).toEqual(["rebuild-manifest.json"]);
  });

  it("removes the unpublished temporary manifest when rename fails", () => {
    const remove = vi.fn();
    const rename = vi.fn(() => {
      throw new Error("rename failed");
    });

    expect(() =>
      __test.writeManifest("/backup", manifest("/backup"), {
        write: vi.fn(),
        rename,
        remove,
      }),
    ).toThrow("rename failed");

    const tempPath = path.join("/backup", `.rebuild-manifest.json.tmp.${String(process.pid)}`);
    expect(rename).toHaveBeenCalledWith(tempPath, path.join("/backup", "rebuild-manifest.json"));
    expect(remove).toHaveBeenCalledWith(tempPath, { force: true });
  });

  it("preserves the publish failure when temporary cleanup also fails", () => {
    expect(() =>
      __test.writeManifest("/backup", manifest("/backup"), {
        write: vi.fn(() => {
          throw new Error("write failed");
        }),
        rename: vi.fn(),
        remove: vi.fn(() => {
          throw new Error("cleanup failed");
        }),
      }),
    ).toThrow("write failed");
  });
});
