// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(new URL("../../../.github/workflows/e2e-v1.yaml", import.meta.url), "utf8"),
);
const command: string = workflow.jobs.result.steps[0].run;
const statuses = ["success", "failure", "cancelled", "skipped"];
const cases = statuses.flatMap((resolution) =>
  statuses.flatMap((native) => statuses.map((images) => ({ resolution, native, images }))),
);

describe("V1 aggregate result", () => {
  it.each(cases)(
    "reports resolution=$resolution native=$native images=$images without hiding failures",
    ({ resolution, native, images }) => {
      const directory = mkdtempSync(path.join(os.tmpdir(), "v1-suite-"));
      const summary = path.join(directory, "summary.md");
      const revision = "a".repeat(40);
      try {
        const result = spawnSync("bash", ["-e", "-c", command], {
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            GITHUB_STEP_SUMMARY: summary,
            REVISION: revision,
            RESOLUTION: resolution,
            NATIVE: native,
            IMAGES: images,
          },
        });
        expect(result.error).toBeUndefined();
        const success = [resolution, native, images].every((status) => status === "success");
        expect(result.status, result.stderr).toBe(success ? 0 : 1);
        const report = readFileSync(summary, "utf8");
        expect(report).toContain(revision);
        expect(report).toContain(`| Resolve revision | ${resolution} |`);
        expect(report).toContain(`| Native and bundle fixtures | ${native} |`);
        expect(report).toContain(`| Images and native adapters | ${images} |`);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
