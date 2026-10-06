// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { formatConfigExportFailure } from "./config-export-diagnostics";

const missingIdentity = " The staging identity is unavailable. Do not remove files by name alone.";

describe("config export diagnostics", () => {
  it.each([
    {
      name: "existing destination",
      category: "output-conflict",
      fileState: { publication: "not-published", stagingCleanup: "complete" },
      diagnostic: "The output path already exists.",
    },
    {
      name: "failed publication",
      category: "unsafe-output",
      fileState: { publication: "not-published", stagingCleanup: "complete" },
      diagnostic: "The output path could not be published safely.",
    },
    {
      name: "unpublished staging residue",
      category: "unsafe-output",
      fileState: { publication: "not-published", stagingCleanup: "incomplete" },
      diagnostic:
        "The export was not published, and its staging file could not be removed." +
        missingIdentity,
    },
    {
      name: "failed finalization",
      category: "unsafe-output",
      fileState: {
        publication: "published",
        durability: "confirmed",
        location: "confirmed",
        stagingCleanup: "complete",
      },
      diagnostic: "The export was written, but output finalization failed.",
    },
    {
      name: "uncertain durability",
      category: "unsafe-output",
      fileState: {
        publication: "published",
        durability: "unknown",
        location: "confirmed",
        stagingCleanup: "complete",
      },
      diagnostic: "The export was written, but filesystem durability could not be confirmed.",
    },
    {
      name: "uncertain location",
      category: "unsafe-output",
      fileState: {
        publication: "published",
        durability: "confirmed",
        location: "unknown",
        stagingCleanup: "complete",
      },
      diagnostic: "The export was written, but the final output location could not be confirmed.",
    },
    {
      name: "published staging residue",
      category: "unsafe-output",
      fileState: {
        publication: "published",
        durability: "confirmed",
        location: "confirmed",
        stagingCleanup: "incomplete",
      },
      diagnostic:
        "The export was written, but staging cleanup could not be confirmed." + missingIdentity,
    },
    {
      name: "combined publication concerns",
      category: "unsafe-output",
      fileState: {
        publication: "published",
        durability: "unknown",
        location: "unknown",
        stagingCleanup: "incomplete",
      },
      diagnostic:
        "The export was written, but filesystem durability, the final output location, staging cleanup could not be confirmed." +
        missingIdentity,
    },
    {
      name: "uncertain publication",
      category: "unsafe-output",
      fileState: { publication: "unknown", stagingCleanup: "complete" },
      diagnostic:
        "The export may have been written, but its publication state could not be confirmed.",
    },
    {
      name: "uncertain publication with staging residue",
      category: "unsafe-output",
      fileState: { publication: "unknown", stagingCleanup: "incomplete" },
      diagnostic:
        "The export publication state and staging cleanup could not be confirmed." +
        missingIdentity,
    },
  ] as const)("describes $name", ({ category, fileState, diagnostic }) => {
    expect(
      formatConfigExportFailure({
        kind: "output",
        target: "file",
        category,
        fileState,
        stagingReference: null,
      }),
    ).toBe(`Config export failed (${category}): ${diagnostic}`);
  });

  it("describes a stdout failure", () => {
    expect(
      formatConfigExportFailure({ kind: "output", target: "stdout", category: "unsafe-output" }),
    ).toBe("Config export failed (unsafe-output): The export could not be written to stdout.");
  });

  it("lists each observation category once while preserving every finding", () => {
    expect(
      formatConfigExportFailure({
        kind: "observation",
        attempts: 1,
        findings: [
          { category: "drifted", field: "image", diagnostic: "Image changed." },
          { category: "drifted", field: "endpoint", diagnostic: "Endpoint changed." },
          { category: "unsupported", field: "profile", diagnostic: "Profile is unsupported." },
        ],
      }),
    ).toBe(
      "Config export failed (drifted, unsupported).\nImage changed.\nEndpoint changed.\nProfile is unsupported.",
    );
  });

  it("identifies retained staging and requires ownership checks before removal", () => {
    const diagnostic = formatConfigExportFailure({
      kind: "output",
      target: "file",
      category: "unsafe-output",
      fileState: { publication: "not-published", stagingCleanup: "incomplete" },
      stagingReference: {
        name: ".nemoclaw-export.123e4567-e89b-42d3-a456-426614174000.tmp",
        directoryDevice: 1,
        directoryInode: 2,
        fileDevice: 1,
        fileInode: 3,
      },
    });
    expect(diagnostic).toContain(
      "Staging file: .nemoclaw-export.123e4567-e89b-42d3-a456-426614174000.tmp; device 1, inode 3. Original output directory: device 1, inode 2.",
    );
    expect(diagnostic).toContain(
      "Locate that directory, which may have moved. Before manual removal, verify both identities and that the staging entry is a regular file. Do not remove the requested output file.",
    );
  });
});
