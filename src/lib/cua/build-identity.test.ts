// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCuaBuildIdentityStamp, resolveCurrentCuaBuildIdentity } from "./build-identity";

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  while (directories.length > 0) {
    fs.rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

function trustedGit(root: string, args: string[]): string {
  return execFileSync(
    "/usr/bin/git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        HOME: root,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "CUA Build Identity Test",
        GIT_AUTHOR_EMAIL: "cua-build-identity@example.invalid",
        GIT_COMMITTER_NAME: "CUA Build Identity Test",
        GIT_COMMITTER_EMAIL: "cua-build-identity@example.invalid",
      },
      stdio: ["ignore", "pipe", "ignore"],
    },
  ).trim();
}

function cleanCheckout(): { root: string; sourceRevision: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-clean-git-"));
  directories.push(root);
  trustedGit(root, ["init", "--quiet"]);
  fs.writeFileSync(path.join(root, "README.md"), "clean CUA checkout\n");
  trustedGit(root, ["add", "--", "README.md"]);
  trustedGit(root, ["commit", "--quiet", "-m", "test: clean checkout"]);
  return { root, sourceRevision: trustedGit(root, ["rev-parse", "--verify", "HEAD"]) };
}

function checkoutWithGitlink(): {
  root: string;
  nested: string;
  sourceRevision: string;
  nestedRevision: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-gitlink-"));
  directories.push(root);
  trustedGit(root, ["init", "--quiet"]);
  const nested = path.join(root, "nested");
  fs.mkdirSync(nested);
  trustedGit(nested, ["init", "--quiet"]);
  fs.writeFileSync(path.join(nested, "tracked.txt"), "exact nested source\n");
  trustedGit(nested, ["add", "--", "tracked.txt"]);
  trustedGit(nested, ["commit", "--quiet", "-m", "test: nested checkout"]);
  const nestedRevision = trustedGit(nested, ["rev-parse", "--verify", "HEAD"]);
  fs.writeFileSync(path.join(root, "README.md"), "checkout with gitlink\n");
  trustedGit(root, ["add", "--", "README.md"]);
  trustedGit(root, ["update-index", "--add", "--cacheinfo", `160000,${nestedRevision},nested`]);
  trustedGit(root, ["commit", "--quiet", "-m", "test: checkout with gitlink"]);
  return {
    root,
    nested,
    nestedRevision,
    sourceRevision: trustedGit(root, ["rev-parse", "--verify", "HEAD"]),
  };
}

function packagedBuild(sourceRevision = "c".repeat(40)): {
  root: string;
  stampPath: string;
  sourceRevision: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-packaged-build-"));
  directories.push(root);
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist, { mode: 0o755 });
  fs.writeFileSync(
    path.join(dist, "build-identity.json"),
    JSON.stringify({ nemoclawVersion: "0.1.0", sourceRevision }),
    { mode: 0o644 },
  );
  const stampPath = path.join(dist, "cua-build-identity.json");
  fs.writeFileSync(
    stampPath,
    JSON.stringify({ schemaVersion: 1, sourceRevision, sourceClean: true }),
    { mode: 0o644 },
  );
  return { root, stampPath, sourceRevision };
}

