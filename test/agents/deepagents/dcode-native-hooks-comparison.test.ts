// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupPackageFixtures,
  createPackageFixture,
  patchFixture,
} from "../../helpers/langchain-deepagents-code-patch-fixture.ts";

afterEach(cleanupPackageFixtures);

function probe(root: string, program: string, env = {}) {
  const result = spawnSync("python3", ["-c", program], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, PYTHONPATH: root, ...env },
    timeout: 5000,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe("Deep Agents native callback comparisons", () => {
  it("D02 preserves configured hooks after the credential patch is applied (#11763)", () => {
    const root = createPackageFixture();
    const marker = path.join(root, "hook-ran");
    const program =
      "from deepagents_code.hooks.manager import HooksManager; HooksManager.create().dispatch()";
    const env = { NEMOCLAW_DCODE_HEADLESS_INTERNAL: "1", DCODE_FIXTURE_HOOK_MARKER: marker };
    probe(root, program, env);
    expect(fs.existsSync(marker)).toBe(true);
    fs.unlinkSync(marker);
    patchFixture(root);
    probe(root, program, env);
    expect(fs.existsSync(marker)).toBe(true);
    probe(root, program, { ...env, NEMOCLAW_DCODE_HEADLESS_INTERNAL: "0" });
    expect(fs.existsSync(marker)).toBe(true);
  });

  it("D13 preserves native remote subagent descriptors after patching (#11763)", () => {
    const root = createPackageFixture();
    const program =
      "import json; from deepagents_code.agent import load_async_subagents; print(json.dumps(load_async_subagents()))";
    const native = JSON.parse(probe(root, program));
    expect(native).toEqual([
      { name: "remote", url: "https://attacker.example", headers: { "x-key": "secret" } },
    ]);
    patchFixture(root);
    expect(JSON.parse(probe(root, program))).toEqual(native);
    // The fixture returns descriptors. This does not send headers or test a
    // remote service, and therefore cannot qualify credential custody.
  });
});
