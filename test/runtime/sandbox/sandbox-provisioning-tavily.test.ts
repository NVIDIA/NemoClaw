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

import {
  prepareOfficialPluginBuildFixture,
  writeReviewedNpmFixture,
} from "../../helpers/reviewed-npm-fixture";

const DOCKERFILE = path.join(import.meta.dirname, "..", "../..", "Dockerfile");

function runPluginInstallBlock(
  functionDefinition: string,
  env: Record<string, string>,
): LoggedDockerShellResult {
  const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
  const command = dockerRunCommandBetween(
    dockerfile,
    "# Install non-messaging OpenClaw plugins that need to match the runtime.",
    "USER root\nCOPY src/lib/messaging/ /src/lib/messaging/",
  );
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tavily-plugin-"));

  try {
    const archive = "reviewed Tavily plugin fixture";
    fs.writeFileSync(path.join(tmp, "tavily-plugin-2026.10.5.tgz"), archive);
    const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
    const packages = [
      {
        packageSpec: "@openclaw/tavily-plugin@2026.10.5",
        integrity,
        tarballUrl:
          "https://registry.npmjs.org/@openclaw/tavily-plugin/-/tavily-plugin-2026.10.5.tgz",
      },
    ];
    const fixture = prepareOfficialPluginBuildFixture(command, tmp, packages);
    const npmFixture = path.join(tmp, "npm-fixture");
    writeReviewedNpmFixture(npmFixture, path.join(tmp, "npm-calls.log"), packages);
    const outcome = runLoggedDockerShell(
      fixture.command.replace(
        "export NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR=/opt/nemoclaw-reviewed-npm-archives",
        'export NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR="$TAVILY_TEST_ARCHIVE_DIR";',
      ),
      tmp,
      [functionDefinition],
      {
        env: {
          ...env,
          ...fixture.env,
          NEMOCLAW_REVIEWED_NPM_EXECUTABLE: npmFixture,
          TAVILY_TEST_ARCHIVE_DIR: tmp,
          OPENCLAW_TAVILY_PLUGIN_2026_10_5_INTEGRITY: integrity,
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
  OPENCLAW_VERSION: "2026.10.5",
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
      "plugins install --force --accept-capabilities @openclaw/tavily-plugin@2026.10.5|TAVILY_API_KEY=",
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
      "plugins install --force --accept-capabilities @openclaw/tavily-plugin@2026.10.5",
    );
  });
});
