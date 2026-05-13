// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";

type ConfigureWebSearchOutcome = {
  result: { fetchEnabled: boolean } | null;
  exitCalls: number[];
  logs: string[];
  warnings: string[];
  errors: string[];
};

function setupBraveCurlShim(
  fakeBin: string,
  spec: { status: string; body: string },
): void {
  fs.mkdirSync(fakeBin, { recursive: true });
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
printf '%s' ${JSON.stringify(spec.body)} > "$outfile"
printf '%s' '${spec.status}'
`,
    { mode: 0o755 },
  );
}

function runConfigureWebSearch(spec: {
  status: string;
  body: string;
  apiKey: string;
}): { exitCode: number; payload: ConfigureWebSearchOutcome; stderr: string } {
  const repoRoot = path.join(import.meta.dirname, "..");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-brave-"));
  const fakeBin = path.join(tmpDir, "bin");
  const scriptPath = path.join(tmpDir, "configure-web-search.js");
  const outputPath = path.join(tmpDir, "outcome.json");
  const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
  const outputPathLiteral = JSON.stringify(outputPath);

  setupBraveCurlShim(fakeBin, { status: spec.status, body: spec.body });

  const script = String.raw`
const fs = require("node:fs");
const { configureWebSearch } = require(${onboardPath});

const exitCalls = [];
const logs = [];
const warnings = [];
const errors = [];
const originalExit = process.exit;
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
process.exit = ((code) => {
  exitCalls.push(typeof code === "number" ? code : 0);
});
console.log = (...args) => logs.push(args.join(" "));
console.warn = (...args) => warnings.push(args.join(" "));
console.error = (...args) => errors.push(args.join(" "));

function restore() {
  process.exit = originalExit;
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
}

(async () => {
  let result = null;
  try {
    result = await configureWebSearch(null);
  } finally {
    restore();
  }
  fs.writeFileSync(${outputPathLiteral}, JSON.stringify({ result, exitCalls, logs, warnings, errors }));
})().catch((error) => {
  restore();
  console.error("UNEXPECTED:", error && error.stack ? error.stack : String(error));
  process.exit(2);
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
      NEMOCLAW_NON_INTERACTIVE: "1",
      BRAVE_API_KEY: spec.apiKey,
    },
  });

  if (!fs.existsSync(outputPath)) {
    throw new Error(
      `Outcome file missing. exit=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  const payload = JSON.parse(fs.readFileSync(outputPath, "utf-8")) as ConfigureWebSearchOutcome;
  return {
    exitCode: typeof result.status === "number" ? result.status : -1,
    payload,
    stderr: result.stderr ?? "",
  };
}

describe("configureWebSearch (non-interactive)", () => {
  it("skips Brave Web Search and returns null when key validation hits HTTP 429", () => {
    const { exitCode, payload } = runConfigureWebSearch({
      status: "429",
      body:
        '{"type":"ErrorResponse","error":{"id":"abc","status":429,' +
        '"detail":"Request rate limit exceeded for plan",' +
        '"meta":{"plan":"Free","rate_limit":1,"rate_current":1}}}',
      apiKey: "fake-rate-limited-key",
    });

    expect(exitCode).toBe(0);
    expect(payload.exitCalls).toEqual([]);
    expect(payload.result).toBeNull();
    expect(payload.errors).toEqual([]);
    expect(
      payload.warnings.some((line) =>
        line.includes("Brave Search API key validation failed"),
      ),
    ).toBe(true);
    expect(
      payload.warnings.some((line) => line.includes("nemoclaw config web-search")),
    ).toBe(true);
  });

  it("enables Brave Web Search when validation succeeds", () => {
    const { exitCode, payload } = runConfigureWebSearch({
      status: "200",
      body: '{"web":{"results":[]}}',
      apiKey: "fake-valid-key",
    });

    expect(exitCode).toBe(0);
    expect(payload.exitCalls).toEqual([]);
    expect(payload.result).toEqual({ fetchEnabled: true });
  });
});
