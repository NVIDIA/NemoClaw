// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { writeReviewedNpmFixture } from "./helpers/reviewed-npm-fixture";

const ROOT = path.resolve(import.meta.dirname, "..");
const BRAVE_INTEGRITY =
  "sha512-7Z+GZ/6K6a8LlkTsWVnAZ1hv8EarORzHQvFHD7ekcg033FGJOXYPEZSbvvE3qR9vM+vnoZplNjMZ7vFMRcvQgw==";
const BRAVE_TARBALL =
  "https://registry.npmjs.org/@openclaw/brave-plugin/-/brave-plugin-2026.7.1.tgz";

it("pins Brave web-search and preserves its placeholder during build-time doctor", () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf-8");
  const start = dockerfile.indexOf("# Install non-messaging OpenClaw plugins");
  const command = dockerfile
    .slice(start)
    .split("\nRUN ", 3)[1]
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/\\\s*\n/g, " ")
    .trim();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-brave-plugin-install-"));
  const log = path.join(tmp, "calls.log");
  try {
    const npmFixture = path.join(tmp, "npm-fixture");
    writeReviewedNpmFixture(npmFixture, log, [
      {
        integrity: BRAVE_INTEGRITY,
        packageSpec: "@openclaw/brave-plugin@2026.7.1",
        tarballUrl: BRAVE_TARBALL,
      },
    ]);
    const script = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `call_log=${JSON.stringify(log)}`,
      'openclaw() { printf "%s|BRAVE_API_KEY=%s\\n" "$*" "${BRAVE_API_KEY:-}" >> "$call_log"; }',
      command.replaceAll(
        "/scripts/lib/reviewed-npm-archive.mts",
        path.join(ROOT, "scripts", "lib", "reviewed-npm-archive.mts"),
      ),
    ].join("\n");
    const scriptPath = path.join(tmp, "run.sh");
    fs.writeFileSync(scriptPath, script, { mode: 0o700 });
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      env: {
        ...process.env,
        NEMOCLAW_OPENCLAW_OTEL: "0",
        NEMOCLAW_REVIEWED_NPM_EXECUTABLE: npmFixture,
        NEMOCLAW_WEB_SEARCH_ENABLED: "1",
        NEMOCLAW_WEB_SEARCH_PROVIDER: "brave",
        NODE_OPTIONS: "",
        OPENCLAW_BRAVE_PLUGIN_2026_7_1_INTEGRITY: BRAVE_INTEGRITY,
        OPENCLAW_VERSION: "2026.7.1",
      },
    });
    const calls = fs.readFileSync(log, "utf-8");
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toContain("npm view @openclaw/brave-plugin@2026.7.1 dist.integrity");
    expect(calls).toContain(`npm pack ${BRAVE_TARBALL} --pack-destination`);
    expect(calls).toContain("plugins install npm-pack:");
    expect(calls).toContain(
      "doctor --fix --non-interactive|BRAVE_API_KEY=openshell:resolve:env:BRAVE_API_KEY",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
