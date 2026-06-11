// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";

import { testTimeoutOptions } from "./helpers/timeouts";

// Coverage guard for #4537. The Local Ollama onboarding path is the only
// current caller that requires strict Chat Completions tool calls. This
// hermetic, caller-level Vitest test exercises that validation path against
// an OpenAI-compatible mock endpoint so payload-shape and retry regressions
// do not require a GPU/Ollama runner to catch.
//
// Replaces test/e2e/test-strict-tool-call-probe.sh per #5119 retirement
// pattern: caller-level mock-driven probes belong in test/, not in live E2E
// scenario/fixture surfaces or the regression-e2e bash workflow. Refs #5098, #4349.
//
// Why subprocess: the validation path drives `curl` via spawnSync with a
// tight process timeout. Driving the entire scenario set through a fresh
// `tsx <driver>` child mirrors the legacy script (and #5119's
// onboard-gateway-docker-unreachable.test.ts) and keeps the behavior under
// test identical to production runtime conditions — bypassing Vitest's
// worker pool, fetch shim, and signal handling, all of which can interfere
// with the in-process curl subprocess used by validateOpenAiLikeSelection.
//
// The driver is `.ts` (executed via tsx) rather than `.cjs` per the
// codebase-growth guardrail that forbids newly added .js/.cjs/.mjs files.

const REPO_ROOT = path.join(import.meta.dirname, "..");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const DRIVER = path.join(import.meta.dirname, "fixtures", "strict-tool-call-probe-driver.ts");
const REQUIRED_DIST_MODULES = [
  path.join(REPO_ROOT, "dist", "lib", "onboard", "inference-selection-validation.js"),
  path.join(REPO_ROOT, "dist", "lib", "inference", "local.js"),
];

const EXPECTED_PASS_MARKERS = [
  "[PASS] strict validation succeeds with structured tool_calls",
  "[PASS] Local Ollama onboarding caller enforces strict Chat Completions validation",
  "[PASS] strict validation retries a transient 502 and keeps bounded payloads",
  "[PASS] strict validation fails closed when no structured tool_call is returned",
];

describe("strict Chat Completions tool-call probe (#4537)", () => {
  it(
    "validates Local Ollama strict tool-call enforcement against a hermetic mock",
    testTimeoutOptions(120_000),
    () => {
      const missingDistModules = REQUIRED_DIST_MODULES.filter(
        (modulePath) => !fs.existsSync(modulePath),
      );
      assert.deepEqual(
        missingDistModules,
        [],
        `strict tool-call probe requires built CLI artifacts; run npm run build:cli first. Missing:\n${missingDistModules.join("\n")}`,
      );

      const result = spawnSync(TSX, [DRIVER], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, NEMOCLAW_TEST_NO_SLEEP: "1" },
        timeout: 110_000,
        // Inherit stderr for diagnostic visibility on failure; capture stdout
        // to assert the [PASS] markers below.
        stdio: ["ignore", "pipe", "inherit"],
      });

      const stdout = result.stdout ?? "";
      assert.equal(
        result.status,
        0,
        `strict tool-call probe driver exited with ${result.status}; stdout:\n${stdout}`,
      );

      for (const marker of EXPECTED_PASS_MARKERS) {
        assert.ok(
          stdout.includes(marker),
          `missing pass marker ${JSON.stringify(marker)} in driver stdout:\n${stdout}`,
        );
      }
    },
  );
});
