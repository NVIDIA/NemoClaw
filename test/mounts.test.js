// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── fs mock (must be hoisted before module import) ───────────────────────────

const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("fs", () => ({ default: mockFs, ...mockFs }));

const { validateMountPath, parseMountsFromYaml, addMountToPolicy } =
  await import("../bin/lib/mounts");

// ── validateMountPath ─────────────────────────────────────────────────────────

describe("validateMountPath", () => {
  it("returns the path unchanged for a valid absolute path", () => {
    expect(validateMountPath("/data/models", "host_path")).toBe("/data/models");
  });

  it("rejects a path containing .. components", () => {
    expect(() => validateMountPath("/data/../etc/passwd", "host_path")).toThrow(/path traversal/);
  });

  it("rejects a relative path", () => {
    expect(() => validateMountPath("data/models", "host_path")).toThrow(/absolute path/);
  });

  it("rejects a path containing null bytes", () => {
    expect(() => validateMountPath("/data/mo\0dels", "host_path")).toThrow(/null bytes/);
  });
});

// ── parseMountsFromYaml ───────────────────────────────────────────────────────

describe("parseMountsFromYaml", () => {
  it("returns [] for an inline empty mounts section", () => {
    const yaml = "version: 1\nmounts: []\nnetwork_policies:\n  - host: x.com\n";
    expect(parseMountsFromYaml(yaml)).toEqual([]);
  });

  it("returns [] when the mounts section is absent", () => {
    expect(parseMountsFromYaml("version: 1\nnetwork_policies:\n")).toEqual([]);
  });

  it("parses a single read-write mount", () => {
    const yaml = ["mounts:", "  - host_path: /data/models", "    container_path: /mnt/models"].join(
      "\n",
    );
    expect(parseMountsFromYaml(yaml)).toEqual([
      { host_path: "/data/models", container_path: "/mnt/models" },
    ]);
  });

  it("parses a read-only mount", () => {
    const yaml = [
      "mounts:",
      "  - host_path: /data/weights",
      "    container_path: /mnt/weights",
      "    read_only: true",
    ].join("\n");
    expect(parseMountsFromYaml(yaml)).toEqual([
      { host_path: "/data/weights", container_path: "/mnt/weights", read_only: true },
    ]);
  });

  it("parses multiple mount entries", () => {
    const yaml = [
      "mounts:",
      "  - host_path: /data/a",
      "    container_path: /mnt/a",
      "  - host_path: /data/b",
      "    container_path: /mnt/b",
      "    read_only: true",
    ].join("\n");
    const result = parseMountsFromYaml(yaml);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ host_path: "/data/a", container_path: "/mnt/a" });
    expect(result[1]).toEqual({ host_path: "/data/b", container_path: "/mnt/b", read_only: true });
  });

  it("filters out malformed entries missing container_path", () => {
    const yaml = [
      "mounts:",
      "  - host_path: /data/orphan",
      "  - host_path: /data/ok",
      "    container_path: /mnt/ok",
    ].join("\n");
    const result = parseMountsFromYaml(yaml);
    expect(result).toHaveLength(1);
    expect(result[0].host_path).toBe("/data/ok");
  });

  it("filters out malformed entries missing host_path", () => {
    const yaml = [
      "mounts:",
      "  - container_path: /mnt/orphan",
      "  - host_path: /data/ok",
      "    container_path: /mnt/ok",
    ].join("\n");
    const result = parseMountsFromYaml(yaml);
    expect(result).toHaveLength(1);
    expect(result[0].container_path).toBe("/mnt/ok");
  });
});

// ── addMountToPolicy ──────────────────────────────────────────────────────────

// TODO: fix fs mock for CJS module — tracked for follow-up
// The issue: this test file is ESM (Vitest), but bin/lib/mounts.js is CJS and uses
// require('fs'). vi.mock('fs', ...) should intercept it via Vitest's module registry,
// but CJS require() bypasses Vitest's ESM mock hoisting — so the mock is never applied
// and the real fs hits the actual POLICY_FILE path on disk. Fix options:
//   1. Convert mounts.js to ESM so vi.mock('node:fs') works normally, or
//   2. Use vi.spyOn(fs, 'existsSync') etc. after requiring the module via createRequire, or
//   3. Extract a testable pure-function layer and test that instead.
describe.skip("addMountToPolicy", () => {
  beforeEach(() => {
    mockFs.existsSync.mockReset();
    mockFs.readFileSync.mockReset();
    mockFs.writeFileSync.mockReset();
  });

  it("appends a new mount entry and returns true", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue("version: 1\nmounts: []\n");

    const result = addMountToPolicy("/data/models", "/mnt/models", false);

    expect(result).toBe(true);
    expect(mockFs.writeFileSync).toHaveBeenCalledOnce();
    const written = mockFs.writeFileSync.mock.calls[0][1];
    expect(written).toContain("host_path: /data/models");
    expect(written).toContain("container_path: /mnt/models");
  });

  it("skips writing and returns false when the entry already exists", () => {
    const existing = [
      "version: 1",
      "mounts:",
      "  - host_path: /data/models",
      "    container_path: /mnt/models",
    ].join("\n");
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(existing);

    const result = addMountToPolicy("/data/models", "/mnt/models", false);

    expect(result).toBe(false);
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });

  it("includes read_only: true in the written entry when requested", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue("version: 1\nmounts: []\n");

    addMountToPolicy("/data/weights", "/mnt/weights", true);

    const written = mockFs.writeFileSync.mock.calls[0][1];
    expect(written).toContain("read_only: true");
  });

  it("throws when the policy file does not exist", () => {
    mockFs.existsSync.mockReturnValue(false);

    expect(() => addMountToPolicy("/data/models", "/mnt/models", false)).toThrow(
      /Policy file not found/,
    );
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });
});
