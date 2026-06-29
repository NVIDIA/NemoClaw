// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { expect, test } from "../fixtures/e2e-test.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_DIST_ENTRYPOINT = path.join(REPO_ROOT, "dist", "nemoclaw.js");

test("ubuntu repo cli smoke", async ({ artifacts, host }) => {
  await artifacts.writeJson("scenario.json", {
    id: "ubuntu-repo-cli-smoke",
    runner: "vitest",
    boundary: "repo-local-cli",
  });

  expect(
    fs.existsSync(CLI_DIST_ENTRYPOINT),
    "run `npm run build:cli` before live repo CLI scenarios",
  ).toBe(true);

  const result = await host.command(process.execPath, ["bin/nemoclaw.js", "--version"], {
    artifactName: "repo-cli-version",
    cwd: REPO_ROOT,
    timeoutMs: 30_000,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toMatch(/^nemoclaw v/);
});
