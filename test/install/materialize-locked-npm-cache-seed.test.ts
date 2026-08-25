// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type LockedArchive,
  materializeLockedNpmCacheSeed,
  verifyAndCopyLockedNpmCacheSeed,
} from "../../scripts/checks/materialize-locked-npm-cache-seed.mts";

const TARGET = { cpu: "x64", libc: "glibc", os: "linux" } as const;

function archive(name: string, source: string): { bytes: Buffer; locked: LockedArchive } {
  const bytes = Buffer.from(source);
  return {
    bytes,
    locked: {
      archive: `${name}-1.0.0.tgz`,
      integrity: `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`,
      resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
    },
  };
}

function writeLock(root: string, archives: readonly LockedArchive[]): string {
  const lockfile = path.join(root, "package-lock.json");
  const packages = archives.map((entry) => ({
    entry,
    name: new URL(entry.resolved).pathname.split("/")[1],
  }));
  writeFileSync(
    lockfile,
    `${JSON.stringify(
      {
        lockfileVersion: 3,
        packages: Object.fromEntries([
          [
            "",
            {
              dependencies: Object.fromEntries(packages.map(({ name }) => [name, "1.0.0"])),
              name: "seed-fixture",
            },
          ],
          ...packages.map(({ entry, name }) => [
            `node_modules/${name}`,
            { integrity: entry.integrity, resolved: entry.resolved },
          ]),
        ]),
      },
      null,
      2,
    )}\n`,
  );
  return lockfile;
}

let testRoot = "";

beforeEach(() => {
  testRoot = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-locked-npm-seed-"));
});

afterEach(() => {
  rmSync(testRoot, { force: true, recursive: true });
});

