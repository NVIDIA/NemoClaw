// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { superviseChild } from "../../helpers/process-supervisor.ts";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const CHECK_DOCS = path.join(REPO_ROOT, "test", "e2e", "e2e-cloud-experimental", "check-docs.sh");
const PROCESS_OUTPUT_LIMIT_BYTES = 1024 * 1024;

// These three checks own separate fixtures; keep their overlap bounded.
vi.setConfig({ maxConcurrency: 3 });

type AsyncProcessResult = {
  error: Error | undefined;
  signal: NodeJS.Signals | null;
  status: number | null;
  stderr: string;
  stdout: string;
};

function captureProcessOutput(
  current: string,
  chunk: string,
  stream: "stderr" | "stdout",
  command: string,
  controller: AbortController,
): string {
  return Buffer.byteLength(current) + Buffer.byteLength(chunk) <= PROCESS_OUTPUT_LIMIT_BYTES
    ? `${current}${chunk}`
    : (controller.abort(
        new Error(`${command} ${stream} exceeded ${PROCESS_OUTPUT_LIMIT_BYTES} bytes`),
      ),
      current);
}

function runProcessGroup(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
    timeoutMs: number;
  },
): Promise<AsyncProcessResult> {
  const outputAbort = new AbortController();
  let stderr = "";
  let stdout = "";
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    detached: true,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return superviseChild(child, {
    killGraceMs: 0,
    onStderr: (chunk) => {
      stderr = captureProcessOutput(stderr, chunk, "stderr", command, outputAbort);
    },
    onStdout: (chunk) => {
      stdout = captureProcessOutput(stdout, chunk, "stdout", command, outputAbort);
    },
    signal: AbortSignal.any([options.signal, outputAbort.signal]),
    timeoutMs: options.timeoutMs,
  }).then((result) => ({
    error:
      result.spawnError ??
      (result.timedOut
        ? new Error(`${command} timed out after ${options.timeoutMs}ms`)
        : outputAbort.signal.reason instanceof Error
          ? outputAbort.signal.reason
          : undefined),
    signal: result.signal,
    status: result.exitCode,
    stderr,
    stdout,
  }));
}

type CliParityFixture = {
  binDir: string;
  nodeInvocationLog: string;
  nodeShim: string;
  root: string;
};

function createCliParityFixture(): CliParityFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docs-cli-parity-"));
  const binDir = path.join(root, "bin");
  const shim = path.join(binDir, "nemoclaw");
  const nodeShim = path.join(binDir, "node");
  const nodeInvocationLog = path.join(root, "node-invocations.log");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    shim,
    `#!/usr/bin/env bash
exec "$NEMOCLAW_TEST_NODE" "$NEMOCLAW_TEST_CLI_ENTRYPOINT" "$@"
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    nodeShim,
    `#!/usr/bin/env bash
set -o pipefail

_entrypoint="$1"
shift

case "\${1:-}" in
  --dump-commands) _invocation="dump-commands" ;;
  --dump-command-flags) _invocation="dump-command-flags" ;;
  *) _invocation="custom-help" ;;
esac
{
  printf '%s' "$_invocation"
  printf '\\t%s' "$@"
  printf '\\n'
} >>"$NEMOCLAW_TEST_INVOCATION_LOG"

if [[ "\${1:-}" == "--dump-command-flags" && "\${NEMOCLAW_TEST_EMPTY_AGENT_METADATA:-0}" == "1" ]]; then
  "$NEMOCLAW_TEST_NODE" "$_entrypoint" "$@" | LC_ALL=C awk -F '\\t' 'BEGIN { OFS = "\\t" } $1 == "nemoclaw <name> agent" { $3 = ""; print; next } { print }'
  exit $?
fi

if [[ "\${NEMOCLAW_TEST_ADD_AGENT_HELP_FLAG:-0}" == "1" && "$_invocation" == "custom-help" ]]; then
  if [[ "$#" -eq 3 && "$1" == "placeholder-sandbox" && "$2" == "agent" && "$3" == "--help" ]]; then
    printf '  Usage: nemoclaw <name> agent --synthetic-undocumented\\n'
  fi
  exit 0
fi

