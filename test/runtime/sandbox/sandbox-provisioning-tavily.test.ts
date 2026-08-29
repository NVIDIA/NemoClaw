// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  dockerRunCommandBetween,
  type LoggedDockerShellResult,
  runLoggedDockerShell,
} from "../../helpers/dockerfile-run-shell";

const DOCKERFILE = path.join(import.meta.dirname, "..", "../..", "Dockerfile");

function runPluginInstallBlock(
  functionDefinition: string,
  env: Record<string, string>,
): LoggedDockerShellResult {
  const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
  const command = dockerRunCommandBetween(
    dockerfile,
    "# Install non-messaging OpenClaw plugins",
    "# The reviewed cache stays root-owned and immutable to the sandbox user.",
  );
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tavily-plugin-"));

  try {
    return runLoggedDockerShell(command, tmp, [functionDefinition], { env });
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
