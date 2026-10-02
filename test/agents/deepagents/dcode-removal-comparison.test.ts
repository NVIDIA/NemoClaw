// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeWrapperFixture, omitRejection } from "./dcode-wrapper-fixture.ts";
import {
  cleanupPackageFixtures,
  createPackageFixture,
  patchFixture,
} from "../../helpers/langchain-deepagents-code-patch-fixture.ts";

afterEach(cleanupPackageFixtures);

// These comparisons stop at the wrapper's downstream process boundary. The fixture
// records dispatch; it does not run native tools, inference, updates, or an ACP server.
const cases = [
  { id: "D01", arm: "    --interpreter)", args: ["-n", "hello", "--interpreter"] },
  { id: "D03", arm: "  tools)", args: ["tools", "configure"] },
  { id: "D04", arm: "  update | install)", args: ["update"] },
  { id: "D05", arm: "    --model-p |", args: ["--model-params", '{"temperature":0.2}'] },
  { id: "D07", arm: "    -y |", args: ["-n", "hello", "--auto-approve"] },
  { id: "D08", arm: "    --acp)", args: ["--acp"] },
  { id: "D11", arm: "  mcp)", args: ["mcp", "list"] },
] as const;

function runWrapper(wrapperPath: string, args: readonly string[], env = {}) {
  return spawnSync("bash", [wrapperPath, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
    timeout: 5000,
  });
}

describe("Deep Agents proposed shell removal effects", () => {
  it.each(cases)(
    "$id retains a Python rejection if only the shell rejection is removed (#11763)",
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
      expect(managed.status).not.toBe(0);
      expect(managed.stderr).toContain("disabled");
    },
  );

  it.each(cases)(
    "$id forwards the command only after its extra rejection is omitted (#11763)",
    ({ arm, args }) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dcode-removal-"));
      try {
        const { wrapperPath, ranMarker } = makeWrapperFixture(directory);
        const current = runWrapper(wrapperPath, args);
        expect(current.status, current.stderr).toBe(2);
        expect(fs.existsSync(ranMarker)).toBe(false);

        fs.writeFileSync(wrapperPath, omitRejection(fs.readFileSync(wrapperPath, "utf8"), arm));
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
