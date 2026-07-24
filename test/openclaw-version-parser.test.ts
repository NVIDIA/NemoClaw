// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const parser = path.join(repoRoot, "scripts", "extract-semver.sh");

function extract(input: string) {
  return spawnSync(parser, ["openclaw"], { encoding: "utf8", input });
}

describe("OpenClaw image version extraction (#5896)", () => {
  it.each([
    ["2026.5.27\n", "2026.5.27"],
    ["OpenClaw v2026.5.27 (abcdef)\n", "2026.5.27"],
    ["Dependency 1.2.3\nOpenClaw release: 2026.5.27\n", "2026.5.27"],
  ])("extracts a semantic version from %j", (input, expected) => {
    const result = extract(input);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  });

  it.each([
    "",
    "OpenClaw development build",
    "OpenClaw plugin 1.2.3",
    "Dependency 1.2.3\nOpenClaw development build",
    "OpenClaw 2026.5",
    "OpenClaw 2026.5.27.1",
  ])("fails closed for malformed output %j", (input) => {
    const result = extract(input);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });
});
