// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const installer = path.join(import.meta.dirname, "../..", "scripts", "install.sh");

it("documents gateway process retirement before accepting prepared upgrade state", async () => {
  const { stderr, stdout } = await promisify(execFile)("bash", [installer, "--help"], {
    encoding: "utf-8",
    env: process.env,
  });
  const backup =
    "NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS=1 nemoclaw backup-all --retire-legacy-forwards";
  const destroy = "openshell gateway destroy -g nemoclaw || openshell gateway destroy";

  expect(stderr).toBe("");
  expect(stdout).toContain(backup);
  expect(stdout).toContain(destroy);
  expect(stdout.indexOf(backup)).toBeLessThan(stdout.indexOf(destroy));
  expect(stdout).toContain(
    "For NEMOCLAW_GATEWAY_PORT=<port>, destroy nemoclaw-<port> with -g and omit the unnamed fallback",
  );
});
