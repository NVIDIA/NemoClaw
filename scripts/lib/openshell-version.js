// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const path = require("path");

const DEFAULT_MIN_OPENSHELL_VERSION = "0.0.24";
const MIN_OPENSHELL_VERSION_PATTERN =
  /^[\t ]*min_openshell_version:[\t ]*"(v?[0-9]+\.[0-9]+\.[0-9]+)".*$/m;

function parseMinimumOpenshellVersion(blueprintText = "") {
  const match = String(blueprintText ?? "").match(MIN_OPENSHELL_VERSION_PATTERN);
  return match?.[1]?.replace(/^v/i, "") || DEFAULT_MIN_OPENSHELL_VERSION;
}

function getMinimumOpenshellVersionFromFile(
  blueprintPath = path.join(__dirname, "..", "..", "nemoclaw-blueprint", "blueprint.yaml"),
) {
  if (!fs.existsSync(blueprintPath)) {
    return DEFAULT_MIN_OPENSHELL_VERSION;
  }
  return parseMinimumOpenshellVersion(fs.readFileSync(blueprintPath, "utf-8"));
}

if (require.main === module) {
  process.stdout.write(getMinimumOpenshellVersionFromFile(process.argv[2]));
}

module.exports = {
  DEFAULT_MIN_OPENSHELL_VERSION,
  getMinimumOpenshellVersionFromFile,
  parseMinimumOpenshellVersion,
};
