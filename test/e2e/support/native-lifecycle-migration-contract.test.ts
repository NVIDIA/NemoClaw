// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const LIVE_ROOT = path.join(import.meta.dirname, "..", "live");

function liveSource(name: string): string {
  return fs.readFileSync(path.join(LIVE_ROOT, name), "utf8");
}

describe("native lifecycle E2E migration contracts", () => {
  it("runs scheduled inference through native OpenClaw cron", () => {
    const source = liveSource("cron-preflight-inference-local.test.ts");

    expect(source).toMatch(/"openclaw",\s*"cron",\s*"add"/u);
    expect(source).toContain('["openclaw", "cron", "run", cronId]');
    expect(source).toContain('["openclaw", "cron", "remove", cronId]');
    expect(source).not.toContain("preflightCronModelProvider");
  });

  it.each([
    [
      "rebuild-openclaw.test.ts",
      /const DASHBOARD_PORT = 18_792[\s\S]*\$\{String\(DASHBOARD_PORT\)\}\/health/u,
      "/sandbox/.openclaw/workspace",
    ],
    ["rebuild-hermes.test.ts", /127\.0\.0\.1:8642\/health/u, "/sandbox/.hermes/memories"],
  ])("reduces %s to state restoration and native readiness", (file, readiness, statePath) => {
    const source = liveSource(file);

    expect(source).toContain('"rebuild", "--yes", "--verbose"');
    expect(source).toContain(statePath);
    expect(source).toMatch(readiness);
    expect(source).toContain("sandbox.cleanupSandbox");
    expect(source).not.toMatch(/Dockerfile\.base|repair controller|respawn|quarantine/iu);
  });
});
