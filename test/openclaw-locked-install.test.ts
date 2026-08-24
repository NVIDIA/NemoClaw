// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ReviewedNpmArchiveRequest,
  verifyInstalledNpmLock,
  verifyReviewedNpmLock,
} from "../scripts/lib/reviewed-npm-archive.mts";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const RUNTIME_DIRECTORY = path.join(REPO_ROOT, "agents", "openclaw", "openclaw-runtime");
const LOCKFILE = path.join(RUNTIME_DIRECTORY, "package-lock.json");
const PACKAGE_SPEC = "openclaw@2026.7.1";
const INTEGRITY =
  "sha512-ge/Xss99CHAjPL/ikmH/UFoiOrjcxDB4sW3y9mhyCD+dYW3wzV7TKbAVdkrXFgAG2d2BjpJofP97zUZ+umxo8g==";
const TARBALL = "https://registry.npmjs.org/openclaw/-/openclaw-2026.7.1.tgz";
const LOCK_SHA256 = "60f816dcff6f35179b1c48b4c06db9473497760d45ca1831252c27e8b1d2d665";
const MCPORTER_PACKAGE_SPEC = "mcporter@0.7.3";
const MCP_TOOL_DISCOVERY_PACKAGE_SPEC = "@modelcontextprotocol/sdk@1.30.0";
const MCP_TOOL_DISCOVERY_LOCK_SHA256 =
  "bc7e34d9eb1f72cf3016c8b88c72d3b7682a4f234903cb93b9476b10d7e954eb";
const roots: string[] = [];

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function lockRequest(lockfilePath = LOCKFILE, expectedLockSha256 = LOCK_SHA256) {
  return {
    expectedIntegrity: INTEGRITY,
    expectedLockSha256,
    label: "OpenClaw 2026.7.1 locked runtime graph",
    lockfilePath,
    packageSpec: PACKAGE_SPEC,
    registryOrigin: "https://registry.npmjs.org/",
    tarballUrl: TARBALL,
  };
}

function reviewedMetadata(args: readonly string[], request: ReviewedNpmArchiveRequest): string {
  return args[2] === "dist.integrity" ? request.expectedIntegrity : request.tarballUrl;
}

function mutatedLock(mutate: (lock: any) => void): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-lock-test-"));
  roots.push(root);
  const target = path.join(root, "package-lock.json");
  const lock = JSON.parse(fs.readFileSync(LOCKFILE, "utf-8"));
  mutate(lock);
  fs.writeFileSync(target, `${JSON.stringify(lock, null, 2)}\n`);
  return target;
}

type InstalledFixtureLayout =
  | "dangling-package-symlink"
  | "manifest-symlink"
  | "omitted"
  | "package-symlink"
  | "regular";

type InstalledFixtureWriter = (args: {
  readonly actualName: string;
  readonly actualVersion: string;
  readonly packageDirectory: string;
  readonly root: string;
}) => void;

function writePackageManifest(
  packageDirectory: string,
  actualName: string,
  actualVersion: string,
): void {
  fs.mkdirSync(packageDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(packageDirectory, "package.json"),
    JSON.stringify({ name: actualName, version: actualVersion }),
  );
}

const INSTALLED_FIXTURE_WRITERS: Readonly<Record<InstalledFixtureLayout, InstalledFixtureWriter>> =
  {
    "dangling-package-symlink": ({ packageDirectory, root }) => {
      fs.mkdirSync(path.dirname(packageDirectory), { recursive: true });
      fs.symlinkSync(path.join(root, "substituted-package"), packageDirectory);
    },
    "manifest-symlink": ({ actualName, actualVersion, packageDirectory, root }) => {
      fs.mkdirSync(packageDirectory, { recursive: true });
      const target = path.join(root, "substituted-package.json");
      fs.writeFileSync(target, JSON.stringify({ name: actualName, version: actualVersion }));
      fs.symlinkSync(target, path.join(packageDirectory, "package.json"));
    },
    omitted: () => undefined,
    "package-symlink": ({ actualName, actualVersion, packageDirectory, root }) => {
      const target = path.join(root, "substituted-package");
      writePackageManifest(target, actualName, actualVersion);
      fs.mkdirSync(path.dirname(packageDirectory), { recursive: true });
      fs.symlinkSync(target, packageDirectory);
    },
    regular: ({ actualName, actualVersion, packageDirectory }) => {
      writePackageManifest(packageDirectory, actualName, actualVersion);
    },
  };

