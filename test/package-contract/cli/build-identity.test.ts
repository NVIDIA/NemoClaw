// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { getBuildIdentity } from "../../../dist/lib/core/version";

const REPOSITORY_ROOT = path.join(import.meta.dirname, "..", "..", "..");

describe("compiled CLI build identity", () => {
  it("reports one immutable version and source revision (#7777)", () => {
    const identity = getBuildIdentity({ rootDir: REPOSITORY_ROOT });
    const versionOutput = execFileSync(
      process.execPath,
      [path.join(REPOSITORY_ROOT, "bin", "nemoclaw.js"), "--version"],
      {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
      },
    ).trim();

    expect(versionOutput).toBe(`nemoclaw v${identity.nemoclawVersion}`);
    expect(identity.sourceRevision).toMatch(/^[0-9a-f]{40,64}$/);
    const describedRevision = /-\d+-g([0-9a-f]{7,64})$/.exec(identity.nemoclawVersion)?.[1];
    expect(
      describedRevision === undefined || identity.sourceRevision.startsWith(describedRevision),
    ).toBe(true);
  }, 15_000);
});
