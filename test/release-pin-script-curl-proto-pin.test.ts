// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const DOCKER_PIN_SCRIPT = path.join(REPO_ROOT, "scripts", "update-docker-pin.sh");
const FAKE_DIGEST = `sha256:${"a".repeat(64)}`;

function writeExecutable(file: string, body: string) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

describe("release-pin update scripts pin curl to HTTPS (#9979)", () => {
  it("passes --proto/--proto-redir on every curl call update-docker-pin.sh makes", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-pin-"));
    const fixtureScript = path.join(tmp, "scripts", "update-docker-pin.sh");
    const fakeBin = path.join(tmp, "bin");
    const curlLog = path.join(tmp, "curl-argv.log");
    fs.mkdirSync(path.dirname(fixtureScript), { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.copyFileSync(DOCKER_PIN_SCRIPT, fixtureScript);
    fs.chmodSync(fixtureScript, 0o755);
    fs.writeFileSync(
      path.join(tmp, "Dockerfile"),
      `FROM node:22-trixie-slim@sha256:${"0".repeat(64)}\n`,
    );
    writeExecutable(
      path.join(fakeBin, "curl"),
      [
        "#!/usr/bin/env bash",
        'printf \'%s\\n\' "$*" >> "$FAKE_CURL_LOG"',
        'if [[ "$*" == *auth.docker.io* ]]; then',
        '  echo \'{"token":"faketoken"}\'',
        'elif [[ "$*" == *registry-1.docker.io* ]]; then',
        "  printf 'HTTP/1.1 200 OK\\r\\nDocker-Content-Digest: %s\\r\\n\\r\\n' ",
        `    ${JSON.stringify(FAKE_DIGEST)}`,
        "fi",
      ].join("\n"),
    );

    const result = spawnSync("bash", [fixtureScript, "--check"], {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, FAKE_CURL_LOG: curlLog },
      encoding: "utf-8",
    });

    const curlArgv = fs.readFileSync(curlLog, "utf-8").trim();
    const curlCallCount = curlArgv.split("\n").length;
    const pinnedCallCount = curlArgv.split("--proto =https --proto-redir =https").length - 1;
    expect(curlArgv, result.stdout + result.stderr).not.toBe("");
    expect(pinnedCallCount).toBe(curlCallCount);
  });
});
