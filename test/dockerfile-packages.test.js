// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, "..", relPath), "utf8");
}

function packagesFromDockerfile(contents) {
  const match = contents.match(/apt-get install -y --no-install-recommends \\\n([\s\S]*?)\n\s*&& rm -rf/);
  assert.ok(match, "expected apt-get install block");

  return match[1]
    .split("\n")
    .map((line) => line.replace(/\\/, "").trim())
    .filter(Boolean);
}

describe("sandbox image package list", () => {
  it("includes nano in the production sandbox image", () => {
    const packages = packagesFromDockerfile(read("Dockerfile"));
    assert.ok(packages.includes("nano"), "expected production sandbox image to install nano");
  });

  it("includes nano in the test sandbox image", () => {
    const packages = packagesFromDockerfile(read("test/Dockerfile.sandbox"));
    assert.ok(packages.includes("nano"), "expected test sandbox image to install nano");
  });
});
