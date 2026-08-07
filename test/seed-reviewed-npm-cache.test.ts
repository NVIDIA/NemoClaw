// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { type CachePut, seedReviewedNpmCache } from "../scripts/lib/seed-reviewed-npm-cache.mts";

const PACKAGE_NAME = "@example/reviewed";
const PACKAGE_SPEC = `${PACKAGE_NAME}@1.2.3`;
const REGISTRY_ORIGIN = "https://registry.npmjs.org/";
const TARBALL_URL = "https://registry.npmjs.org/@example/reviewed/-/reviewed-1.2.3.tgz";
const roots: string[] = [];

type PutCall = Readonly<{
  cachePath: string;
  data: Buffer;
  key: string;
  metadata?: Readonly<Record<string, unknown>>;
}>;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-npm-cache-seed-"));
  roots.push(root);
  const archivePath = path.join(root, "reviewed-1.2.3.tgz");
  const archive = Buffer.from("exact reviewed archive bytes");
  fs.writeFileSync(archivePath, archive);
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  const lockfilePath = path.join(root, "package-lock.json");
  fs.writeFileSync(
    lockfilePath,
    JSON.stringify({
      lockfileVersion: 3,
      name: "cache-seed-fixture",
      packages: {
        "": { dependencies: { [PACKAGE_NAME]: "1.2.3" } },
        [`node_modules/${PACKAGE_NAME}`]: {
          integrity,
          resolved: TARBALL_URL,
          version: "1.2.3",
        },
      },
      version: "1.0.0",
    }),
  );
  const cacheDirectory = path.join(root, "cache");
  fs.mkdirSync(cacheDirectory);
  return { archive, archivePath, cacheDirectory, integrity, lockfilePath, root };
}

function request(
  input: ReturnType<typeof fixture>,
  archives = new Map([[PACKAGE_SPEC, input.archivePath]]),
) {
  return {
    archives,
    cacheDirectory: input.cacheDirectory,
    lockfilePath: input.lockfilePath,
    registryOrigin: REGISTRY_ORIGIN,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("reviewed npm cache seed", () => {
  it("seeds verified tarball and packument records from an exact local archive", async () => {
    const input = fixture();
    const calls: PutCall[] = [];
    const put: CachePut = async (cachePath, key, data, options) => {
      calls.push({ cachePath, data, key, metadata: options?.metadata });
    };

    await expect(seedReviewedNpmCache(request(input), put)).resolves.toEqual([PACKAGE_SPEC]);

    expect(calls).toHaveLength(4);
    expect(calls.map(({ key }) => key)).toEqual([
      `make-fetch-happen:request-cache:${TARBALL_URL}`,
      `pacote:tarball:${PACKAGE_SPEC}`,
      "make-fetch-happen:request-cache:https://registry.npmjs.org/@example%2freviewed",
      "make-fetch-happen:request-cache:https://registry.npmjs.org/@example%2freviewed",
    ]);
    expect(calls.slice(0, 2).map(({ data }) => data)).toEqual([input.archive, input.archive]);
    expect(
      calls.every(({ cachePath }) => cachePath === path.join(input.cacheDirectory, "_cacache")),
    ).toBe(true);
    expect(calls[2]?.data.toString()).toContain(`"integrity":"${input.integrity}"`);
    expect(calls[2]?.data.toString()).toContain(`"tarball":"${TARBALL_URL}"`);
  });

  it("rejects missing, extra, and integrity-mismatched archives", async () => {
    const input = fixture();
    await expect(
      seedReviewedNpmCache(request(input, new Map()), async () => undefined),
    ).rejects.toThrow(`archive is missing: ${PACKAGE_SPEC}`);
    await expect(
      seedReviewedNpmCache(
        request(
          input,
          new Map([
            [PACKAGE_SPEC, input.archivePath],
            ["unexpected@9.9.9", input.archivePath],
          ]),
        ),
        async () => undefined,
      ),
    ).rejects.toThrow("received unlocked archives: unexpected@9.9.9");
    fs.writeFileSync(input.archivePath, "drifted archive bytes");
    await expect(seedReviewedNpmCache(request(input), async () => undefined)).rejects.toThrow(
      `integrity mismatch for ${PACKAGE_SPEC}`,
    );
  });

  it("rejects archive symlinks and non-HTTPS registry origins", async () => {
    const input = fixture();
    const symlinkPath = path.join(input.root, "reviewed-link.tgz");
    fs.symlinkSync(input.archivePath, symlinkPath);
    await expect(
      seedReviewedNpmCache(
        request(input, new Map([[PACKAGE_SPEC, symlinkPath]])),
        async () => undefined,
      ),
    ).rejects.toThrow("archive must be a non-symlink regular file");
    await expect(
      seedReviewedNpmCache(
        { ...request(input), registryOrigin: "http://registry.npmjs.org/" },
        async () => undefined,
      ),
    ).rejects.toThrow("registry origin is invalid");
  });
});
