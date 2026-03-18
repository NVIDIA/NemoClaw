// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import type { BlueprintManifest } from "./resolve.js";

// ---------------------------------------------------------------------------
// Mocks — control what computeDirectoryDigest sees on the filesystem
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

/** Compute the expected SHA-256 digest for a flat directory with the given files. */
function expectedDigest(files: MockFile[]): string {
  const hash = createHash("sha256");
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sorted) {
    hash.update(f.path);
    hash.update(f.content);
  }
  return hash.digest("hex");
}

/** Set up fs mocks for a flat directory with the given files. */
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
    it("returns valid: false with error when digest does not match", () => {
      mockDirectory(MOCK_FILES);
      const manifest = makeManifest({ digest: "wrong-digest-value" });

      const result = verifyBlueprintDigest("/fake/path", manifest);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("Digest mismatch");
      expect(result.errors[0]).toContain("wrong-digest-value");
      expect(result.errors[0]).toContain(result.actualDigest);
    });
  });

  describe("empty digest — the bug fix", () => {
    it("returns valid: false when manifest.digest is empty string", () => {
      mockDirectory(MOCK_FILES);
      const manifest = makeManifest({ digest: "" });

      const result = verifyBlueprintDigest("/fake/path", manifest);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("missing");
    });

    it("returns valid: false when digest is undefined", () => {
      mockDirectory(MOCK_FILES);
      const manifest = makeManifest({ digest: undefined as unknown as string });

      const result = verifyBlueprintDigest("/fake/path", manifest);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("missing");
    });
  });

  describe("result fields", () => {
    it("populates actualDigest from directory computation", () => {
      mockDirectory(MOCK_FILES);
      const digest = expectedDigest(MOCK_FILES);
      const manifest = makeManifest({ digest });

      const result = verifyBlueprintDigest("/fake/path", manifest);

      expect(result.actualDigest).toBe(digest);
    });

    it("populates expectedDigest from manifest.digest", () => {
      mockDirectory(MOCK_FILES);
      const manifest = makeManifest({ digest: "custom-expected-value" });

      const result = verifyBlueprintDigest("/fake/path", manifest);

      expect(result.expectedDigest).toBe("custom-expected-value");
    });
  });

  describe("multi-file directory", () => {
    it("computes digest across all files sorted by path", () => {
      // Files in non-sorted order — digest should still match
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
  describe("versions satisfied", () => {
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
  });

  describe("newer actual version", () => {
    it("accepts newer major version", () => {
      const manifest = makeManifest({ minOpenShellVersion: "1.0.0" });
      expect(checkCompatibility(manifest, "2.0.0", "99.0.0")).toEqual([]);
    });

    it("accepts newer minor version", () => {
      const manifest = makeManifest({ minOpenShellVersion: "1.0.0" });
      expect(checkCompatibility(manifest, "1.1.0", "99.0.0")).toEqual([]);
    });

    it("accepts newer patch version", () => {
      const manifest = makeManifest({ minOpenShellVersion: "1.0.0" });
      expect(checkCompatibility(manifest, "1.0.1", "99.0.0")).toEqual([]);
    });
  });

  describe("older actual version — should fail", () => {
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

    it("returns two errors when both versions are too old", () => {
      const manifest = makeManifest({
        minOpenShellVersion: "2.0.0",
        minOpenClawVersion: "3.0.0",
      });

      const errors = checkCompatibility(manifest, "1.0.0", "2.0.0");

      expect(errors).toHaveLength(2);
    });
  });

  describe("missing minimum version — skips check", () => {
    it("skips openshell check when minOpenShellVersion is empty", () => {
      const manifest = makeManifest({ minOpenShellVersion: "" });

      const errors = checkCompatibility(manifest, "0.0.1", "99.0.0");

      // No error for openshell despite very old version
      const openshellErrors = errors.filter((e) => e.includes("OpenShell"));
      expect(openshellErrors).toEqual([]);
    });

    it("skips openclaw check when minOpenClawVersion is empty", () => {
      const manifest = makeManifest({ minOpenClawVersion: "" });

      const errors = checkCompatibility(manifest, "99.0.0", "0.0.1");

      const openclawErrors = errors.filter((e) => e.includes("OpenClaw"));
      expect(openclawErrors).toEqual([]);
    });
  });

  describe("version string edge cases", () => {
    it("handles two-segment versions like '1.0'", () => {
      const manifest = makeManifest({ minOpenShellVersion: "1.0.0" });

      // "1.0" should satisfy "1.0.0" — missing segment treated as 0
      const errors = checkCompatibility(manifest, "1.0", "99.0.0");

      expect(errors).toEqual([]);
    });

    it("handles four-segment versions", () => {
      const manifest = makeManifest({ minOpenShellVersion: "1.0.0" });

      const errors = checkCompatibility(manifest, "1.0.0.1", "99.0.0");

      expect(errors).toEqual([]);
    });

    it("handles year-based versions like '2026.3.11'", () => {
      const manifest = makeManifest({ minOpenClawVersion: "2026.3.0" });

      const errors = checkCompatibility(manifest, "99.0.0", "2026.3.11");

      expect(errors).toEqual([]);
    });
  });
});
