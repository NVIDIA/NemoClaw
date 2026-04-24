// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SCRIPT_PATH = path.join(import.meta.dirname, "..", "scripts", "setup-jetson.sh");

function extractDaemonJsonPatcher(): string {
  const script = readFileSync(SCRIPT_PATH, "utf-8");
  const match = script.match(/<<'PYEOF'\n([\s\S]*?)\nPYEOF/);
  if (!match) {
    throw new Error("Failed to extract inline daemon.json patcher from scripts/setup-jetson.sh");
  }
  return match[1];
}

function runDaemonJsonPatcher(daemonPath: string): void {
  execFileSync("python3", ["-", daemonPath], {
    input: extractDaemonJsonPatcher(),
    encoding: "utf-8",
  });
}

function getExecErrorOutput(error: Error | string | null | undefined): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const stderr = "stderr" in error ? error.stderr : "";
  if (typeof stderr === "string") {
    return stderr;
  }
  if (Buffer.isBuffer(stderr)) {
    return stderr.toString("utf-8");
  }
  return error.message;
}

describe("setup-jetson daemon.json patcher", () => {
  it("repairs the missing-comma regression and removes iptables and bridge keys", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "nemoclaw-jetson-patcher-"));
    const daemonPath = path.join(tempDir, "daemon.json");

    try {
      writeFileSync(
        daemonPath,
        [
          "{",
          '  "default-runtime": "nvidia"',
          '  "runtimes": {',
          '    "nvidia": {',
          '      "path": "nvidia-container-runtime",',
          '      "runtimeArgs": []',
          "    }",
          "  },",
          '  "iptables": false,',
          '  "bridge": "none"',
          "}",
          "",
        ].join("\n"),
      );
      chmodSync(daemonPath, 0o640);

      runDaemonJsonPatcher(daemonPath);

      const patched = readFileSync(daemonPath, "utf-8");
      const parsed: {
        "default-runtime": string;
        runtimes: {
          nvidia: {
            path: string;
            runtimeArgs: [];
          };
        };
      } = JSON.parse(patched);

      expect(parsed).toEqual({
        "default-runtime": "nvidia",
        runtimes: {
          nvidia: {
            path: "nvidia-container-runtime",
            runtimeArgs: [],
          },
        },
      });
      expect(patched.endsWith("\n")).toBe(true);
      expect(statSync(daemonPath).mode & 0o777).toBe(0o640);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails cleanly for unrecoverable malformed JSON without clobbering the file", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "nemoclaw-jetson-patcher-"));
    const daemonPath = path.join(tempDir, "daemon.json");
    const original = '{"default-runtime": "nvidia",\n';

    try {
      writeFileSync(daemonPath, original);

      expect(() => runDaemonJsonPatcher(daemonPath)).toThrowError(
        /daemon\.json is malformed and could not be repaired automatically/,
      );
      expect(readFileSync(daemonPath, "utf-8")).toBe(original);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects non-object JSON roots before mutating keys", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "nemoclaw-jetson-patcher-"));
    const daemonPath = path.join(tempDir, "daemon.json");

    try {
      writeFileSync(daemonPath, '["not", "an", "object"]\n');

      let output = "";
      try {
        runDaemonJsonPatcher(daemonPath);
      } catch (error) {
        output = getExecErrorOutput(error instanceof Error ? error : String(error));
      }

      expect(output).toContain("daemon.json must contain a top-level JSON object");
      expect(readFileSync(daemonPath, "utf-8")).toBe('["not", "an", "object"]\n');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("creates a new daemon.json with 0644 permissions when the file is missing", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "nemoclaw-jetson-patcher-"));
    const daemonPath = path.join(tempDir, "daemon.json");

    try {
      runDaemonJsonPatcher(daemonPath);

      expect(readFileSync(daemonPath, "utf-8")).toBe("{}\n");
      expect(statSync(daemonPath).mode & 0o777).toBe(0o644);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
