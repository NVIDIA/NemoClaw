// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeWrapperFixture } from "../../helpers/langchain-deepagents-code-image.ts";
import {
  cleanupPackageFixtures,
  createPackageFixture,
  patchFixture,
} from "../../helpers/langchain-deepagents-code-patch-fixture.ts";

afterEach(cleanupPackageFixtures);

// These comparisons stop at the wrapper's downstream process boundary. The fixture
// records dispatch; it does not run native tools, inference, updates, or an ACP server.
const cases = [
  { id: "D01", args: ["-n", "hello", "--interpreter"] },
  { id: "D03", args: ["tools", "configure"] },
  { id: "D05", args: ["--rubric-model", "openai:fixture"] },
  { id: "D08", args: ["--acp"] },
  { id: "D11", args: ["mcp", "list"] },
] as const;

function runWrapper(wrapperPath: string, args: readonly string[], env = {}) {
  return spawnSync("bash", [wrapperPath, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
    timeout: 5000,
  });
}

describe("Deep Agents native command forwarding", () => {
  it.each(cases)(
    "$id preserves native parser options with credential handling installed (#11763)",
    ({ args }) => {
      const directory = createPackageFixture();
      const probe = () =>
        spawnSync(
          "python3",
          ["-c", "from deepagents_code.main import parse_args; parse_args()", ...args],
          {
            encoding: "utf8",
            timeout: 5000,
            env: { PATH: process.env.PATH, PYTHONPATH: directory },
          },
        );
      const native = probe();
      expect(native.status, native.stderr).toBe(0);
      patchFixture(directory);
      const managed = probe();
      expect(managed.status, managed.stderr).toBe(0);
    },
  );

  it.each(cases)(
    "$id forwards native commands while retaining credential and prompt checks (#11763)",
    ({ args }) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dcode-removal-"));
      try {
        const { wrapperPath, ranMarker } = makeWrapperFixture(directory);
        const candidate = runWrapper(wrapperPath, args);
        expect(candidate.status, candidate.stderr).toBe(0);
        expect(fs.existsSync(ranMarker)).toBe(true);

        // A passing dispatch comparison must not hide an accidentally removed
        // credential check or the separate empty-prompt validation.
        fs.unlinkSync(ranMarker);
        const secret = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
        const rejected = runWrapper(wrapperPath, args, { OPENAI_API_KEY: secret });
        expect(rejected.status).not.toBe(0);
        expect(fs.existsSync(ranMarker)).toBe(false);
        expect(rejected.stdout + rejected.stderr).not.toContain(secret);
        const blank = runWrapper(wrapperPath, ["-n", ""]);
        expect(blank.status).toBe(2);
        expect(fs.existsSync(ranMarker)).toBe(false);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
