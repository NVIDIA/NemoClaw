// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { expect, test } from "../framework/e2e-test.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

test("ubuntu repo cli smoke", async ({ artifacts, host }) => {
  await artifacts.writeJson("scenario.json", {
    id: "ubuntu-repo-cli-smoke",
    runner: "vitest",
    boundary: "repo-local-cli",
  });

  const result = await host.command(process.execPath, ["bin/nemoclaw.js", "--version"], {
    artifactName: "repo-cli-version",
    cwd: REPO_ROOT,
    timeoutMs: 30_000,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toMatch(/^nemoclaw v/);
});
