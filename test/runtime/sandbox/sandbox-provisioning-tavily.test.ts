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
const TAVILY_ARCHIVE = "reviewed Tavily plugin fixture";
const TAVILY_INTEGRITY = `sha512-${createHash("sha512").update(TAVILY_ARCHIVE).digest("base64")}`;
const TAVILY_INSTALL_ARGS = `/test-archives/tavily-plugin-2026.9.2.tgz @openclaw/tavily-plugin@2026.9.2 ${TAVILY_INTEGRITY} https://registry.npmjs.org/@openclaw/tavily-plugin/-/tavily-plugin-2026.9.2.tgz`;

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
    fs.writeFileSync(path.join(tmp, "tavily-plugin-2026.9.2.tgz"), TAVILY_ARCHIVE);
    const outcome = runLoggedDockerShell(
      command.replace(
        "export NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR=/opt/nemoclaw-reviewed-npm-archives;",
        'export NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR="$TAVILY_TEST_ARCHIVE_DIR";',
      ),
      tmp,
      [
        'node() { case "$1" in /scripts/lib/install-reviewed-openclaw-plugin.mts) shift; printf "installer %s|TAVILY_API_KEY=%s\\n" "$*" "${TAVILY_API_KEY:-}" >> "$call_log"; return "${TEST_PLUGIN_INSTALL_EXIT_CODE:-0}" ;; *) command node "$@" ;; esac; }',
        functionDefinition,
      ],
      {
        env: {
          ...env,
          TAVILY_TEST_ARCHIVE_DIR: tmp,
          OPENCLAW_TAVILY_PLUGIN_2026_9_2_INTEGRITY: TAVILY_INTEGRITY,
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
      `installer ${TAVILY_INSTALL_ARGS}|TAVILY_API_KEY=`,
      "doctor --fix --non-interactive|TAVILY_API_KEY=openshell:resolve:env:TAVILY_API_KEY",
    ]);
  });

  it("stops before doctor when the reviewed plugin installer fails (#12144)", () => {
    const { result, calls } = runPluginInstallBlock(
      ["openclaw() {", '  printf "%s\\n" "$*" >> "$call_log"', "}"].join("\n"),
      { ...TAVILY_BUILD_ENV, TEST_PLUGIN_INSTALL_EXIT_CODE: "41" },
    );

    expect(result.status).toBe(41);
    expect(calls.trim()).toBe(`installer ${TAVILY_INSTALL_ARGS}|TAVILY_API_KEY=`);
  });
});
