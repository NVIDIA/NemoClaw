// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "vitest";

function writeAlwaysOkCurl(fakeBin: string): void {
  fs.writeFileSync(
    path.join(fakeBin, "curl"),
    `#!/usr/bin/env bash
outfile=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s' '{"id":"ok"}' > "$outfile"
printf '%s' "200"
`,
    { mode: 0o755 },
  );
}

it("warns about arm64 NIM image compatibility when Local NIM is offered on DGX Spark", () => {
  const repoRoot = path.join(import.meta.dirname, "..");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-arm64-nim-warning-"));
  const fakeBin = path.join(tmpDir, "bin");
  const scriptPath = path.join(tmpDir, "arm64-nim-warning-check.js");
  const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
  const credentialsPath = JSON.stringify(
    path.join(repoRoot, "dist", "lib", "credentials", "store.js"),
  );
  const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

  fs.mkdirSync(fakeBin, { recursive: true });
  writeAlwaysOkCurl(fakeBin);
  const script = String.raw`
Object.defineProperty(process, "arch", { value: "arm64", configurable: true });
Object.defineProperty(process, "platform", { value: "linux", configurable: true });

const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

credentials.prompt = async () => "";
credentials.ensureApiKey = async () => {};
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "";
  if (cmd.includes("127.0.0.1:11434")) return "";
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  return "";
};

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim({
      type: "nvidia",
      name: "NVIDIA GB10",
      count: 1,
      totalMemoryMB: 124607,
      perGpuMB: 124607,
      nimCapable: true,
      unifiedMemory: true,
      spark: true,
      platform: "spark",
    });
    originalLog(JSON.stringify({ result, lines }));
  } finally {
    console.log = originalLog;
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
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
      PATH: `${fakeBin}:${process.env.PATH || ""}`,
      NEMOCLAW_EXPERIMENTAL: "1",
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_PROVIDER: "build",
      NVIDIA_INFERENCE_API_KEY: "nvapi-test",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.result.provider, "nvidia-prod");
  assert.equal(payload.result.model, "nvidia/nemotron-3-super-120b-a12b");
  assert.ok(
    payload.lines.some((line: string) =>
      line.includes("Local NVIDIA NIM is experimental on Linux arm64 DGX Spark hosts"),
    ),
  );
  assert.ok(payload.lines.some((line: string) => line.includes("linux/arm64 manifests")));
});
