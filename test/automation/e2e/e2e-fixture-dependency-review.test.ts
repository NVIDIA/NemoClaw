// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const FIXTURES_ROOT = path.join(REPO_ROOT, "test", "e2e", "fixtures");
const REVIEW_PATH = path.join(
  REPO_ROOT,
  "internal",
  "security-reviews",
  "e2e-weather-plugin-fixture-dependency-review.md",
);
const WEATHER_LOCK_PATH = path.join(FIXTURES_ROOT, "plugins", "weather", "package-lock.json");

describe("E2E fixture dependency review", () => {
  const review = fs.readFileSync(REVIEW_PATH, "utf8");

  it("records every committed fixture lockfile in the checked-in review", () => {
    const lockfiles = execFileSync(
      "git",
      ["ls-files", "--", "test/e2e/fixtures/**/package-lock.json"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(lockfiles.length).toBeGreaterThan(0);
    expect(lockfiles.every((lockfile) => review.includes(`- \`${lockfile}\``))).toBe(true);
  });

  it("binds the weather fixture review to its patched dependency lock", () => {
    const lockBytes = fs.readFileSync(WEATHER_LOCK_PATH);
    const lock = JSON.parse(lockBytes.toString("utf8"));

    expect(createHash("sha256").update(lockBytes).digest("hex")).toBe(
      "36f8e08c8dca622017c943e4b41d1758651b2911e6c44b96e26cba4ea05b2556",
    );
    expect(lock.packages["node_modules/openclaw"]).toMatchObject({ version: "2026.7.1" });
    expect(lock.packages["node_modules/openclaw/node_modules/fast-uri"]).toMatchObject({
      integrity:
        "sha512-7Ical1vFEMr0onbVzEDIreM22I4khW+fzyQPwvAFWBp1iwdshSZRsL4jjRvPG9JP1uiqMHRto+YU6R2/CzDz5Q==",
      resolved: "https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.6.tgz",
      version: "3.1.6",
    });
    expect(review).toContain("`openclaw@2026.7.1`");
    expect(review).toContain("`fast-uri` is absent from the advisory report");
    expect(review).toContain("`36f8e08c8dca622017c943e4b41d1758651b2911e6c44b96e26cba4ea05b2556`");
  });

  it.each([
    "npm ci --ignore-scripts",
    "read-only `contents` permission",
    "full-SHA-pinned actions",
    "disables checkout credential persistence",
    "receives no repository secrets",
    "npm audit --package-lock-only --ignore-scripts --json",
    "accepted residual risk is limited to this secret-free E2E lane with read-only contents permission",
    "Rerun it whenever `package.json` or `package-lock.json` changes",
  ])("records the fixture threat controls and revalidation contract [case %#]", (marker) => {
    expect(review).toContain(marker);
  });
});
