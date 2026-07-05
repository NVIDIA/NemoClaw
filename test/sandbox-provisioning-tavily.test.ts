// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DOCKERFILE = path.join(import.meta.dirname, "..", "Dockerfile");

function dockerRunCommandBetween(
  dockerfile: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = dockerfile.indexOf(startMarker);
  const end = dockerfile.indexOf(endMarker, start);
  assert(
    start !== -1 && end !== -1 && end > start,
    `Expected Dockerfile block between ${startMarker} and ${endMarker}`,
  );
  const runIndex = dockerfile.indexOf("RUN ", start);
  assert(runIndex !== -1 && runIndex <= end, `Expected RUN instruction after ${startMarker}`);
  const runLines = dockerfile.slice(runIndex, end).split("\n");
  const finalLine = runLines.findIndex((line) => !line.trimEnd().endsWith("\\"));
  assert(finalLine !== -1, `Expected terminated RUN instruction after ${startMarker}`);
  return runLines
    .slice(0, finalLine + 1)
    .join("\n")
    .trim()
    .replace(/^RUN\s+/, "")
    .replace(/\\\n/g, " ");
}

function runPluginInstallBlock(
  functionDefinition: string,
  env: Record<string, string>,
): { calls: string; result: ReturnType<typeof spawnSync> } {
  const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
  const command = dockerRunCommandBetween(
    dockerfile,
    "# Install non-messaging OpenClaw plugins",
    '# hadolint ignore=DL3059,DL4006\nRUN OPENCLAW_VERSION="${OPENCLAW_VERSION}" node --experimental-strip-types /src/lib/messaging/applier/build/messaging-build-applier.mts --agent openclaw --phase agent-install',
  );
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tavily-plugin-"));
  const logPath = path.join(tmp, "calls.log");
  const scriptPath = path.join(tmp, "run-docker-block.sh");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `call_log=${JSON.stringify(logPath)}`,
      functionDefinition,
      command,
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      env: { ...process.env, ...env },
      timeout: 5000,
    });
    const calls = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
    return { calls, result };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const TAVILY_BUILD_ENV = {
  NEMOCLAW_OPENCLAW_OTEL: "0",
  NEMOCLAW_WEB_SEARCH_ENABLED: "1",
  NEMOCLAW_WEB_SEARCH_PROVIDER: "tavily",
  OPENCLAW_VERSION: "2026.5.27",
};

describe("sandbox provisioning: bundled OpenClaw Tavily extension", () => {
  it("inspects the bundled extension and preserves its placeholder during doctor", () => {
    const { result, calls } = runPluginInstallBlock(
      [
        "openclaw() {",
        '  printf "%s|TAVILY_API_KEY=%s\\n" "$*" "${TAVILY_API_KEY:-}" >> "$call_log"',
        "}",
      ].join("\n"),
      TAVILY_BUILD_ENV,
    );

    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(calls.trim().split("\n")).toEqual([
      "plugins inspect tavily --json|TAVILY_API_KEY=",
      "doctor --fix --non-interactive|TAVILY_API_KEY=openshell:resolve:env:TAVILY_API_KEY",
    ]);
    expect(calls).not.toContain("plugins install");
  });

  it("fails closed when the bundled extension cannot be inspected", () => {
    const { result, calls } = runPluginInstallBlock(
      [
        "openclaw() {",
        '  printf "%s\\n" "$*" >> "$call_log"',
        '  if [ "$*" = "plugins inspect tavily --json" ]; then return 41; fi',
        "}",
      ].join("\n"),
      TAVILY_BUILD_ENV,
    );

    expect(result.status).toBe(41);
    expect(calls.trim()).toBe("plugins inspect tavily --json");
  });
});