exec "$NEMOCLAW_TEST_NODE" "$_entrypoint" "$@"
`,
    { mode: 0o755 },
  );
  return { binDir, nodeInvocationLog, nodeShim, root };
}

function runCliParityAsync(
  fixture: CliParityFixture,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = {},
) {
  return runProcessGroup("bash", [CHECK_DOCS, "--only-cli"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CHECK_DOC_LINKS_REMOTE: "0",
      HOME: fixture.root,
      NEMOCLAW_TEST_CLI_ENTRYPOINT: CLI_ENTRYPOINT,
      NEMOCLAW_TEST_INVOCATION_LOG: fixture.nodeInvocationLog,
      NEMOCLAW_TEST_NODE: process.execPath,
      NODE: fixture.nodeShim,
      PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      TMPDIR: fixture.root,
      ...env,
    },
    signal,
    timeoutMs: 120_000,
  });
}

function createInstallParityFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docs-install-parity-"));
  for (const relativeFile of [
    "install.sh",
    "scripts/install.sh",
    "src/lib/onboard/inference-providers/provider-selection-keys.ts",
    "docs/reference/commands.mdx",
    "test/e2e/e2e-cloud-experimental/check-docs.sh",
  ]) {
    const destination = path.join(root, relativeFile);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, relativeFile), destination);
  }
  return {
    checkDocs: path.join(root, "test", "e2e", "e2e-cloud-experimental", "check-docs.sh"),
    root,
  };
}

function runInstallParity(fixture: ReturnType<typeof createInstallParityFixture>) {
  return spawnSync("bash", [fixture.checkDocs, "--only-install"], {
    cwd: fixture.root,
    encoding: "utf-8",
    env: { ...process.env, NODE: process.execPath },
    killSignal: "SIGKILL",
    timeout: 30_000,
  });
}

function readCliInvocations(fixture: CliParityFixture): string[] {
  return fs.readFileSync(fixture.nodeInvocationLog, "utf-8").trim().split("\n");
}

describe("public compiled CLI contracts", () => {
  it(
    "prints the public NemoClaw version prefix (#7616)",
    {
      timeout: 35_000,
    },
    () => {
      const result = spawnSync(process.execPath, [CLI_ENTRYPOINT, "--version"], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        // Version output is independent of persisted automatic gateway-port discovery.
        env: { ...process.env, NEMOCLAW_GATEWAY_PORT: "8080" },
        timeout: 30_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/^nemoclaw v/);
    },
  );

  it.concurrent(
    "keeps compiled CLI commands aligned with their documentation headings (#7616)",
    {
      timeout: 150_000,
    },
    async ({ expect, signal }) => {
      // `npm run test:package` builds the CLI before this project. Empty one
      // custom-help metadata row to prove its code-owned classification still
      // selects rendered help without returning to one start per command.
      const fixture = createCliParityFixture();

      try {
        const result = await runCliParityAsync(fixture, signal, {
          NEMOCLAW_TEST_EMPTY_AGENT_METADATA: "1",
        });

        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("check-docs: running: [cli]");
        expect(result.stdout).toContain("command-level parity OK");
        expect(result.stdout).toContain("flag-level parity OK");
        expect(readCliInvocations(fixture)).toEqual([
          "dump-commands\t--dump-commands",
          "dump-command-flags\t--dump-command-flags",
          "custom-help\tplaceholder-sandbox\tagent\t--help",
          "custom-help\tplaceholder-sandbox\tagents\tadd\t--help",
          "custom-help\tplaceholder-sandbox\tagents\tapply\t--help",
          "custom-help\tplaceholder-sandbox\tagents\tdelete\t--help",
          "custom-help\tplaceholder-sandbox\tagents\tlist\t--help",
          "custom-help\tplaceholder-sandbox\tmcp\tadd\t--help",
          "custom-help\tplaceholder-sandbox\tmcp\tlist\t--help",
          "custom-help\tplaceholder-sandbox\tmcp\tremove\t--help",
          "custom-help\tplaceholder-sandbox\tmcp\trestart\t--help",
          "custom-help\tplaceholder-sandbox\tmcp\tstatus\t--help",
          "custom-help\tplaceholder-sandbox\tmcp\tupdate\t--help",
          "custom-help\tplaceholder-sandbox\tsessions\t--help",
          "custom-help\tplaceholder-sandbox\tsessions\tlist\t--help",
          "custom-help\tplaceholder-sandbox\tskill\tlist\t--help",
          "custom-help\tuninstall\t--help",
          "custom-help\tinternal\tuninstall\trun-plan\t--help",
        ]);
      } finally {
        fs.rmSync(fixture.root, { force: true, recursive: true });
      }
    },
  );

  it.concurrent(
    "validates every repository-local documentation link (#7616)",
    {
      timeout: 150_000,
    },
    async ({ expect, signal }) => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docs-link-parity-"));

      try {
        const result = await runProcessGroup("bash", [CHECK_DOCS, "--only-links", "--local-only"], {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            CHECK_DOC_LINKS_REMOTE: "0",
            TMPDIR: tempRoot,
          },
          signal,
          timeoutMs: 120_000,
        });

        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("check-docs: running: [links]");
        expect(result.stdout).toContain("remote: skipped (local paths only)");
        expect(result.stdout).toContain("phase 2/2: skipped");
      } finally {
        fs.rmSync(tempRoot, { force: true, recursive: true });
      }
    },
  );

  it.concurrent(
    "rejects an undocumented flag from custom rendered help (#7616)",
    {
      timeout: 150_000,
    },
    async ({ expect, signal }) => {
      const fixture = createCliParityFixture();

      try {
        const result = await runCliParityAsync(fixture, signal, {
          NEMOCLAW_TEST_ADD_AGENT_HELP_FLAG: "1",
        });

        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("flag --synthetic-undocumented");
        expect(result.stderr).toContain("not in 'nemoclaw <name> agent' section");
        expect(readCliInvocations(fixture)).toContain(
          "custom-help\tplaceholder-sandbox\tagent\t--help",
        );
      } finally {
        fs.rmSync(fixture.root, { force: true, recursive: true });
      }
    },
  );

  it("keeps installer provider help aligned with its shared owner (#11041)", () => {
    const fixture = createInstallParityFixture();

    try {
      const result = runInstallParity(fixture);
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("check-docs: running: [install]");
      expect(result.stdout).toContain("[install] parity OK");
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects a canonical provider missing from installer help (#11041)", () => {
    const fixture = createInstallParityFixture();
    const bootstrap = path.join(fixture.root, "install.sh");
    const source = fs.readFileSync(bootstrap, "utf-8");
    fs.writeFileSync(bootstrap, source.replace("| gemini |", "|"));

    try {
      const result = runInstallParity(fixture);
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('provider "gemini" canonical but absent');
      expect(result.stderr).toContain("install.sh bootstrap_usage");
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });
});
