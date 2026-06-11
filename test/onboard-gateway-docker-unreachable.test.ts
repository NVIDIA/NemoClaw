// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { testTimeoutOptions } from "./helpers/timeouts";

describe("startGateway Docker-unreachable fallback (#2347)", () => {
  it("fast-fails before health polling or generic cleanup", testTimeoutOptions(20_000), () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-docker-down-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "gateway-docker-down.cjs");
    const tracePath = path.join(tmpDir, "openshell.trace");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(tracePath, "");
    fs.writeFileSync(
      path.join(fakeBin, "openshell"),
      `#!/usr/bin/env bash
set -euo pipefail
trace="\${NEMOCLAW_FAKE_OPENSHELL_TRACE:?}"
printf "%s\\n" "$*" >> "$trace"

if [[ "$*" == "--version" ]]; then
  printf "openshell 0.0.44\\n"
  exit 0
fi
if [[ "$*" == "gateway --help" ]]; then
  printf "Commands: start select info destroy remove\\n"
  exit 0
fi
if [[ "$*" == *"gateway"*"start"* ]]; then
  printf "__GATEWAY_START__\\n" >> "$trace"
  printf "Error: Failed to create Docker client.\\n"
  printf "Socket not found: /var/run/docker.sock\\n"
  exit 1
fi
if [[ "$*" == *"status"* || "$*" == *"gateway"*"info"* ]]; then
  printf "HEALTH POLL REACHED\\n"
  exit 0
fi
if [[ "$*" == *"doctor"*"logs"* ]]; then
  printf "DOCTOR LOGS REACHED\\n"
  exit 0
fi
if [[ "$*" == *"gateway"*"select"* || "$*" == *"gateway"*"destroy"* || "$*" == *"gateway"*"remove"* ]]; then
  exit 0
fi
exit 0
`,
      { mode: 0o755 },
    );

    const script = `
const mod = require("module");
const origLoad = mod._load;
mod._load = function(req, parent, isMain) {
  if (req === "p-retry") {
    const pRetry = async (fn, opts) => {
      try {
        return await fn({ attemptNumber: 1, retriesLeft: 0 });
      } catch (e) {
        if (!(e instanceof pRetry.AbortError) && opts && opts.onFailedAttempt) {
          opts.onFailedAttempt(Object.assign(e, { attemptNumber: 1, retriesLeft: 0 }));
        }
        throw e;
      }
    };
    pRetry.AbortError = class AbortError extends Error {};
    return pRetry;
  }
  return origLoad.call(this, req, parent, isMain);
};
Object.defineProperty(process, "platform", { value: "darwin" });
Object.defineProperty(process, "arch", { value: "x64" });
const { startGateway } = require(${onboardPath});
startGateway(null).catch(() => {});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_FAKE_OPENSHELL_TRACE: tracePath,
        NEMOCLAW_HEALTH_POLL_COUNT: "5",
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
    });

    assert.equal(result.status, 1, `unexpected exit code; stderr:\n${result.stderr}`);
    assert.ok(
      result.stderr.includes("Docker daemon is not running"),
      `expected Docker recovery guidance in stderr:\n${result.stderr}`,
    );
    assert.ok(
      result.stderr.includes("colima start"),
      `expected macOS Docker start hint in stderr:\n${result.stderr}`,
    );
    assert.ok(
      !result.stdout.includes("Waiting for gateway health"),
      `health polling should not start after Docker-unreachable output:\n${result.stdout}`,
    );
    assert.ok(
      !result.stdout.includes("HEALTH POLL REACHED"),
      `gateway status/info probes should not run after Docker-unreachable output:\n${result.stdout}`,
    );
    assert.ok(
      !result.stderr.includes("Cleaning up failed gateway state"),
      `Docker-unreachable failure should skip generic cleanup:\n${result.stderr}`,
    );
    assert.ok(
      !result.stderr.includes("openshell doctor logs"),
      `Docker-unreachable failure should skip generic diagnostics:\n${result.stderr}`,
    );

    const trace = fs.readFileSync(tracePath, "utf8");
    assert.ok(trace.includes("__GATEWAY_START__"), `gateway start marker missing:\n${trace}`);
    const postGatewayStartCommands = trace
      .split("__GATEWAY_START__\n")
      .slice(1)
      .join("__GATEWAY_START__\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const forbiddenPostStartCommands = postGatewayStartCommands.filter(
      (line) =>
        line === "status" ||
        /\bgateway\b.*\binfo\b/.test(line) ||
        /\bdoctor\b.*\blogs\b/.test(line) ||
        /\bgateway\b.*\b(?:destroy|remove)\b/.test(line),
    );
    assert.deepEqual(
      forbiddenPostStartCommands,
      [],
      `forbidden openshell commands ran after Docker-unreachable gateway start:\n${trace}`,
    );
  });
});
