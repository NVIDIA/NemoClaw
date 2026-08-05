// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SCRIPT_PATH = path.join(import.meta.dirname, "..", "scripts", "jetson-nvmap-poc.sh");

describe("Jetson nvmap boundary proof", () => {
  it("reaches the final verdict and exits nonzero when a required boundary fails (#7610)", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "nemoclaw-jetson-nvmap-poc-"));

    try {
      const stubDir = path.join(tempDir, "bin");
      const commandLog = path.join(tempDir, "commands.log");
      mkdirSync(stubDir);
      writeFileSync(commandLog, "");

      const dockerStub = path.join(stubDir, "docker");
      writeFileSync(
        dockerStub,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          `printf 'docker %s\\n' "$*" >> ${JSON.stringify(commandLog)}`,
          'case "${1:-}" in',
          "  ps) echo container-123 ;;&",
          "  inspect) echo sha256:image-123 ;;&",
          "  exec) exit 0 ;;&",
          "esac",
          "",
        ].join("\n"),
      );
      chmodSync(dockerStub, 0o755);

      const openshellStub = path.join(stubDir, "openshell");
      writeFileSync(
        openshellStub,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          `printf 'openshell %s\\n' "$*" >> ${JSON.stringify(commandLog)}`,
          "exit 0",
          "",
        ].join("\n"),
      );
      chmodSync(openshellStub, 0o755);

      const statStub = path.join(stubDir, "stat");
      writeFileSync(
        statStub,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'if [[ "$*" == *"%a"* && "$*" != *"type="* ]]; then',
          "  echo 660",
          "else",
          "  echo 'type=character special file mode=660 uid=0 gid=44 group=video path=/dev/nvmap'",
          "fi",
          "",
        ].join("\n"),
      );
      chmodSync(statStub, 0o755);

      const result = spawnSync("bash", [SCRIPT_PATH, "test-sandbox"], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ""}` },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain("readonly variable");
      expect(result.stdout).toContain("sandbox=test-sandbox");
      expect(result.stdout).toContain("image=sha256:image-123");
      expect(result.stdout).toContain("FAIL boundary=docker-runtime-or-bootstrap");
      expect(result.stdout).toContain("evidence host=0 isolated=1");
      expect(readFileSync(commandLog, "utf8")).toContain("docker exec --user sandbox");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
