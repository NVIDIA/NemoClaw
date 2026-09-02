// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const FIXTURE = path.resolve(import.meta.dirname, "../fixtures/plugins/weather");

describe("weather plugin fixture dependency graph", () => {
  it("does not retain a vulnerable fast-uri advisory", () => {
    const result = spawnSync("npm", ["audit", "--json", "--package-lock-only"], {
      cwd: FIXTURE,
      encoding: "utf8",
    });
    const report = JSON.parse(result.stdout);

    expect(report.vulnerabilities?.["fast-uri"]).toBeUndefined();
  });
});
