// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BASE_APT_SECURITY_FUNCTIONS,
  dockerRunCommandBetween,
  runLoggedDockerShell,
} from "./helpers/base-apt-security-functions";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOCKERFILE_BASE = path.join(ROOT, "Dockerfile.base");

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
