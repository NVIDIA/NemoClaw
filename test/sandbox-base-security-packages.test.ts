// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BASE_APT_SECURITY_FUNCTIONS } from "./helpers/base-apt-security-functions";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOCKERFILE_BASE = path.join(ROOT, "Dockerfile.base");

function dockerRunCommandBetween(
  dockerfile: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = dockerfile.indexOf(startMarker);
  const end = dockerfile.indexOf(endMarker, start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Expected Dockerfile block between ${startMarker} and ${endMarker}`);
  }
  const runIndex = dockerfile.indexOf("RUN ", start);
  if (runIndex === -1 || runIndex > end) {
    throw new Error(`Expected RUN instruction after ${startMarker}`);
  }
  const runLines: string[] = [];
  for (const line of dockerfile.slice(runIndex, end).split("\n")) {
    runLines.push(line);
    if (!line.trimEnd().endsWith("\\")) {
      break;
    }
  }
  const lastLine = runLines[runLines.length - 1]?.trimEnd() ?? "";
  if (lastLine.endsWith("\\")) {
    throw new Error(`Expected complete RUN instruction before ${endMarker}`);
  }
  return runLines
    .join("\n")
    .trim()
    .replace(/^RUN\s+/, "")
    .replace(/\\\n/g, " ");
}

function runLoggedDockerShell(command: string, tmp: string, functionDefs: string[]) {
  const logPath = path.join(tmp, "calls.log");
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `call_log=${JSON.stringify(logPath)}`,
    ...functionDefs,
    command,
  ].join("\n");
  const scriptPath = path.join(tmp, "run-docker-block.sh");
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  return spawnSync("bash", [scriptPath], {
    encoding: "utf-8",
    timeout: 5000,
  });
}

describe("sandbox base security packages", () => {
  it("rejects a sandbox security package when its expected checksum changes", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE_BASE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-base-checksum-"));
    const untouchedTail = path.join(tmp, "untouched-python-link");
    const command = dockerRunCommandBetween(
      dockerfile,
      "ENV DEBIAN_FRONTEND=noninteractive",
      "# gosu for privilege separation",
    )
      .replace("df928e3a8e4da79408d4b18e8cd80a03dffa90130d0698e50041aab5e14f9397", "0".repeat(64))
      .replaceAll("/var/lib/apt/lists", tmp)
      .replaceAll("/tmp/nemoclaw-debian-security", path.join(tmp, "security-debs"))
      .replaceAll("/usr/local/bin/python", untouchedTail)
      .replaceAll("/usr/bin/python3", path.join(tmp, "python3"));

    try {
      const result = runLoggedDockerShell(command, tmp, [
        'apt-get() { printf "apt-get %s\\n" "$*" >> "$call_log"; }',
        ...BASE_APT_SECURITY_FUNCTIONS,
      ]);
      expect(result.status).not.toBe(0);
      expect(fs.existsSync(untouchedTail)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
