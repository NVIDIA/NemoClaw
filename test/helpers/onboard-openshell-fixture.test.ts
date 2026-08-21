// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeOkOpenshell } from "./onboard-openshell-fixture";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function runFixture(args: string[]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-fixture-"));
  temporaryDirectories.push(directory);
  writeOkOpenshell(directory, { readySandboxGet: true });
  return spawnSync(path.join(directory, "openshell"), args, { encoding: "utf8" });
}

describe("onboarding OpenShell fixture", () => {
  it("separates global absence, sandbox JSON, and base policy queries (#9833)", () => {
    const history = runFixture(["policy", "list", "-g", "nemoclaw", "--global", "--limit", "1"]);
    expect(history).toMatchObject({ status: 0, stdout: "" });

    const metadata = runFixture([
      "policy",
      "get",
      "-g",
      "nemoclaw",
      "--full",
      "--output",
      "json",
      "alpha",
    ]);
    expect(metadata.status).toBe(0);
    expect(JSON.parse(metadata.stdout)).toEqual({
      scope: "sandbox",
      sandbox: "alpha",
      status: "effective",
      policy_source: "sandbox",
      policy: {},
    });

    const basePolicy = runFixture(["policy", "get", "-g", "nemoclaw", "--base", "alpha"]);
    expect(basePolicy).toMatchObject({ status: 0, stdout: "" });

    const unexpectedGlobalGet = runFixture([
      "policy",
      "get",
      "--global",
      "--full",
      "--output",
      "json",
    ]);
    expect(unexpectedGlobalGet.status).toBe(64);
  });
});
