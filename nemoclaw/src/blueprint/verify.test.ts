// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import type { BlueprintManifest } from "./resolve.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
}));

const { readFileSync, readdirSync, statSync } = await import("node:fs");
const { verifyBlueprintDigest, checkCompatibility } = await import("./verify.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockFile {
  path: string;
  content: string;
}

function expectedDigest(files: MockFile[]): string {
  const hash = createHash("sha256");
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sorted) {
    hash.update(f.path);
    hash.update(f.content);
  }
  return hash.digest("hex");
}

function mockDirectory(files: MockFile[]): void {
  vi.mocked(readdirSync).mockReturnValue(
    files.map((f) => f.path) as unknown as ReturnType<typeof readdirSync>,
  );
  vi.mocked(statSync).mockReturnValue({
    isDirectory: () => false,
  } as ReturnType<typeof statSync>);
  vi.mocked(readFileSync).mockImplementation((filePath: unknown) => {
    const p = String(filePath);
    const file = files.find((f) => p.endsWith(f.path));
    return Buffer.from(file?.content ?? "");
  });
}

function makeManifest(overrides: Partial<BlueprintManifest> = {}): BlueprintManifest {
  return {
    version: "1.0.0",
    minOpenShellVersion: "0.1.0",
    minOpenClawVersion: "0.1.0",
    profiles: ["default"],
    digest: "placeholder",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const MOCK_FILES: MockFile[] = [
  { path: "blueprint.yaml", content: "version: 1.0.0\ndigest: abc" },
  { path: "runner.py", content: "print('hello')" },
];

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// verifyBlueprintDigest
// ---------------------------------------------------------------------------

describe("verifyBlueprintDigest", () => {
  describe("happy path", () => {
    it("returns valid: true when digest matches", () => {
      mockDirectory(MOCK_FILES);
      const digest = expectedDigest(MOCK_FILES);
      const manifest = makeManifest({ digest });

      const result = verifyBlueprintDigest("/fake/path", manifest);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.actualDigest).toBe(digest);
      expect(result.expectedDigest).toBe(digest);
    });
  });

  describe("digest mismatch", () => {
    it("returns valid: false when digest does not match", () => {
      mockDirectory(MOCK_FILES);
      const actual = expectedDigest(MOCK_FILES);
      // A valid-format but wrong digest
      const wrong = "a".repeat(64);
      const manifest = makeManifest({ digest: wrong });

      const result = verifyBlueprintDigest("/fake/path", manifest);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("Digest mismatch");
      expect(result.errors[0]).toContain(wrong);
      expect(result.errors[0]).toContain(actual);
    });
  });

  describe("empty digest — bypass prevention", () => {
    it("rejects empty string digest", () => {
      mockDirectory(MOCK_FILES);
      const manifest = makeManifest({ digest: "" });

      const result = verifyBlueprintDigest("/fake/path", manifest);

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([
        "Blueprint manifest is missing a digest — cannot verify integrity",
      ]);
    });

    it("rejects undefined digest", () => {
      mockDirectory(MOCK_FILES);
      const manifest = makeManifest({ digest: undefined as unknown as string });

      const result = verifyBlueprintDigest("/fake/path", manifest);

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([
        "Blueprint manifest is missing a digest — cannot verify integrity",
      ]);
    });

    it("rejects whitespace-only digest", () => {
      mockDirectory(MOCK_FILES);
      const manifest = makeManifest({ digest: "   " });

      const result = verifyBlueprintDigest("/fake/path", manifest);

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([
        "Blueprint manifest is missing a digest — cannot verify integrity",
      ]);
    });

    it("skips directory hashing when digest is missing", () => {
      mockDirectory(MOCK_FILES);
      const manifest = makeManifest({ digest: "" });

      verifyBlueprintDigest("/fake/path", manifest);

      expect(readdirSync).not.toHaveBeenCalled();
    });
  });

  describe("digest format validation", () => {
    it("rejects truncated hex string", () => {
      mockDirectory(MOCK_FILES);
      const manifest = makeManifest({ digest: "abcdef1234" });

      const result = verifyBlueprintDigest("/fake/path", manifest);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("format is invalid");
    });

    it("rejects uppercase hex characters", () => {
      mockDirectory(MOCK_FILES);
      const manifest = makeManifest({ digest: "A".repeat(64) });

      const result = verifyBlueprintDigest("/fake/path", manifest);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("format is invalid");
    });

    it("rejects non-hex characters", () => {
      mockDirectory(MOCK_FILES);
      const manifest = makeManifest({ digest: "g".repeat(64) });

      const result = verifyBlueprintDigest("/fake/path", manifest);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("format is invalid");
    });

    it("rejects digest with sha256: prefix", () => {
      mockDirectory(MOCK_FILES);
      const manifest = makeManifest({ digest: "sha256:" + "a".repeat(64) });

      const result = verifyBlueprintDigest("/fake/path", manifest);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("format is invalid");
    });

    it("skips directory hashing when format is invalid", () => {
      mockDirectory(MOCK_FILES);
      const manifest = makeManifest({ digest: "not-a-digest" });

      verifyBlueprintDigest("/fake/path", manifest);

      expect(readdirSync).not.toHaveBeenCalled();
    });
  });

  describe("multi-file directory", () => {
    it("computes digest across all files sorted by path", () => {
      const unsortedFiles: MockFile[] = [
        { path: "c.txt", content: "third" },
        { path: "a.txt", content: "first" },
        { path: "b.txt", content: "second" },
      ];
      mockDirectory(unsortedFiles);
      const digest = expectedDigest(unsortedFiles);
      const manifest = makeManifest({ digest });

      const result = verifyBlueprintDigest("/fake/path", manifest);

      expect(result.valid).toBe(true);
      expect(result.actualDigest).toBe(digest);
    });
  });
});

// ---------------------------------------------------------------------------
// checkCompatibility
// ---------------------------------------------------------------------------

describe("checkCompatibility", () => {
  it("returns no errors when all versions meet minimums", () => {
    const manifest = makeManifest({
      minOpenShellVersion: "1.0.0",
      minOpenClawVersion: "2.0.0",
    });

    const errors = checkCompatibility(manifest, "1.2.0", "2.5.0");

    expect(errors).toEqual([]);
  });

  it("returns no errors when actual equals minimum", () => {
    const manifest = makeManifest({
      minOpenShellVersion: "1.0.0",
      minOpenClawVersion: "2.0.0",
    });

    const errors = checkCompatibility(manifest, "1.0.0", "2.0.0");

    expect(errors).toEqual([]);
  });

  it("returns error when openshell version is too old", () => {
    const manifest = makeManifest({ minOpenShellVersion: "1.0.0" });

    const errors = checkCompatibility(manifest, "0.9.0", "99.0.0");

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("OpenShell");
  });

  it("returns error when openclaw version is too old", () => {
    const manifest = makeManifest({ minOpenClawVersion: "2.0.0" });

    const errors = checkCompatibility(manifest, "99.0.0", "1.9.0");

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("OpenClaw");
  });

  it("skips check when minimum version is empty", () => {
    const manifest = makeManifest({
      minOpenShellVersion: "",
      minOpenClawVersion: "",
    });

    const errors = checkCompatibility(manifest, "0.0.1", "0.0.1");

    expect(errors).toEqual([]);
  });
});
