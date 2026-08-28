// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const CLI_PATH = path.join(REPO_ROOT, "dist", "nemoclaw.js");
const NVIDIA_TEST_SECRET = "nvapi-TEST-NOT-A-REAL-DIAGNOSTIC-KEY";
const GITHUB_TEST_SECRET = "ghp_TEST_NOT_A_REAL_DIAGNOSTIC_TOKEN";

type CliResult = {
  status: number | null;
  output: string;
};

function runCli(args: string[], env: NodeJS.ProcessEnv): CliResult {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env,
    killSignal: "SIGKILL",
    timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function writeExecutable(filePath: string, lines: string[]): void {
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, { mode: 0o755 });
}

function extractedFiles(root: string): string[] {
  const [archiveRoot] = fs.readdirSync(root);
  const archiveRootPath = path.join(root, archiveRoot);
  return fs.readdirSync(archiveRootPath).map((entry) => path.join(archiveRootPath, entry));
}

describe("compiled diagnostics CLI", () => {
  it.each(["dmesg", "log", "nvidia-smi"])(
    "creates a scoped redacted archive and rejects unknown sandboxes without partial output [%s] (#7617)",
    (command) => {
      const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-debug-contract-"));
      const home = path.join(fixtureRoot, "home");
      const bin = path.join(fixtureRoot, "bin");
      const archive = path.join(fixtureRoot, "debug.tar.gz");
      const extractDir = path.join(fixtureRoot, "extracted");
      fs.mkdirSync(path.join(home, ".nemoclaw"), { recursive: true });
      fs.mkdirSync(bin, { recursive: true });
      fs.mkdirSync(extractDir, { recursive: true });
      fs.writeFileSync(
        path.join(home, ".nemoclaw", "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
            },
          },
          defaultSandbox: "alpha",
        }),
        { mode: 0o600 },
      );

      writeExecutable(path.join(bin, "openshell"), [
        "#!/usr/bin/env bash",
        'case "$1 $2" in',
        "  \"sandbox list\") printf 'NAME\\nalpha Ready\\n'; exit 0 ;;",
        '  "sandbox ssh-config") exit 1 ;;',
        "esac",
        `printf 'NVIDIA_INFERENCE_API_KEY=%s\\nGITHUB_TOKEN=%s\\n' ${NVIDIA_TEST_SECRET} ${GITHUB_TEST_SECRET}`,
      ]);
      writeExecutable(path.join(bin, "docker"), [
        "#!/usr/bin/env bash",
        'case "$*" in',
        '  *"--format"*) exit 0 ;;',
        "esac",
        `printf 'container credential %s\\n' ${NVIDIA_TEST_SECRET}`,
      ]);

      writeExecutable(path.join(bin, command), [
        "#!/usr/bin/env bash",
        `printf 'diagnostic credential %s\\n' ${GITHUB_TEST_SECRET}`,
      ]);

      const env = {
        ...process.env,
        HOME: home,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      };

      try {
        const result = runCli(["debug", "--quick", "--sandbox", "alpha", "--output", archive], env);
        expect(result.status, result.output).toBe(0);
        expect(result.output).toContain("Collecting diagnostics for sandbox 'alpha'");
        expect(result.output).not.toContain(NVIDIA_TEST_SECRET);
        expect(result.output).not.toContain(GITHUB_TEST_SECRET);
        expect(fs.statSync(archive).size).toBeGreaterThan(0);

        const extract = spawnSync("tar", ["xzf", archive, "-C", extractDir], {
          encoding: "utf8",
          timeout: 10_000,
        });
        expect(extract.status, `${extract.stdout}${extract.stderr}`).toBe(0);
        const archiveText = extractedFiles(extractDir)
          .map((filePath) => fs.readFileSync(filePath, "utf8"))
          .join("\n");
        expect(archiveText).toContain("<REDACTED>");
        expect(archiveText).not.toContain(NVIDIA_TEST_SECRET);
        expect(archiveText).not.toContain(GITHUB_TEST_SECRET);
        expect(archiveText).not.toMatch(/nvapi-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9_-]{10,}/);

        const unknownArchive = path.join(fixtureRoot, "unknown.tar.gz");
        const unknown = runCli(
          ["debug", "--quick", "--sandbox", "does-not-exist", "--output", unknownArchive],
          env,
        );
        expect(unknown.status).not.toBe(0);
        expect(unknown.output).toContain("does-not-exist");
        expect(unknown.output).toContain("not registered");
        expect(
          fs.readdirSync(fixtureRoot).some((entry) => entry.startsWith("unknown.tar.gz")),
        ).toBe(false);
      } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
