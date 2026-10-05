// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
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
    "USER root\nCOPY src/lib/messaging/ /src/lib/messaging/",
  );
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tavily-plugin-"));

  try {
    const archive = "reviewed Tavily plugin fixture";
    fs.writeFileSync(path.join(tmp, "tavily-plugin-2026.9.2.tgz"), archive);
    const outcome = runLoggedDockerShell(
      command.replace(
        "export NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR=/opt/nemoclaw-reviewed-npm-archives;",
        'export NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR="$TAVILY_TEST_ARCHIVE_DIR";',
      ),
      tmp,
      [functionDefinition],
      {
        env: {
          ...env,
          TAVILY_TEST_ARCHIVE_DIR: tmp,
          OPENCLAW_TAVILY_PLUGIN_2026_9_2_INTEGRITY: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
        },
      },
    );
    return { ...outcome, calls: outcome.calls.replaceAll(tmp, "/test-archives") };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const TAVILY_BUILD_ENV = {
  NEMOCLAW_OPENCLAW_OTEL: "0",
  NEMOCLAW_WEB_SEARCH_ENABLED: "1",
  NEMOCLAW_WEB_SEARCH_PROVIDER: "tavily",
  NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "0",
  OPENCLAW_VERSION: "2026.9.2",
  TAVILY_API_KEY: "",
  NODE_OPTIONS: "",
};

describe("sandbox provisioning: reviewed OpenClaw Tavily plugin", () => {
  it("installs the reviewed archive and preserves its placeholder during doctor", () => {
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
      "plugins install --force --accept-capabilities npm-pack:/test-archives/tavily-plugin-2026.9.2.tgz|TAVILY_API_KEY=",
      "doctor --fix --non-interactive|TAVILY_API_KEY=openshell:resolve:env:TAVILY_API_KEY",
    ]);
  });

  it("stops before doctor when native plugin installation fails", () => {
    const { result, calls } = runPluginInstallBlock(
      ["openclaw() {", '  printf "%s\\n" "$*" >> "$call_log"', "  return 41", "}"].join("\n"),
      TAVILY_BUILD_ENV,
    );

    expect(result.status).toBe(41);
    expect(calls.trim()).toBe(
      "plugins install --force --accept-capabilities npm-pack:/test-archives/tavily-plugin-2026.9.2.tgz",
    );
  });
});
