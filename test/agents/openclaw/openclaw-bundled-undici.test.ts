// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OPENCLAW_UNDICI_PATCHES,
  patchInstalledOpenClawUndici,
  patchVerifiedOfficialPluginUndici,
} from "../../../scripts/lib/openclaw-npm-remediation.mts";

const roots: string[] = [];
function fixture(packageName: keyof typeof OPENCLAW_UNDICI_PATCHES = "@openclaw/slack") {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-undici-patch-"));
  roots.push(state);
  const npmRoot = path.join(state, "npm/projects/plugin");
  const plugin = path.join(npmRoot, "node_modules", packageName);
  const undici = path.join(plugin, "node_modules/undici");
  fs.mkdirSync(undici, { recursive: true });
  fs.writeFileSync(
    path.join(plugin, "package.json"),
    JSON.stringify({ name: packageName, version: "2026.9.1" }),
  );
  fs.writeFileSync(
    path.join(undici, "package.json"),
    JSON.stringify({ name: "undici", version: OPENCLAW_UNDICI_PATCHES[packageName].affected }),
  );
  return { state, npmRoot, plugin, undici, packageName };
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("official OpenClaw bundled Undici patch", () => {
  it.each(["@openclaw/slack", "@openclaw/discord"] as const)(
    "rejects changed %s bundle contents even when the affected version matches",
    (packageName) => {
      const f = fixture(packageName);
      expect(() => patchInstalledOpenClawUndici(f)).toThrow("Unreviewed bundled Undici tree");
      expect(JSON.parse(fs.readFileSync(path.join(f.undici, "package.json"), "utf8")).version).toBe(
        OPENCLAW_UNDICI_PATCHES[packageName].affected,
      );
      expect(fs.readdirSync(f.npmRoot)).toEqual(["node_modules"]);
    },
  );
  it("rejects a forged fixed-version manifest without accepting the package as patched", () => {
    const f = fixture();
    fs.writeFileSync(
      path.join(f.undici, "package.json"),
      JSON.stringify({ name: "undici", version: "7.29.1" }),
    );
    expect(() => patchInstalledOpenClawUndici(f)).toThrow("Unreviewed bundled Undici tree");
  });
  it("rejects a different OpenClaw release before modifying its dependencies", () => {
    const f = fixture();
    fs.writeFileSync(
      path.join(f.plugin, "package.json"),
      JSON.stringify({ name: f.packageName, version: "2026.9.5" }),
    );
    expect(() => patchInstalledOpenClawUndici(f)).toThrow("2026.9.1");
  });
  it("rejects a bundled dependency redirected through a symlink", () => {
    const f = fixture();
    const outside = path.join(f.state, "outside");
    fs.renameSync(f.undici, outside);
    fs.symlinkSync(outside, f.undici);
    expect(() => patchInstalledOpenClawUndici(f)).toThrow("real directory");
    expect(fs.existsSync(path.join(outside, "package.json"))).toBe(true);
  });
  it("rejects a symlink inside the installed dependency before changing files", () => {
    const f = fixture();
    fs.symlinkSync(path.join(f.plugin, "package.json"), path.join(f.undici, "linked.json"));
    expect(() => patchInstalledOpenClawUndici(f)).toThrow();
    expect(fs.lstatSync(path.join(f.undici, "linked.json")).isSymbolicLink()).toBe(true);
  });
  it("rejects inspection paths outside the managed npm projects", () => {
    const f = fixture();
    const outside = path.join(f.state, "other");
    fs.mkdirSync(outside);
    expect(() =>
      patchVerifiedOfficialPluginUndici({
        packageSpec: "@openclaw/slack@2026.9.1",
        installPath: path.join(outside, "node_modules/@openclaw/slack"),
        env: { OPENCLAW_STATE_DIR: f.state },
      }),
    ).toThrow("escaped");
  });
  it("requires an absolute path from official plugin inspection", () => {
    expect(() =>
      patchVerifiedOfficialPluginUndici({
        packageSpec: "@openclaw/slack@2026.9.1",
        installPath: "relative",
        env: {},
      }),
    ).toThrow("absolute install path");
  });
  it.each(["@openclaw/msteams@2026.9.1", "@openclaw/slack@2026.9.5"])(
    "leaves %s outside the patch scope untouched",
    (packageSpec) => {
      expect(
        patchVerifiedOfficialPluginUndici({ packageSpec, installPath: undefined, env: {} }),
      ).toBe(false);
    },
  );
});
