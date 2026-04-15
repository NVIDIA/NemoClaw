// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let origHome;
let tmpHome;
let moduleVersion = 0;

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-resolve-"));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function loadModule() {
  moduleVersion += 1;
  const moduleUrl = new URL("../nemoclaw/dist/blueprint/resolve.js", import.meta.url);
  return import(`${moduleUrl.href}?v=${moduleVersion}`);
}

// Write a minimal blueprint.yaml into the cache directory.
function writeCachedBlueprint(version, content) {
  const dir = path.join(tmpHome, ".nemoclaw", "blueprints", version);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "blueprint.yaml"), content, "utf-8");
  return dir;
}

describe("blueprint resolve", () => {
  it("getCacheDir returns path under HOME", async () => {
    const { getCacheDir } = await loadModule();
    expect(getCacheDir().startsWith(tmpHome)).toBe(true);
    expect(getCacheDir()).toContain(".nemoclaw");
  });

  it("getCachedBlueprintPath includes version", async () => {
    const { getCachedBlueprintPath } = await loadModule();
    const p = getCachedBlueprintPath("0.1.0");
    expect(p).toMatch(/0\.1\.0$/);
  });

  it("getCachedBlueprintPath rejects unsafe versions", async () => {
    const { getCachedBlueprintPath } = await loadModule();
    expect(() => getCachedBlueprintPath("../outside")).toThrow(/Invalid blueprint version/);
    expect(() => getCachedBlueprintPath("0.1.0/extra")).toThrow(/Invalid blueprint version/);
  });

  it("isCached returns false when no blueprint exists", async () => {
    const { isCached } = await loadModule();
    expect(isCached("0.1.0")).toBe(false);
  });

  it("isCached returns true after writing blueprint.yaml", async () => {
    writeCachedBlueprint("0.2.0", "version: 0.2.0\n");
    const { isCached } = await loadModule();
    expect(isCached("0.2.0")).toBe(true);
  });

  it("readCachedManifest returns null when not cached", async () => {
    const { readCachedManifest } = await loadModule();
    expect(readCachedManifest("0.9.9")).toBe(null);
  });

  it("readCachedManifest parses version field", async () => {
    writeCachedBlueprint(
      "0.1.0",
      [
        'version: "0.1.0"',
        'min_openshell_version: "0.1.0"',
        'min_openclaw_version: "2026.3.0"',
        "digest: abc123",
        "profiles:",
        "  - default",
        "  - gpu",
        "",
      ].join("\n"),
    );
    const { readCachedManifest } = await loadModule();
    const m = readCachedManifest("0.1.0");
    expect(m).toBeTruthy();
    expect(m.version).toBe("0.1.0");
    expect(m.digest).toBe("abc123");
    expect(m.profiles).toEqual(["default", "gpu"]);
  });

  it("readCachedManifest returns default profiles when missing", async () => {
    writeCachedBlueprint("0.3.0", "version: 0.3.0\n");
    const { readCachedManifest } = await loadModule();
    const m = readCachedManifest("0.3.0");
    expect(m).toBeTruthy();
    expect(m.profiles).toEqual(["default"]);
  });

  it("readCachedManifest rejects non-string manifest fields", async () => {
    writeCachedBlueprint("0.4.0", "version: 123\n");
    const { readCachedManifest } = await loadModule();
    expect(readCachedManifest("0.4.0")).toBe(null);
  });

  it("readCachedManifest defaults empty or duplicate profiles", async () => {
    writeCachedBlueprint("0.5.0", 'version: "0.5.0"\nprofiles: []\n');
    writeCachedBlueprint(
      "0.6.0",
      ['version: "0.6.0"', "profiles:", "  - default", "  - default", ""].join("\n"),
    );
    const { readCachedManifest } = await loadModule();
    expect(readCachedManifest("0.5.0")?.profiles).toEqual(["default"]);
    expect(readCachedManifest("0.6.0")?.profiles).toEqual(["default"]);
  });

  it("readCachedManifest returns null for invalid YAML", async () => {
    writeCachedBlueprint("0.7.0", "version: [\n");
    const { readCachedManifest } = await loadModule();
    expect(readCachedManifest("0.7.0")).toBe(null);
  });

  it("readCachedManifest returns null for non-object YAML", async () => {
    writeCachedBlueprint("0.8.0", "[]\n");
    writeCachedBlueprint("0.8.1", "true\n");
    const { readCachedManifest } = await loadModule();
    expect(readCachedManifest("0.8.0")).toBe(null);
    expect(readCachedManifest("0.8.1")).toBe(null);
  });
});