function installedFixture({
  actualName = "chalk",
  actualVersion = "5.6.2",
  lockedName,
  danglingSymlink = false,
  manifestSymlink = false,
  omit = false,
  optional = false,
  symlink = false,
}: {
  actualName?: string;
  actualVersion?: string;
  lockedName?: string;
  danglingSymlink?: boolean;
  manifestSymlink?: boolean;
  omit?: boolean;
  optional?: boolean;
  symlink?: boolean;
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-installed-lock-test-"));
  roots.push(root);
  const installRoot = path.join(root, "runtime");
  const lockfilePath = path.join(root, "package-lock.json");
  const packageDirectory = path.join(installRoot, "node_modules", "chalk");
  const lock = {
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { chalk: "5.6.2" } },
      "node_modules/chalk": {
        integrity: `sha512-${"D".repeat(88)}`,
        ...(lockedName ? { name: lockedName } : {}),
        optional,
        resolved: "https://registry.npmjs.org/chalk/-/chalk-5.6.2.tgz",
        version: "5.6.2",
      },
    },
  };
  fs.writeFileSync(lockfilePath, `${JSON.stringify(lock, null, 2)}\n`);
  const layout: InstalledFixtureLayout = omit
    ? "omitted"
    : symlink
      ? danglingSymlink
        ? "dangling-package-symlink"
        : "package-symlink"
      : manifestSymlink
        ? "manifest-symlink"
        : "regular";
  INSTALLED_FIXTURE_WRITERS[layout]({
    actualName,
    actualVersion,
    packageDirectory,
    root,
  });
  return {
    expectedLockSha256: sha256(lockfilePath),
    installRoot,
    label: "test locked graph",
    lockfilePath,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("locked OpenClaw production installation (#5896)", () => {
  it("binds the reviewed root artifact to the complete committed closure", () => {
    const verified = verifyReviewedNpmLock(lockRequest(), reviewedMetadata);
    expect(verified).toHaveLength(307);
    expect(verified).toContain(PACKAGE_SPEC);
    expect(verified).toContain("brace-expansion@5.0.9");
    expect(verified).toContain("fast-uri@3.1.5");
    expect(verified).toContain("hono@4.12.34");
    expect(verified).toContain("ip-address@10.3.1");
    expect(verified).toContain("tar@7.5.21");
    expect(verified).not.toContain("tar@7.5.19");
    expect(verified).toContain("undici@8.10.0");
    expect(sha256(LOCKFILE)).toBe(LOCK_SHA256);
  });

  // source-shape-contract: security -- The committed production lock digest must fail before any registry-controlled metadata is consulted
  it("rejects any lock byte tamper before registry metadata is consulted", () => {
    const lockfilePath = mutatedLock((lock) => {
      lock.packages["node_modules/openclaw/node_modules/chalk"].integrity =
        `sha512-${"A".repeat(88)}`;
    });
    let npmCalled = false;
    expect(() =>
      verifyReviewedNpmLock(lockRequest(lockfilePath), () => {
        npmCalled = true;
        return "";
      }),
    ).toThrow("lock SHA-256 mismatch");
    expect(npmCalled).toBe(false);
  });

  // source-shape-contract: security -- Mutating the shipped lock proves every reviewed transitive identity remains bound to committed production bytes
  it.each([
    {
      expected: "root must depend only on openclaw@2026.7.1",
      mutate: (lock: any) => {
        lock.packages[""].dependencies.openclaw = "2026.7.2";
      },
      name: "root version drift",
    },
    {
      expected: "root must depend only on openclaw@2026.7.1",
      mutate: (lock: any) => {
        lock.packages[""].optionalDependencies = { "left-pad": "1.3.0" };
      },
      name: "root optional dependency injection",
    },
    {
      expected: "lock integrity mismatch for openclaw@2026.7.1",
      mutate: (lock: any) => {
        lock.packages["node_modules/openclaw"].integrity = `sha512-${"B".repeat(88)}`;
      },
      name: "top-level integrity drift",
    },
    {
      expected: "nested shrinkwrap delegation is not allowed",
      mutate: (lock: any) => {
        lock.packages["node_modules/openclaw"].hasShrinkwrap = true;
      },
      name: "nested shrinkwrap delegation",
    },
    {
      expected: "must use a committed sha512 npm integrity value",
      mutate: (lock: any) => {
        delete lock.packages["node_modules/openclaw/node_modules/chalk"].integrity;
      },
      name: "missing transitive integrity",
    },
    {
      expected: "must use the reviewed registry",
      mutate: (lock: any) => {
        lock.packages["node_modules/openclaw/node_modules/chalk"].resolved =
          "https://packages.invalid/chalk-5.6.2.tgz";
      },
      name: "malicious transitive registry substitution",
    },
    {
      expected: "conflicting package identity: safe-buffer@5.1.2",
      mutate: (lock: any) => {
        lock.packages[
          "node_modules/openclaw/node_modules/string_decoder/node_modules/safe-buffer"
        ].integrity = `sha512-${"C".repeat(88)}`;
      },
      name: "conflicting duplicate package identity",
    },
  ])("rejects $name even with a test-only matching lock digest", ({ expected, mutate }) => {
    const lockfilePath = mutatedLock(mutate);
    expect(() =>
      verifyReviewedNpmLock(lockRequest(lockfilePath, sha256(lockfilePath)), reviewedMetadata),
    ).toThrow(expected);
  });

  it("binds installed package manifests to lock locations and versions", () => {
    expect(verifyInstalledNpmLock(installedFixture())).toEqual(["chalk@5.6.2"]);
  });

  it("binds npm aliases to the canonical package name recorded in the lock", () => {
    expect(
      verifyInstalledNpmLock(
        installedFixture({
          actualName: "@scope/canonical",
          lockedName: "@scope/canonical",
        }),
      ),
    ).toEqual(["@scope/canonical@5.6.2"]);
  });

  // source-shape-contract: security -- Production lock verification must fail closed when required package locations are absent or redirected through symlinks
  it("fails closed on missing required packages and symlinked package roots", () => {
    expect(() => verifyInstalledNpmLock(installedFixture({ omit: true }))).toThrow(
      "missing installed package: chalk@5.6.2",
    );
    expect(() => verifyInstalledNpmLock(installedFixture({ symlink: true }))).toThrow(
      "installed package must be a non-symlink directory",
    );
    expect(() =>
      verifyInstalledNpmLock(
        installedFixture({
          danglingSymlink: true,
          optional: true,
          symlink: true,
        }),
      ),
    ).toThrow("installed package must be a non-symlink directory");
  });

  // source-shape-contract: security -- Installed production manifests must remain regular files beneath their reviewed package locations
  it("rejects symlinked package manifests", () => {
    expect(() => verifyInstalledNpmLock(installedFixture({ manifestSymlink: true }))).toThrow(
      "manifest must be a non-symlink regular file",
    );
  });

  it("allows npm to omit an incompatible optional package", () => {
    expect(verifyInstalledNpmLock(installedFixture({ omit: true, optional: true }))).toEqual([]);
  });

});
