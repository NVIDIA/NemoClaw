// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const HERMES_DOCKERFILE_BASE = path.join(ROOT, "agents", "hermes", "Dockerfile.base");

function extractAptInstallCommand(dockerfile: string): string {
  const match = dockerfile.match(
    /RUN\s+apt-get update\s*&&\s*apt-get install -y --no-install-recommends[\s\S]*?&&\s*rm -rf \/var\/lib\/apt\/lists\/\*/m,
  );
  expect(match).not.toBeNull();
  return match![0].replace(/^RUN\s+/, "").replace(/\\\n/g, " ");
}

function runLoggedShell(command: string, tmp: string) {
  const logPath = path.join(tmp, "calls.log");
  const scriptPath = path.join(tmp, "run-hermes-apt-layer.sh");
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `call_log=${JSON.stringify(logPath)}`,
    'apt-get() { printf "apt-get %s\\n" "$*" >> "$call_log"; }',
    command,
  ].join("\n");
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
  const calls = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
  return { result, calls };
}

describe("Hermes share mount package parity (#2947)", () => {
  it("requests gnupg, procps, and openssh-sftp-server from the Hermes base apt layer", () => {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE_BASE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-share-apt-"));
    const lists = path.join(tmp, "apt-lists");
    fs.mkdirSync(lists);

    try {
      const command = extractAptInstallCommand(dockerfile).replaceAll(
        "/var/lib/apt/lists",
        lists,
      );
      const { result, calls } = runLoggedShell(command, tmp);

      expect(result.status).toBe(0);
      expect(calls).toContain("apt-get update");
      expect(calls).toContain("gnupg=2.2.40-1.1+deb12u2");
      expect(calls).toContain("procps=2:4.0.2-3");
      expect(calls).toContain("openssh-sftp-server=1:9.2p1-2+deb12u9");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
