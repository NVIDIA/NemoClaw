// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");

describe("inference selection validation", () => {
  it("preserves non-zero exit signaling when non-interactive endpoint validation fails (#5721)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-validation-exit-"));
    const scriptPath = path.join(tmpDir, "validation-exit-check.js");
    const validationPath = JSON.stringify(
      path.join(REPO_ROOT, "dist", "lib", "onboard", "inference-selection-validation.js"),
    );
    const probesPath = JSON.stringify(
      path.join(REPO_ROOT, "dist", "lib", "inference", "onboard-probes.js"),
    );
    const credentialsPath = JSON.stringify(
      path.join(REPO_ROOT, "dist", "lib", "credentials", "store.js"),
    );

    const script = String.raw`
const probesPath = require.resolve(${probesPath});
const credentialsPath = require.resolve(${credentialsPath});
require.cache[probesPath] = {
  id: probesPath,
  filename: probesPath,
  loaded: true,
  exports: {
    probeAnthropicEndpoint: () => {
      throw new Error("unexpected anthropic probe");
    },
    probeOpenAiLikeEndpoint: () => ({
      ok: false,
      failures: [{ name: "Chat Completions API", httpStatus: 403 }],
    }),
  },
};
require.cache[credentialsPath] = {
  id: credentialsPath,
  filename: credentialsPath,
  loaded: true,
  exports: {
    getCredential: () => "nvapi-invalid-key-12345",
  },
};
const { createInferenceSelectionValidationHelpers } = require(${validationPath});

const lines = [];
const exitCalls = [];
let promptCalls = 0;
const originalLog = console.log;
console.error = (...args) => lines.push(args.join(" "));
process.exitCode = undefined;
process.exit = (code) => {
  exitCalls.push(code);
  return undefined;
};

(async () => {
  const helpers = createInferenceSelectionValidationHelpers({
    isNonInteractive: () => true,
    agentProductName: () => "OpenClaw",
    promptValidationRecovery: async () => {
      promptCalls += 1;
      return "selection";
    },
  });
  let thrown = null;
  try {
    await helpers.validateOpenAiLikeSelection(
      "NVIDIA Endpoints",
      "https://integrate.api.nvidia.com/v1",
      "meta/llama-3.3-70b-instruct",
      "NVIDIA_INFERENCE_API_KEY",
    );
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  }
  originalLog(JSON.stringify({ thrown, exitCalls, exitCode: process.exitCode, promptCalls, lines }));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    });

    assert.equal(result.status, 1, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.thrown, "Non-interactive endpoint validation failed.");
    assert.deepEqual(payload.exitCalls, [1]);
    assert.equal(payload.exitCode, 1);
    assert.equal(payload.promptCalls, 0);
    assert.deepEqual(payload.lines, [
      "  NVIDIA Endpoints endpoint validation failed.",
      "  Validation probe summary: Chat Completions API: HTTP 403.",
      "  Validation details were omitted to avoid exposing credentials.",
    ]);
  });
});
