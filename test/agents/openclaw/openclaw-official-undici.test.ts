// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hashPackageTree,
  replaceInstalledOfficialUndici,
} from "../../../scripts/lib/openclaw-npm-remediation.mts";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, renameSync: vi.fn(original.renameSync) };
});

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
  vi.clearAllMocks();
});

function fixture(channel = "discord", previous = "8.10.0", next = "8.10.2") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-official-undici-"));
  temporary.push(root);
  const installed = path.join(root, "installed");
  const original = path.join(root, "original");
  const patched = path.join(root, "patched");
  for (const [directory, version] of [
    [installed, previous],
    [original, previous],
    [patched, next],
  ]) {
    fs.mkdirSync(path.join(directory, "node_modules", "undici"), { recursive: true });
    fs.writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({
        name: `@openclaw/${channel}`,
        version: "2026.9.1",
        dependencies: { undici: previous },
        bundleDependencies: ["undici"],
      }),
    );
    fs.writeFileSync(
      path.join(directory, "node_modules", "undici", "package.json"),
      JSON.stringify({ name: "undici", version }),
    );
    fs.writeFileSync(
      path.join(directory, "node_modules", "undici", "index.js"),
      `module.exports = ${JSON.stringify(version)};\n`,
    );
  }
  return { installed, original, patched, spec: `@openclaw/${channel}@2026.9.1` };
}

describe("official OpenClaw bundled Undici override", () => {
  it.each([
    ["discord", "8.10.0", "8.10.2"],
    ["slack", "7.29.0", "7.29.1"],
  ])(
    "replaces the %s bundle while retaining publisher metadata and peers",
    (channel, previous, next) => {
      const { installed, original, patched, spec } = fixture(channel, previous, next);
      fs.symlinkSync(original, path.join(installed, "node_modules", "openclaw"), "dir");
      expect(replaceInstalledOfficialUndici(spec, installed, original, patched)).toBe(true);
      expect(
        JSON.parse(
          fs.readFileSync(path.join(installed, "node_modules", "undici", "package.json"), "utf8"),
        ).version,
      ).toBe(next);
      expect(hashPackageTree(path.join(installed, "node_modules", "undici"))).toBe(
        hashPackageTree(path.join(patched, "node_modules", "undici")),
      );
      expect(fs.lstatSync(path.join(installed, "node_modules", "openclaw")).isSymbolicLink()).toBe(
        true,
      );
      expect(fs.readlinkSync(path.join(installed, "node_modules", "openclaw"))).toBe(original);
      expect(replaceInstalledOfficialUndici(spec, installed, original, patched)).toBe(false);
      expect(fs.readdirSync(path.join(installed, "node_modules")).sort()).toEqual([
        "openclaw",
        "undici",
      ]);
      fs.unlinkSync(path.join(installed, "node_modules", "openclaw"));
      expect(hashPackageTree(installed)).toBe(hashPackageTree(patched));
    },
  );

  it("rejects unexpected installed dependency bytes without writing", () => {
    const { installed, original, patched, spec } = fixture();
    fs.writeFileSync(
      path.join(installed, "node_modules", "undici", "index.js"),
      "unexpected bytes",
    );
    const before = hashPackageTree(installed);
    expect(() => replaceInstalledOfficialUndici(spec, installed, original, patched)).toThrow(
      "differ from the verified archive",
    );
    expect(hashPackageTree(installed)).toBe(before);
  });

  it.each(["package.json", "node_modules/undici"])(
    "rejects a redirected %s before replacement",
    (relative) => {
      const { installed, original, patched, spec } = fixture();
      const target = path.join(installed, relative);
      fs.rmSync(target, { recursive: true });
      fs.symlinkSync(path.join(original, relative), target);
      const before = hashPackageTree(original);
      expect(() => replaceInstalledOfficialUndici(spec, installed, original, patched)).toThrow(
        "must be a real",
      );
      expect(hashPackageTree(original)).toBe(before);
    },
  );

  it("restores the original dependency if publishing the replacement fails", () => {
    const { installed, original, patched, spec } = fixture();
    const before = hashPackageTree(installed);
    const rename = vi.mocked(fs.renameSync);
    const realRename = rename.getMockImplementation()!;
    rename.mockImplementationOnce(realRename).mockImplementationOnce(() => {
      throw new Error("replacement rename failed");
    });
    expect(() => replaceInstalledOfficialUndici(spec, installed, original, patched)).toThrow(
      "replacement rename failed",
    );
    expect(hashPackageTree(installed)).toBe(before);
  });
});
