// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs, { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hashPackageTree,
  OPENCLAW_UNDICI_PATCHES,
  patchInstalledOpenClawUndici,
} from "../../../scripts/lib/openclaw-npm-remediation.mts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});
vi.mock("../../../scripts/lib/reviewed-npm-archive.mts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../scripts/lib/reviewed-npm-archive.mts")>();
  return { ...actual, packReviewedNpmArchive: vi.fn(actual.packReviewedNpmArchive) };
});
import { packReviewedNpmArchive } from "../../../scripts/lib/reviewed-npm-archive.mts";

const packageName = "@openclaw/slack";
const patch = OPENCLAW_UNDICI_PATCHES[packageName];
const originalPins = { ...patch };
const roots: string[] = [];

function readJson(filename: string): unknown {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

function metadataParseable(npmRoot: string): boolean {
  try {
    readJson(path.join(npmRoot, "package.json"));
    readJson(path.join(npmRoot, "package-lock.json"));
    return true;
  } catch {
    return false;
  }
}

function fixture() {
  const root = fs.mkdtempSync(path.join(tmpdir(), "nemoclaw-undici-metadata-"));
  roots.push(root);
  const npmRoot = path.join(root, "npm");
  const undici = path.join(npmRoot, "node_modules", packageName, "node_modules", "undici");
  fs.mkdirSync(undici, { recursive: true });
  fs.writeFileSync(
    path.join(npmRoot, "node_modules", packageName, "package.json"),
    JSON.stringify({ name: packageName, version: "2026.9.1" }),
  );
  fs.writeFileSync(
    path.join(undici, "package.json"),
    JSON.stringify({ name: "undici", version: patch.affected }),
  );
  const project = { name: "fixture", private: true };
  const location = `node_modules/${packageName}/node_modules/undici`;
  const lock = { lockfileVersion: 3, packages: { [location]: { version: patch.affected } } };
  fs.writeFileSync(path.join(npmRoot, "package.json"), JSON.stringify(project));
  fs.writeFileSync(path.join(npmRoot, "package-lock.json"), JSON.stringify(lock));
  const replacement = path.join(root, "replacement", "package");
  fs.mkdirSync(replacement, { recursive: true });
  fs.writeFileSync(
    path.join(replacement, "package.json"),
    JSON.stringify({ name: "undici", version: patch.version }),
  );
  const archivePath = path.join(root, "replacement.tgz");
  execFileSync("tar", ["-czf", archivePath, "-C", path.dirname(replacement), "package"]);
  patch.affectedTree = hashPackageTree(undici);
  patch.fixedTree = hashPackageTree(replacement);
  vi.mocked(packReviewedNpmArchive).mockReturnValue({ archivePath, rootDirectory: root });
  return { npmRoot, undici, project, lock };
}

beforeEach(() => {
  vi.mocked(writeFileSync).mockReset().mockImplementation(fs.writeFileSync);
  vi.mocked(packReviewedNpmArchive).mockReset();
});

afterEach(() => {
  Object.assign(patch, originalPins);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("OpenClaw Undici metadata recovery", () => {
  it("records the writer before downloading and cleans up a failed download", () => {
    const f = fixture();
    let owner: unknown;
    vi.mocked(packReviewedNpmArchive).mockImplementation(({ tempDirectory }) => {
      owner = readJson(path.join(tempDirectory!, "recovery.json"));
      throw new Error("download failed");
    });
    expect(() => patchInstalledOpenClawUndici({ npmRoot: f.npmRoot, packageName })).toThrow(
      "download failed",
    );
    expect(owner).toMatchObject({ packageName, pid: process.pid });
    expect(hashPackageTree(f.undici)).toBe(patch.affectedTree);
    expect(readJson(path.join(f.npmRoot, "package.json"))).toEqual(f.project);
    expect(readJson(path.join(f.npmRoot, "package-lock.json"))).toEqual(f.lock);
    expect(
      fs.readdirSync(f.npmRoot).filter((name) => name.startsWith(".nemoclaw-undici-")),
    ).toEqual([]);
  });
  it.each(["project.next", "lock.next"] as const)(
    "keeps both project files parseable when the %s write stops midway",
    (stagedName) => {
      const f = fixture();
      let interrupted = false;
      let parseableAtInterruption = false;
      const interrupt = (filename: fs.PathOrFileDescriptor): never => {
        interrupted = true;
        fs.writeFileSync(filename, "{");
        parseableAtInterruption = metadataParseable(f.npmRoot);
        throw new Error("interrupted metadata write");
      };
      vi.mocked(writeFileSync).mockImplementation((filename, data, options) =>
        !interrupted && String(filename).endsWith(`/${stagedName}`)
          ? interrupt(filename)
          : fs.writeFileSync(filename, data, options),
      );
      expect(() => patchInstalledOpenClawUndici({ npmRoot: f.npmRoot, packageName })).toThrow(
        "interrupted metadata write",
      );
      expect(interrupted).toBe(true);
      expect(parseableAtInterruption).toBe(true);
      expect(readJson(path.join(f.npmRoot, "package.json"))).toEqual(f.project);
      expect(readJson(path.join(f.npmRoot, "package-lock.json"))).toEqual(f.lock);
      patchInstalledOpenClawUndici({ npmRoot: f.npmRoot, packageName });
      expect(hashPackageTree(f.undici)).toBe(patch.fixedTree);
    },
  );

  it("keeps the last complete metadata when rollback stops midway", () => {
    const f = fixture();
    let rollbackInterrupted = false;
    let parseableAtInterruption = false;
    vi.mocked(writeFileSync).mockImplementation((filename, data, options) => {
      switch (path.basename(String(filename))) {
        case "lock.next":
          throw new Error("metadata write failed");
        case "project.original":
          rollbackInterrupted = true;
          fs.writeFileSync(filename, "{");
          parseableAtInterruption = metadataParseable(f.npmRoot);
          throw new Error("interrupted rollback");
        default:
          return fs.writeFileSync(filename, data, options);
      }
    });
    expect(() => patchInstalledOpenClawUndici({ npmRoot: f.npmRoot, packageName })).toThrow(
      "rollback failed",
    );
    expect(rollbackInterrupted).toBe(true);
    expect(parseableAtInterruption).toBe(true);
    expect(hashPackageTree(f.undici)).toBe(patch.affectedTree);
    vi.mocked(writeFileSync).mockImplementation(fs.writeFileSync);
    patchInstalledOpenClawUndici({ npmRoot: f.npmRoot, packageName });
    expect(hashPackageTree(f.undici)).toBe(patch.fixedTree);
  });
  it("preserves metadata permissions under a restrictive process umask", () => {
    const f = fixture();
    const manifest = path.join(f.npmRoot, "package.json");
    const lock = path.join(f.npmRoot, "package-lock.json");
    fs.chmodSync(manifest, 0o640);
    fs.chmodSync(lock, 0o644);
    const originalUmask = process.umask(0o077);
    try {
      patchInstalledOpenClawUndici({ npmRoot: f.npmRoot, packageName });
      expect(fs.statSync(manifest).mode & 0o777).toBe(0o640);
      expect(fs.statSync(lock).mode & 0o777).toBe(0o644);
    } finally {
      process.umask(originalUmask);
    }
  });
});
