// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  downloadReviewedNpmArchives,
  type ReviewedNpmArchivePin,
} from "../../scripts/checks/download-reviewed-npm-archives.mts";

/** Build a reviewed archive pin for fixture bytes. */
function pin(name: string, bytes: Buffer): ReviewedNpmArchivePin {
  return {
    archive: `${name}-1.0.0.tgz`,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    url: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
  };
}

let testRoot = "";

beforeEach(() => {
  testRoot = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reviewed-archives-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(testRoot, { force: true, recursive: true });
});

describe("reviewed npm archive downloads", () => {
  it("publishes every SHA-256 verified archive read-only", async () => {
    const alpha = Buffer.from("alpha archive");
    const beta = Buffer.from("beta archive");
    const pins = [pin("alpha", alpha), pin("beta", beta)];
    const sources = new Map([
      [pins[0].url, alpha],
      [pins[1].url, beta],
    ]);
    const output = path.join(testRoot, "archives");

    await downloadReviewedNpmArchives({
      downloadArchive: async (archive) => sources.get(archive.url)!,
      output,
      pins,
    });

    expect(readFileSync(path.join(output, pins[0].archive))).toEqual(alpha);
    expect(readFileSync(path.join(output, pins[1].archive))).toEqual(beta);
    expect(statSync(path.join(output, pins[0].archive)).mode & 0o777).toBe(0o444);
    expect(statSync(path.join(output, pins[1].archive)).mode & 0o777).toBe(0o444);
  });

  it("removes partial output when one archive fails SHA-256 validation", async () => {
    const alpha = Buffer.from("alpha archive");
    const beta = Buffer.from("beta archive");
    const pins = [pin("alpha", alpha), pin("beta", beta)];
    const output = path.join(testRoot, "archives");

    await expect(
      downloadReviewedNpmArchives({
        downloadArchive: async (archive) =>
          archive.archive === pins[0].archive ? alpha : Buffer.from("substituted archive"),
        output,
        pins,
      }),
    ).rejects.toThrow(`downloaded npm archive failed SHA-256 validation: ${pins[1].archive}`);
    expect(existsSync(output)).toBe(false);
  });

  it("downloads a chunked archive without a content-length header", async () => {
    const chunks = [Buffer.from("alpha "), Buffer.from("archive")];
    const bytes = Buffer.concat(chunks);
    const archive = pin("alpha", bytes);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(chunks).stream(), { status: 200 })),
    );
    const output = path.join(testRoot, "archives");

    await downloadReviewedNpmArchives({ output, pins: [archive] });

    expect(readFileSync(path.join(output, archive.archive))).toEqual(bytes);
  });

  it("stops a chunked archive when it exceeds the streaming size limit", async () => {
    const chunks = Array.from({ length: 33 }, () => new Uint8Array(1024 * 1024));
    const archive = pin("alpha", Buffer.from("unused digest"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(chunks).stream(), { status: 200 })),
    );
    const output = path.join(testRoot, "archives");

    await expect(downloadReviewedNpmArchives({ output, pins: [archive] })).rejects.toThrow(
      `downloaded npm archive size is invalid: ${archive.archive}`,
    );
    expect(existsSync(output)).toBe(false);
  });

  it.each([
    {
      changed: { url: "https://packages.example.test/alpha-1.0.0.tgz" },
      error: "reviewed npm archive URL must use https://registry.npmjs.org",
      name: "foreign registry",
    },
    {
      changed: { archive: "../alpha-1.0.0.tgz" },
      error: "reviewed npm archive name must be one literal .tgz filename",
      name: "traversal archive name",
    },
    {
      changed: { sha256: "0".repeat(63) },
      error: "reviewed npm archive SHA-256 must be 64 lowercase hexadecimal characters",
      name: "malformed digest",
    },
  ])("rejects a $name before download", async ({ changed, error }) => {
    const bytes = Buffer.from("alpha archive");
    const downloadArchive = vi.fn(async () => bytes);
    const output = path.join(testRoot, "archives");

    await expect(
      downloadReviewedNpmArchives({
        downloadArchive,
        output,
        pins: [{ ...pin("alpha", bytes), ...changed }],
      }),
    ).rejects.toThrow(error);
    expect(downloadArchive).not.toHaveBeenCalled();
    expect(existsSync(output)).toBe(false);
  });

  it("rejects duplicate destinations before download", async () => {
    const bytes = Buffer.from("alpha archive");
    const first = pin("alpha", bytes);
    const downloadArchive = vi.fn(async () => bytes);

    await expect(
      downloadReviewedNpmArchives({
        downloadArchive,
        output: path.join(testRoot, "archives"),
        pins: [first, { ...pin("beta", bytes), archive: first.archive }],
      }),
    ).rejects.toThrow("reviewed npm archive names and URLs must be unique");
    expect(downloadArchive).not.toHaveBeenCalled();
  });
});
