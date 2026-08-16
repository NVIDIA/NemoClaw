// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  listValidatedArtifactZipEntries,
  readValidatedArtifactZipEntry,
  readValidatedArtifactZipEntryBytes,
} from "../../../scripts/scorecard/read-artifact-zip.mts";
import { artifactZip } from "../../helpers/artifact-zip";

const structuralMutations: Array<
  [string, (archive: Buffer, centralOffset: number) => void]
> = [
  [
    "link",
    (archive, centralOffset) =>
      archive.writeUInt32LE(0xa0000000, centralOffset + 38),
  ],
  [
    "encrypted",
    (archive, centralOffset) => {
      archive.writeUInt16LE(0x0801, 6);
      archive.writeUInt16LE(0x0801, centralOffset + 8);
    },
  ],
  ["local-header-mismatched", (archive) => archive.writeUInt16LE(8, 8)],
];

describe("validated GitHub artifact ZIP reader", () => {
  it("lists only structurally valid regular files", () => {
    const archive = artifactZip([
      { name: "e2e/runner-pressure-classification.jsonl", contents: "safe" },
      { name: "e2e/retry/provider.json", contents: "{}" },
    ]);

    expect(
      listValidatedArtifactZipEntries(archive, { maxEntries: 10 }),
    ).toEqual([
      "e2e/retry/provider.json",
      "e2e/runner-pressure-classification.jsonl",
    ]);
    expect(
      listValidatedArtifactZipEntries(archive, { maxEntries: 1 }),
    ).toBeNull();
  });

  it("rejects duplicate, linked, and invalid UTF-8 names while listing", () => {
    expect(
      listValidatedArtifactZipEntries(
        artifactZip([
          { name: "same.json", contents: "one" },
          { name: "same.json", contents: "two" },
        ]),
        {},
      ),
    ).toBeNull();
    const linked = artifactZip([{ name: "summary.json", contents: "{}" }]);
    linked.writeUInt32LE(
      0xa0000000,
      linked.readUInt32LE(linked.length - 6) + 38,
    );
    expect(listValidatedArtifactZipEntries(linked, {})).toBeNull();
    const invalidUtf8 = artifactZip([{ name: "x.json", contents: "{}" }]);
    invalidUtf8[30] = 0xff;
    invalidUtf8[invalidUtf8.readUInt32LE(invalidUtf8.length - 6) + 46] = 0xff;
    expect(listValidatedArtifactZipEntries(invalidUtf8, {})).toBeNull();
  });

  it("reads only the exact safe relative entry from a multi-entry archive", () => {
    const archive = artifactZip([
      { name: "diagnostics/log.txt", contents: "ignored" },
      { name: "summary.json", contents: '{"safe":true}' },
      { name: "résumé.json", contents: '{"utf8":true}' },
    ]);

    expect(
      readValidatedArtifactZipEntry(archive, "summary.json", {
        maxBytes: 1_024,
      }),
    ).toBe('{"safe":true}');
    expect(
      readValidatedArtifactZipEntry(archive, "résumé.json", {
        maxBytes: 1_024,
      }),
    ).toBe('{"utf8":true}');
    expect(
      readValidatedArtifactZipEntryBytes(archive, "diagnostics/log.txt", {
        maxBytes: 1_024,
      }),
    ).toEqual(Buffer.from("ignored"));
    expect(
      readValidatedArtifactZipEntry(archive, "log.txt", { maxBytes: 1_024 }),
    ).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["absolute", "/summary.json"],
    ["parent", "../summary.json"],
    ["nested parent", "diagnostics/../summary.json"],
    ["backslash", "a\\b"],
    ["empty segment", "diagnostics//log.txt"],
    ["dot segment", "diagnostics/./log.txt"],
    ["trailing slash", "diagnostics/"],
    ["NUL byte", "diagnostics/\0log.txt"],
  ])("rejects unsafe requested path with %s", (_case, requestedPath) => {
    const archive = artifactZip([
      { name: requestedPath, contents: "unsafe" },
      { name: "summary.json", contents: '{"safe":true}' },
    ]);

    expect(
      readValidatedArtifactZipEntryBytes(archive, requestedPath, {
        maxBytes: 1_024,
      }),
    ).toBeNull();
  });

  it("rejects duplicate target entries and payloads over the caller's bound", () => {
    expect(
      readValidatedArtifactZipEntry(
        artifactZip([
          { name: "summary.json", contents: "one" },
          { name: "summary.json", contents: "two" },
        ]),
        "summary.json",
        { maxBytes: 1_024 },
      ),
    ).toBeNull();
    expect(
      readValidatedArtifactZipEntry(
        artifactZip([{ name: "summary.json", contents: "too large" }]),
        "summary.json",
        { maxBytes: 2 },
      ),
    ).toBeNull();
  });

  it("reads deflated entries and rejects corrupt compressed data", () => {
    const archive = artifactZip(
      [{ name: "summary.json", contents: '{"compressed":true}' }],
      8,
    );

    expect(
      readValidatedArtifactZipEntry(archive, "summary.json", {
        maxBytes: 1_024,
      }),
    ).toBe('{"compressed":true}');

    const corruptArchive = Buffer.from(archive);
    const compressedDataOffset =
      30 + corruptArchive.readUInt16LE(26) + corruptArchive.readUInt16LE(28);
    const compressedDataEnd =
      compressedDataOffset + corruptArchive.readUInt32LE(18);
    corruptArchive.fill(0, compressedDataOffset, compressedDataEnd);
    expect(
      readValidatedArtifactZipEntry(corruptArchive, "summary.json", {
        maxBytes: 1_024,
      }),
    ).toBeNull();
  });

  it.each(structuralMutations)(
    "rejects %s artifact entries",
    (_name, mutate) => {
      const archive = artifactZip([
        { name: "summary.json", contents: '{"safe":true}' },
      ]);
      const centralOffset = archive.readUInt32LE(archive.length - 6);
      mutate(archive, centralOffset);

      expect(
        readValidatedArtifactZipEntry(archive, "summary.json", {
          maxBytes: 1_024,
        }),
      ).toBeNull();
    },
  );
});
