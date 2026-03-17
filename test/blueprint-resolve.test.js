// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

let origHome;
let tmpHome;

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-resolve-"));
  process.env.HOME = tmpHome;
  delete require.cache[require.resolve("../nemoclaw/dist/blueprint/resolve.js")];
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function loadModule() {
  return require("../nemoclaw/dist/blueprint/resolve.js");
}

// Write a minimal blueprint.yaml into the cache directory.
function writeCachedBlueprint(version, content) {
  const dir = path.join(tmpHome, ".nemoclaw", "blueprints", version);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "blueprint.yaml"), content, "utf-8");
  return dir;
}

describe("blueprint resolve", () => {
  it("getCacheDir returns path under HOME", () => {
    const { getCacheDir } = loadModule();
    assert.ok(getCacheDir().startsWith(tmpHome));
    assert.ok(getCacheDir().includes(".nemoclaw"));
  });

  it("getCachedBlueprintPath includes version", () => {
    const { getCachedBlueprintPath } = loadModule();
    const p = getCachedBlueprintPath("0.1.0");
    assert.ok(p.endsWith("0.1.0"));
  });

  it("isCached returns false when no blueprint exists", () => {
    const { isCached } = loadModule();
    assert.equal(isCached("0.1.0"), false);
  });

  it("isCached returns true after writing blueprint.yaml", () => {
    writeCachedBlueprint("0.2.0", "version: 0.2.0\n");
    const { isCached } = loadModule();
    assert.equal(isCached("0.2.0"), true);
  });

  it("readCachedManifest returns null when not cached", () => {
    const { readCachedManifest } = loadModule();
    assert.equal(readCachedManifest("0.9.9"), null);
  });

  it("readCachedManifest parses version field", () => {
    writeCachedBlueprint("0.1.0", [
      'version: "0.1.0"',
      'min_openshell_version: "0.1.0"',
      'min_openclaw_version: "2026.3.0"',
      "digest: abc123",
      "",
    ].join("\n"));
    const { readCachedManifest } = loadModule();
    const m = readCachedManifest("0.1.0");
    assert.ok(m);
    assert.equal(m.version, '"0.1.0"');
    assert.equal(m.digest, "abc123");
  });

  it("readCachedManifest returns default profiles when missing", () => {
    writeCachedBlueprint("0.3.0", "version: 0.3.0\n");
    const { readCachedManifest } = loadModule();
    const m = readCachedManifest("0.3.0");
    assert.ok(m);
    assert.deepEqual(m.profiles, ["default"]);
  });
});