describe("CUA build identity", () => {
  it("treats Git inspection failure as unproven rather than clean (#7755)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-no-git-"));
    directories.push(root);

    expect(createCuaBuildIdentityStamp(root, "a".repeat(40))).toEqual({
      schemaVersion: 1,
      sourceRevision: "a".repeat(40),
      sourceClean: false,
    });
  });

  it("does not let an ambient PATH Git substitute claim a clean build (#7755)", () => {
    const checkout = cleanCheckout();
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-fake-git-"));
    directories.push(fakeBin);
    const fakeGit = path.join(fakeBin, "git");
    fs.writeFileSync(fakeGit, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    vi.stubEnv("PATH", `${fakeBin}:/usr/bin:/bin`);

    expect(createCuaBuildIdentityStamp(checkout.root, checkout.sourceRevision)).toEqual({
      schemaVersion: 1,
      sourceRevision: checkout.sourceRevision,
      sourceClean: true,
    });
  });

  it.each([
    "--assume-unchanged",
    "--skip-worktree",
  ])("rejects the real Git %s concealment flag before and after a tracked-byte change (#7755)", (flag) => {
    const checkout = cleanCheckout();
    trustedGit(checkout.root, ["update-index", flag, "--", "README.md"]);

    expect(createCuaBuildIdentityStamp(checkout.root, checkout.sourceRevision).sourceClean).toBe(
      false,
    );

    fs.writeFileSync(path.join(checkout.root, "README.md"), "concealed CUA source\n");
    expect(createCuaBuildIdentityStamp(checkout.root, checkout.sourceRevision).sourceClean).toBe(
      false,
    );
  });

  it("rejects staged index bytes that do not match the exact source revision (#7755)", () => {
    const checkout = cleanCheckout();
    fs.writeFileSync(path.join(checkout.root, "README.md"), "staged CUA source\n");
    trustedGit(checkout.root, ["add", "--", "README.md"]);

    expect(createCuaBuildIdentityStamp(checkout.root, checkout.sourceRevision).sourceClean).toBe(
      false,
    );
  });

  it("rejects a real Git replacement that makes evil index and worktree bytes appear clean (#7755)", () => {
    const checkout = cleanCheckout();
    fs.writeFileSync(path.join(checkout.root, "README.md"), "replacement-controlled source\n");
    trustedGit(checkout.root, ["add", "--", "README.md"]);
    trustedGit(checkout.root, ["commit", "--quiet", "-m", "test: replacement source"]);
    const replacementRevision = trustedGit(checkout.root, ["rev-parse", "--verify", "HEAD"]);
    trustedGit(checkout.root, ["replace", checkout.sourceRevision, replacementRevision]);
    trustedGit(checkout.root, ["update-ref", "HEAD", checkout.sourceRevision]);

    expect(trustedGit(checkout.root, ["status", "--porcelain=v1"])).toBe("");
    expect(createCuaBuildIdentityStamp(checkout.root, checkout.sourceRevision).sourceClean).toBe(
      false,
    );
  });

  it.each([
    ["0664", 0o664],
    ["0646", 0o646],
  ])("rejects unsafe tracked regular-file mode %s even when Git ignores it (#7755)", (_label, mode) => {
    const checkout = cleanCheckout();
    fs.chmodSync(path.join(checkout.root, "README.md"), mode);

    expect(createCuaBuildIdentityStamp(checkout.root, checkout.sourceRevision).sourceClean).toBe(
      false,
    );
  });

  it.each([
    ["set-user-ID", 0o4000n],
    ["set-group-ID", 0o2000n],
    ["sticky", 0o1000n],
  ])("rejects a tracked regular file with the %s authority bit (#7755)", (_label, bit) => {
    const checkout = cleanCheckout();
    const originalFstat = fs.fstatSync;
    vi.spyOn(fs, "fstatSync").mockImplementation(((handle: number, ...args: unknown[]) => {
      const stat = Reflect.apply(originalFstat, fs, [handle, ...args]) as fs.BigIntStats;
      return new Proxy(stat, {
        get(target, property) {
          const value =
            property === "mode"
              ? target.mode | bit
              : (Reflect.get(target, property, target) as unknown);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof fs.fstatSync);

    expect(createCuaBuildIdentityStamp(checkout.root, checkout.sourceRevision).sourceClean).toBe(
      false,
    );
  });

  it("accepts a read-only tracked file with the exact non-executable HEAD mode (#7755)", () => {
    const checkout = cleanCheckout();
    fs.chmodSync(path.join(checkout.root, "README.md"), 0o444);

    expect(createCuaBuildIdentityStamp(checkout.root, checkout.sourceRevision).sourceClean).toBe(
      true,
    );
  });

  it("verifies a materialized Git LFS file against the exact committed pointer (#7755)", () => {
    const checkout = cleanCheckout();
    const payload = Buffer.from("exact digest-bound LFS payload\n");
    const pointer = [
      "version https://git-lfs.github.com/spec/v1",
      `oid sha256:${createHash("sha256").update(payload).digest("hex")}`,
      `size ${payload.byteLength}`,
      "",
    ].join("\n");
    const artifact = path.join(checkout.root, "artifact.pt");
    fs.writeFileSync(artifact, pointer);
    trustedGit(checkout.root, ["add", "--", "artifact.pt"]);
    trustedGit(checkout.root, ["commit", "--quiet", "-m", "test: add LFS pointer"]);
    checkout.sourceRevision = trustedGit(checkout.root, ["rev-parse", "--verify", "HEAD"]);
    fs.writeFileSync(artifact, payload);

    expect(createCuaBuildIdentityStamp(checkout.root, checkout.sourceRevision).sourceClean).toBe(
      true,
    );

    const alteredPayload = Buffer.from(payload);
    alteredPayload[0] = alteredPayload[0] === 0x65 ? 0x45 : 0x65;
    fs.writeFileSync(artifact, alteredPayload);
    expect(createCuaBuildIdentityStamp(checkout.root, checkout.sourceRevision).sourceClean).toBe(
      false,
    );
  });

  it("rejects an uninitialized Git link even when its directory is exactly empty (#7755)", () => {
    const checkout = checkoutWithGitlink();
    fs.rmSync(checkout.nested, { recursive: true, force: true });
    fs.mkdirSync(checkout.nested);

    expect(createCuaBuildIdentityStamp(checkout.root, checkout.sourceRevision).sourceClean).toBe(
      false,
    );

    fs.writeFileSync(path.join(checkout.nested, "untracked.txt"), "hidden source\n");
    expect(createCuaBuildIdentityStamp(checkout.root, checkout.sourceRevision).sourceClean).toBe(
      false,
    );
  });

  it("recursively rejects dirty or wrong-revision initialized Git links (#7755)", () => {
    const checkout = checkoutWithGitlink();
    expect(createCuaBuildIdentityStamp(checkout.root, checkout.sourceRevision).sourceClean).toBe(
      true,
    );

    fs.writeFileSync(path.join(checkout.nested, "tracked.txt"), "dirty nested source\n");
    expect(createCuaBuildIdentityStamp(checkout.root, checkout.sourceRevision).sourceClean).toBe(
      false,
    );

    fs.writeFileSync(path.join(checkout.nested, "tracked.txt"), "later nested source\n");
    trustedGit(checkout.nested, ["add", "--", "tracked.txt"]);
    trustedGit(checkout.nested, ["commit", "--quiet", "-m", "test: wrong nested revision"]);
    expect(createCuaBuildIdentityStamp(checkout.root, checkout.sourceRevision).sourceClean).toBe(
      false,
    );
  });

  it("accepts only a closed injectable exact-build identity in unit tests (#7755)", () => {
    expect(
      resolveCurrentCuaBuildIdentity({
        buildIdentity: {
          schemaVersion: 1,
          sourceRevision: "b".repeat(40),
          sourceClean: true,
        },
      }),
    ).toEqual({
      schemaVersion: 1,
      sourceRevision: "b".repeat(40),
      sourceClean: true,
    });
    expect(() =>
      resolveCurrentCuaBuildIdentity({
        buildIdentity: {
          schemaVersion: 1,
          sourceRevision: "main",
          sourceClean: true,
        },
      }),
    ).toThrow(/invalid/);
  });

  it("rejects a writable packaged cleanliness stamp (#7755)", () => {
    const packaged = packagedBuild();
    fs.chmodSync(packaged.stampPath, 0o666);

    expect(() => resolveCurrentCuaBuildIdentity({ rootDir: packaged.root })).toThrow(
      "CUA build cleanliness could not be proven",
    );
  });

  it("rejects a symbolic-link packaged cleanliness stamp before reading it (#7755)", () => {
    const packaged = packagedBuild();
    const target = path.join(packaged.root, "forged-stamp.json");
    fs.writeFileSync(
      target,
      JSON.stringify({
        schemaVersion: 1,
        sourceRevision: packaged.sourceRevision,
        sourceClean: true,
      }),
      { mode: 0o644 },
    );
    fs.rmSync(packaged.stampPath);
    fs.symlinkSync(target, packaged.stampPath);

    expect(() => resolveCurrentCuaBuildIdentity({ rootDir: packaged.root })).toThrow(
      "CUA build cleanliness could not be proven",
    );
  });

  it("rejects an oversized packaged cleanliness stamp before allocation (#7755)", () => {
    const packaged = packagedBuild();
    fs.truncateSync(packaged.stampPath, 1025);

    expect(() =>
      resolveCurrentCuaBuildIdentity({
        rootDir: packaged.root,
        assertPackagedStampAuthority: () => undefined,
      }),
    ).toThrow("CUA build cleanliness could not be proven");
  });

  it("does not fall back to a clean packaged stamp when live Git inspection fails (#7755)", () => {
    const packaged = packagedBuild();
    fs.mkdirSync(path.join(packaged.root, ".git"));

    expect(
      resolveCurrentCuaBuildIdentity({
        rootDir: packaged.root,
        assertPackagedStampAuthority: () => undefined,
      }),
    ).toEqual({
      schemaVersion: 1,
      sourceRevision: packaged.sourceRevision,
      sourceClean: false,
    });
  });

  it("rejects a user-owned grandparent in the Linux packaged authority path (#7755)", () => {
    const packaged = packagedBuild();
    const originalLstat = fs.lstatSync;
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike, ...args: unknown[]) => {
      const stat = Reflect.apply(originalLstat, fs, [target, ...args]) as fs.Stats;
      const resolved = path.resolve(String(target));
      const uid = resolved === packaged.root ? 501 : 0;
      return new Proxy(stat, {
        get(value, property, receiver) {
          return property === "uid" ? uid : Reflect.get(value, property, receiver);
        },
      });
    }) as typeof fs.lstatSync);

    expect(() => resolveCurrentCuaBuildIdentity({ rootDir: packaged.root })).toThrow(
      "CUA build cleanliness could not be proven",
    );
  });
});
