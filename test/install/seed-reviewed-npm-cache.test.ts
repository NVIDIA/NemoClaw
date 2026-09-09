// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type CachePut,
  lockedArchivesFromDirectory,
  seedReviewedNpmCache,
} from "../../scripts/lib/seed-reviewed-npm-cache.mts";

const PACKAGE_NAME = "@example/reviewed";
const PACKAGE_SPEC = `${PACKAGE_NAME}@1.2.3`;
const REGISTRY_ORIGIN = "https://registry.npmjs.org/";
const TARBALL_URL = "https://registry.npmjs.org/@example/reviewed/-/reviewed-1.2.3.tgz";
const TARGET = { cpu: "x64", libc: "glibc", os: "linux" } as const;
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
          bundleDependencies: ["bundled-child"],
          hasShrinkwrap: true,
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
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("reviewed npm cache seed", () => {
  it("maps one exact lock-derived archive directory without registry metadata", () => {
    const input = fixture();
    const archiveDirectory = path.join(input.root, "archives");
    fs.mkdirSync(archiveDirectory);
    const copiedArchive = path.join(archiveDirectory, path.basename(input.archivePath));
    fs.copyFileSync(input.archivePath, copiedArchive);

    expect(
      lockedArchivesFromDirectory(archiveDirectory, input.lockfilePath, REGISTRY_ORIGIN, TARGET),
    ).toEqual(new Map([[PACKAGE_SPEC, copiedArchive]]));
  });

  it("rejects extras and symlinked directories at the archive-directory boundary", () => {
    const input = fixture();
    const archiveDirectory = path.join(input.root, "archives");
    const archiveDirectoryLink = path.join(input.root, "archives-link");
    fs.mkdirSync(archiveDirectory);
    fs.copyFileSync(
      input.archivePath,
      path.join(archiveDirectory, path.basename(input.archivePath)),
    );
    fs.writeFileSync(path.join(archiveDirectory, "unexpected.tgz"), "unexpected");
    fs.symlinkSync(archiveDirectory, archiveDirectoryLink, "dir");

    expect(() =>
      lockedArchivesFromDirectory(archiveDirectory, input.lockfilePath, REGISTRY_ORIGIN, TARGET),
    ).toThrow("archive directory is incomplete or contains extras");
    expect(() =>
      lockedArchivesFromDirectory(
        archiveDirectoryLink,
        input.lockfilePath,
        REGISTRY_ORIGIN,
        TARGET,
      ),
    ).toThrow("archive directory must be a non-symlink directory");
  });

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
    expect(calls[2]?.data.toString()).toContain('"hasShrinkwrap":true');
    expect(calls[2]?.data.toString()).toContain('"bundleDependencies":["bundled-child"]');
  });

  it("combines every locked version into one offline packument", async () => {
    const input = fixture();
    const sharedVersions = ["3.1.2", "5.0.1"] as const;
    const archives = new Map<string, string>();
    const packages: Record<string, unknown> = { "": {} };
    [...sharedVersions.entries()].forEach(([index, version]) => {
      const bytes = Buffer.from(`shared archive ${version}`);
      const archivePath = path.join(input.root, `shared-${version}.tgz`);
      fs.writeFileSync(archivePath, bytes);
      archives.set(`shared@${version}`, archivePath);
      packages[index === 0 ? "node_modules/shared" : "node_modules/parent/node_modules/shared"] = {
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
        resolved: `https://registry.npmjs.org/shared/-/shared-${version}.tgz`,
        version,
      };
    });
    fs.writeFileSync(input.lockfilePath, JSON.stringify({ lockfileVersion: 3, packages }), "utf8");
    const calls: PutCall[] = [];

    await seedReviewedNpmCache(request(input, archives), async (cachePath, key, data, options) => {
      calls.push({ cachePath, data, key, metadata: options?.metadata });
    });

    const packuments = calls.filter(({ key }) => key.endsWith("registry.npmjs.org/shared"));
    expect(packuments).toHaveLength(2);
    expect(packuments.map(({ data }) => JSON.parse(data.toString()).versions)).toEqual([
      expect.objectContaining({ "3.1.2": expect.any(Object), "5.0.1": expect.any(Object) }),
      expect.objectContaining({ "3.1.2": expect.any(Object), "5.0.1": expect.any(Object) }),
    ]);
  });

  it("serves npm view offline from lock-derived packuments", async () => {
    const input = fixture();
    await seedReviewedNpmCache({
      ...request(input, new Map()),
      packumentsOnly: true,
    });

    const integrity = execFileSync(
      "npm",
      [
        "view",
        PACKAGE_SPEC,
        "dist.integrity",
        "--userconfig",
        "/dev/null",
        "--registry",
        REGISTRY_ORIGIN,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NPM_CONFIG_CACHE: input.cacheDirectory,
          NPM_CONFIG_OFFLINE: "true",
        },
      },
    ).trim();

    expect(integrity).toBe(input.integrity);
  });

  it("rejects an unreviewed npm version before loading npm cache internals", async () => {
    const input = fixture();
    const binDirectory = path.join(input.root, "bin");
    const tracePath = path.join(input.root, "npm.trace");
    const npmPath = path.join(binDirectory, "npm");
    fs.mkdirSync(binDirectory);
    fs.writeFileSync(
      npmPath,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "$NPM_TRACE"\nprintf '99.0.0\\n'\n`,
    );
    fs.chmodSync(npmPath, 0o755);
    vi.stubEnv("PATH", `${binDirectory}:${process.env.PATH ?? ""}`);
    vi.stubEnv("NPM_TRACE", tracePath);

    await expect(seedReviewedNpmCache(request(input))).rejects.toThrow(
      "reviewed npm cache seed does not support npm@99.0.0; expected npm@10.9.4, npm@10.9.8, npm@11.17.0, or npm@11.18.0",
    );
    expect(fs.readFileSync(tracePath, "utf8")).toBe("--version\n");
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
      `${PACKAGE_SPEC} archive integrity mismatch`,
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

  it("rejects an archive larger than the configured seed limit", async () => {
    const input = fixture();

    await expect(
      seedReviewedNpmCache(
        { ...request(input), maximumArchiveBytes: input.archive.length - 1 },
        async () => undefined,
      ),
    ).rejects.toThrow("archive must be a bounded regular file");
  });
});
