// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { testTimeout } from "./helpers/timeouts";

const ONBOARD_PREFLIGHT_TEST_TIMEOUT_MS = testTimeout(60_000);

// Regression for #5207: a non-interactive `nemoclaw onboard` with an
// unrecognised NEMOCLAW_VLLM_MODEL slug must fail fast with a non-zero exit
// code BEFORE any onboarding side effects (preflight, Docker, sandbox).
// Previously the slug was only validated deep inside the express-vLLM
// installer (the [3/8] provider step), so the variable was effectively
// validated late and other onboard paths ignored it — mirroring the gap the
// connect command closed in #4567 with an up-front preflight.
describe("onboard NEMOCLAW_VLLM_MODEL preflight (#5207)", {
  timeout: ONBOARD_PREFLIGHT_TEST_TIMEOUT_MS,
}, () => {
  it("exits non-zero with the slug error before reaching the preflight step", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-vllm-bad-slug-"));
    const scriptPath = path.join(tmpDir, "onboard-bad-slug-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "credentials", "store.js"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

// Non-interactive onboarding must never prompt; surface it loudly if it does.
credentials.prompt = async () => {
  throw new Error("Unexpected prompt in non-interactive onboard test");
};
credentials.ensureApiKey = async () => {};
runner.runCapture = () => "";

const { onboard } = require(${onboardPath});

(async () => {
  await onboard({
    fresh: true,
    nonInteractive: true,
    sandboxName: "vllm-bad-slug",
    acceptThirdPartySoftware: true,
  });
  // Reaching here means onboard() did NOT fast-fail on the bad slug.
  console.error("ONBOARD_RETURNED_WITHOUT_FAST_FAIL");
  process.exit(0);
})().catch((error) => {
  console.error("ONBOARD_THREW: " + (error && error.message));
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_PROVIDER: "install-vllm",
        NEMOCLAW_VLLM_MODEL: "not-a-real-model",
        NEMOCLAW_EXPERIMENTAL: "1",
      },
    });

    const combined = `${result.stdout}\n${result.stderr}`;

    // Fails with a non-zero exit code so CI / scripts detect the failure.
    expect(result.status).toBe(1);
    // Surfaces the actionable, slug-listing error from selectVllmModelFromEnv.
    expect(result.stderr).toMatch(/NEMOCLAW_VLLM_MODEL/);
    expect(result.stderr).toMatch(/not-a-real-model/);
    // Fast-fail happens before any onboarding side effects: the preflight step
    // ([1/8]) must never run for an invalid slug.
    expect(combined).not.toContain("[1/8] Preflight checks");
  });
});
