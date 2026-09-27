// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { REPO_ROOT } from "../fixtures/paths.ts";

const fixture = "test/e2e/support/fixtures/router-diagnostics.fixture.test.ts";
const slug = "router-diagnostic-failure-preserves-the-test-outcome-and-sandbox-cleanup";

it.each([
  { scenario: "primary", primaryErrors: [expect.stringContaining("original completion failure")] },
  { scenario: "success", primaryErrors: [] },
])(
  "reports diagnostic failure and still destroys the sandbox after $scenario",
  ({ scenario, primaryErrors }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "router-diagnostics-failure-"));
    try {
      const report = path.join(root, "report.json");
      const result = spawnSync(
        process.execPath,
        [
          path.join(REPO_ROOT, "node_modules/vitest/vitest.mjs"),
          "run",
          "--project",
          "e2e-support",
          fixture,
          "--reporter=json",
          `--outputFile=${report}`,
        ],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
          timeout: 30_000,
          killSignal: "SIGKILL",
          env: {
            ...process.env,
            E2E_ARTIFACT_DIR: root,
            NEMOCLAW_ROUTER_DIAGNOSTICS_FIXTURE: scenario,
          },
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      const errors = JSON.parse(fs.readFileSync(report, "utf8")).testResults[0].assertionResults[0]
        .failureMessages;
      expect(errors).toEqual(
        expect.arrayContaining([
          ...primaryErrors,
          expect.stringContaining("diagnostic storage unavailable"),
        ]),
      );
      expect(fs.readFileSync(path.join(root, slug, "sandbox-destroyed.txt"), "utf8")).toBe(
        "before destruction",
      );
      expect(JSON.parse(fs.readFileSync(path.join(root, slug, "cleanup.json"), "utf8"))).toEqual({
        passed: ["destroy fake sandbox"],
        failures: [
          { name: "retain Model Router diagnostics", message: "diagnostic storage unavailable" },
        ],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
