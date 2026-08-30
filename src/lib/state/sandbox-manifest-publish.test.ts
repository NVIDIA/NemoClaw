// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __test,
  clearRebuildPolicyHandoff,
  readRebuildPolicyHandoff,
  type RebuildManifest,
  writeRebuildPolicyHandoff,
} from "./sandbox.js";

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

describe("bounded rebuild policy handoff", () => {
  it("binds exact content, rejects tampering, and retires manifest authority before cleanup", () => {
    const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-handoff-"));
    tempDirs.push(backupPath);
    const published = manifest(backupPath);
    __test.writeManifest(backupPath, published);

    const policy = "version: 1\nnetwork_policies:\n  host_preserved: {}\n";
    const withHandoff = writeRebuildPolicyHandoff(published, policy);
    const handoffPath = path.join(backupPath, withHandoff.rebuildPolicyHandoff!.file);
    expect(readRebuildPolicyHandoff(withHandoff)).toBe(policy);
    const descriptor = fs.openSync(handoffPath, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
    try {
      expect(fs.fstatSync(descriptor).mode & 0o777).toBe(0o600);
      fs.ftruncateSync(descriptor, 0);
      fs.writeSync(descriptor, `${policy}  raced: {}\n`, 0, "utf8");
      fs.fsyncSync(descriptor);
      expect(readRebuildPolicyHandoff(withHandoff)).toBeNull();
      fs.ftruncateSync(descriptor, 0);
      fs.writeSync(descriptor, policy, 0, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }

    expect(clearRebuildPolicyHandoff(withHandoff)).toBe(true);
    expect(fs.existsSync(handoffPath)).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(path.join(backupPath, "rebuild-manifest.json"), "utf8")),
    ).not.toHaveProperty("rebuildPolicyHandoff");
  });

  it("retains cleanup identity after deletion fails and removes it on retry", () => {
    const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-cleanup-"));
    tempDirs.push(backupPath);
    const published = manifest(backupPath);
    __test.writeManifest(backupPath, published);
    const withHandoff = writeRebuildPolicyHandoff(
      published,
      "version: 1\nnetwork_policies: {}\n",
    );
    const handoffPath = path.join(backupPath, withHandoff.rebuildPolicyHandoff!.file);

    expect(
      clearRebuildPolicyHandoff(withHandoff, {
        remove: vi.fn(() => {
          throw new Error("injected deletion failure");
        }),
      }),
    ).toBe(false);
    expect(withHandoff.rebuildPolicyHandoff).toMatchObject({ retired: true });
    expect(readRebuildPolicyHandoff(withHandoff)).toBeNull();
    expect(fs.existsSync(handoffPath)).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(backupPath, "rebuild-manifest.json"), "utf8")),
    ).toMatchObject({ rebuildPolicyHandoff: { retired: true } });

    expect(clearRebuildPolicyHandoff(withHandoff)).toBe(true);
    expect(fs.existsSync(handoffPath)).toBe(false);
    expect(withHandoff).not.toHaveProperty("rebuildPolicyHandoff");
  });
});