describe("locked npm cache seed materialization", () => {
  it("materializes and copies every reachable lock-pinned registry archive for the selected npm platform", async () => {
    const alpha = archive("alpha", "alpha archive");
    const beta = archive("beta", "beta archive");
    const sources = new Map([
      [alpha.locked.resolved, alpha.bytes],
      [beta.locked.resolved, beta.bytes],
    ]);
    const lockfile = writeLock(testRoot, [beta.locked, alpha.locked]);
    const seed = path.join(testRoot, "seed");
    const copied = path.join(testRoot, "copied");

    const manifest = await materializeLockedNpmCacheSeed({
      downloadArchive: async (entry) => {
        const bytes = sources.get(entry.resolved);
        expect(bytes).toBeDefined();
        return bytes!;
      },
      lockfile,
      output: seed,
      target: TARGET,
    });
    const verified = await verifyAndCopyLockedNpmCacheSeed({
      lockfile,
      output: copied,
      seed,
      target: TARGET,
    });

    expect(manifest).toEqual(verified);
    expect(manifest.archiveCount).toBe(2);
    expect(readdirSync(seed).sort()).toEqual([
      "alpha-1.0.0.tgz",
      "beta-1.0.0.tgz",
      "manifest.json",
    ]);
    expect(readdirSync(copied).sort()).toEqual(["alpha-1.0.0.tgz", "beta-1.0.0.tgz"]);
    expect(readFileSync(path.join(copied, alpha.locked.archive))).toEqual(alpha.bytes);
    expect(readFileSync(path.join(copied, beta.locked.archive))).toEqual(beta.bytes);
  });

  it("materializes only the reachable archives for the selected npm platform", async () => {
    const alpha = archive("alpha", "alpha archive");
    const beta = archive("beta", "beta archive");
    const gamma = archive("gamma", "gamma archive");
    const delta = archive("delta", "delta archive");
    const lockfile = writeLock(testRoot, [alpha.locked, beta.locked, gamma.locked, delta.locked]);
    const lock = JSON.parse(readFileSync(lockfile, "utf8")) as {
      packages: Record<string, Record<string, unknown>>;
    };
    lock.packages[""].dependencies = { alpha: "1.0.0" };
    lock.packages["node_modules/alpha"].optionalDependencies = {
      beta: "1.0.0",
      gamma: "1.0.0",
    };
    lock.packages["node_modules/beta"].cpu = ["x64"];
    lock.packages["node_modules/beta"].libc = ["glibc"];
    lock.packages["node_modules/beta"].os = ["linux"];
    lock.packages["node_modules/gamma"].cpu = ["x64"];
    lock.packages["node_modules/gamma"].os = ["win32"];
    writeFileSync(lockfile, `${JSON.stringify(lock, null, 2)}\n`);
    const sources = new Map([
      [alpha.locked.resolved, alpha.bytes],
      [beta.locked.resolved, beta.bytes],
    ]);
    const downloadArchive = vi.fn(async (entry: LockedArchive) => sources.get(entry.resolved)!);
    const seed = path.join(testRoot, "seed");

    const manifest = await materializeLockedNpmCacheSeed({
      downloadArchive,
      lockfile,
      output: seed,
      target: TARGET,
    });

    expect(manifest.archiveCount).toBe(2);
    expect(downloadArchive).toHaveBeenCalledTimes(2);
    expect(readdirSync(seed).sort()).toEqual([
      "alpha-1.0.0.tgz",
      "beta-1.0.0.tgz",
      "manifest.json",
    ]);
  });

  it("does not invent an archive for a peer omitted by a legacy-peer lock", async () => {
    const alpha = archive("alpha", "alpha archive");
    const lockfile = writeLock(testRoot, [alpha.locked]);
    const lock = JSON.parse(readFileSync(lockfile, "utf8")) as {
      packages: Record<string, Record<string, unknown>>;
    };
    lock.packages["node_modules/alpha"].peerDependencies = { host: ">=1" };
    writeFileSync(lockfile, `${JSON.stringify(lock, null, 2)}\n`);
    const seed = path.join(testRoot, "seed");

    const manifest = await materializeLockedNpmCacheSeed({
      downloadArchive: async () => alpha.bytes,
      lockfile,
      output: seed,
      target: TARGET,
    });

    expect(manifest.archiveCount).toBe(1);
    expect(readdirSync(seed).sort()).toEqual(["alpha-1.0.0.tgz", "manifest.json"]);
  });

  it("rejects a lock archive outside the exact npm registry origin", async () => {
    const alpha = archive("alpha", "alpha archive");
    const lockfile = writeLock(testRoot, [
      { ...alpha.locked, resolved: "https://packages.example.test/alpha-1.0.0.tgz" },
    ]);
    const downloadArchive = vi.fn(async () => alpha.bytes);
    const seed = path.join(testRoot, "seed");

    await expect(
      materializeLockedNpmCacheSeed({
        downloadArchive,
        lockfile,
        output: seed,
        target: TARGET,
      }),
    ).rejects.toThrow("package-lock archive must use https://registry.npmjs.org");
    expect(downloadArchive).not.toHaveBeenCalled();
    expect(existsSync(seed)).toBe(false);
  });

  it("removes partial output when a downloaded archive fails lock integrity", async () => {
    const alpha = archive("alpha", "alpha archive");
    const lockfile = writeLock(testRoot, [alpha.locked]);
    const seed = path.join(testRoot, "seed");

    await expect(
      materializeLockedNpmCacheSeed({
        downloadArchive: async () => Buffer.from("substituted archive"),
        lockfile,
        output: seed,
        target: TARGET,
      }),
    ).rejects.toThrow("downloaded archive does not match package-lock integrity");
    expect(existsSync(seed)).toBe(false);
  });

  it("rejects a materialized archive changed after the hosted handoff", async () => {
    const alpha = archive("alpha", "alpha archive");
    const lockfile = writeLock(testRoot, [alpha.locked]);
    const seed = path.join(testRoot, "seed");
    await materializeLockedNpmCacheSeed({
      downloadArchive: async () => alpha.bytes,
      lockfile,
      output: seed,
      target: TARGET,
    });
    chmodSync(path.join(seed, alpha.locked.archive), 0o644);
    appendFileSync(path.join(seed, alpha.locked.archive), "tampered");

    await expect(
      verifyAndCopyLockedNpmCacheSeed({ lockfile, seed, target: TARGET }),
    ).rejects.toThrow("npm cache seed archive failed integrity validation");
  });

  it("rejects a handoff that omits one lock-pinned archive", async () => {
    const alpha = archive("alpha", "alpha archive");
    const beta = archive("beta", "beta archive");
    const sources = new Map([
      [alpha.locked.resolved, alpha.bytes],
      [beta.locked.resolved, beta.bytes],
    ]);
    const lockfile = writeLock(testRoot, [alpha.locked, beta.locked]);
    const seed = path.join(testRoot, "seed");
    await materializeLockedNpmCacheSeed({
      downloadArchive: async (entry) => sources.get(entry.resolved)!,
      lockfile,
      output: seed,
      target: TARGET,
    });
    unlinkSync(path.join(seed, beta.locked.archive));

    await expect(
      verifyAndCopyLockedNpmCacheSeed({ lockfile, seed, target: TARGET }),
    ).rejects.toThrow("npm cache seed directory contains missing or unexpected files");
  });

  it.skipIf(process.platform === "win32")(
    "rejects a lock-pinned archive replaced with a symlink",
    async () => {
      const alpha = archive("alpha", "alpha archive");
      const lockfile = writeLock(testRoot, [alpha.locked]);
      const seed = path.join(testRoot, "seed");
      await materializeLockedNpmCacheSeed({
        downloadArchive: async () => alpha.bytes,
        lockfile,
        output: seed,
        target: TARGET,
      });
      unlinkSync(path.join(seed, alpha.locked.archive));
      symlinkSync(path.join(seed, "manifest.json"), path.join(seed, alpha.locked.archive));

      await expect(
        verifyAndCopyLockedNpmCacheSeed({ lockfile, seed, target: TARGET }),
      ).rejects.toThrow("seed archive alpha-1.0.0.tgz must be one regular non-symlink file");
    },
  );
});
