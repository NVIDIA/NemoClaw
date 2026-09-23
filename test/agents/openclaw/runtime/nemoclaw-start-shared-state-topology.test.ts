// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { wrapExecCommandWithRuntimeEnv } from "../../../../src/lib/actions/sandbox/runtime-env";
import { extractShellFunctionFromSource } from "../../../helpers/shell-source";

const START_SCRIPT = path.join(process.cwd(), "scripts", "nemoclaw-start.sh");

function sourceBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start, `Expected ${startMarker} in nemoclaw-start.sh`).toBeGreaterThanOrEqual(0);
  expect(end, `Expected ${endMarker} after ${startMarker} in nemoclaw-start.sh`).toBeGreaterThan(
    start,
  );
  return source.slice(start, end);
}

function runBash(lines: string[], env: NodeJS.ProcessEnv = process.env): SpawnSyncReturns<string> {
  return spawnSync("bash", ["-c", ["set -euo pipefail", ...lines].join("\n")], {
    encoding: "utf-8",
    env,
    timeout: 5000,
  });
}

describe("nemoclaw-start native SQLite topology (#7280)", () => {
  const source = fs.readFileSync(START_SCRIPT, "utf-8");

  it("pins SQLite temporary files inside owner-only OpenClaw state for OpenShell", () => {
    const tmp = fs.mkdtempSync(path.join(process.cwd(), ".tmp-openclaw-sqlite-"));
    const sqliteTmp = path.join(tmp, "state", "tmp");
    const block = sourceBlock(
      source,
      "prepare_openshell_sqlite_tmpdir() {",
      "# ── Main ─────────────────────────────────────────────────────────",
    ).replaceAll("/sandbox/.openclaw/tmp", sqliteTmp);
    fs.mkdirSync(path.dirname(sqliteTmp));
    try {
      const result = runBash([
        'stat() { if [ "${1:-}" = "-c" ] && [ "${2:-}" = "%u" ]; then id -u; else command stat "$@"; fi; }',
        block,
        "prepare_openshell_sqlite_tmpdir",
        'printf "%s\\n" "$SQLITE_TMPDIR"',
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(sqliteTmp);
      expect(fs.statSync(sqliteTmp).mode & 0o777).toBe(0o700);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked SQLite temporary directory", () => {
    const tmp = fs.mkdtempSync(path.join(process.cwd(), ".tmp-openclaw-sqlite-"));
    const outside = path.join(tmp, "outside");
    const sqliteTmp = path.join(tmp, "sqlite-tmp");
    const block = sourceBlock(
      source,
      "prepare_openshell_sqlite_tmpdir() {",
      "# ── Main ─────────────────────────────────────────────────────────",
    ).replaceAll("/sandbox/.openclaw/tmp", sqliteTmp);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, sqliteTmp);
    try {
      const result = runBash([block, "prepare_openshell_sqlite_tmpdir"]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Refusing unsafe OpenClaw SQLite temporary directory");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each(["exec", "connect"])(
    "shares the validated SQLite directory with a fresh %s process",
    (mode) => {
      const tmp = fs.mkdtempSync(path.join(process.cwd(), ".tmp-openclaw-sqlite-env-"));
      const sqliteTmp = path.join(tmp, "state with 'quote", "tmp");
      const envFile = path.join(tmp, "runtime-env.sh");
      const bashrc = path.join(tmp, "bashrc");
      const fixtureEnv: NodeJS.ProcessEnv = {
        ...process.env,
        MEMORY_TEST_SQLITE_DIR: sqliteTmp,
        MEMORY_TEST_RUNTIME_ENV: envFile,
      };
      fs.mkdirSync(path.dirname(sqliteTmp));
      try {
        const writer = runBash(
          [
            "set +u",
            extractShellFunctionFromSource(source, "prepare_openshell_sqlite_tmpdir").replaceAll(
              '"/sandbox/.openclaw/tmp"',
              '"$MEMORY_TEST_SQLITE_DIR"',
            ),
            extractShellFunctionFromSource(source, "write_runtime_shell_env").replaceAll(
              '"/tmp/nemoclaw-proxy-env.sh"',
              '"$MEMORY_TEST_RUNTIME_ENV"',
            ),
            'emit_sandbox_sourced_file() { cat > "$1"; }',
            '_PROXY_URL="http://10.200.0.1:3128"',
            '_NO_PROXY_VAL="localhost,127.0.0.1"',
            "_TOOL_REDIRECTS=()",
            'OPENCLAW_GATEWAY_TOKEN="fixture-gateway-token"',
            "prepare_openshell_sqlite_tmpdir",
            "write_runtime_shell_env",
          ],
          fixtureEnv,
        );
        expect(writer.status, writer.stderr).toBe(0);

        const dockerfile = fs.readFileSync(path.join(process.cwd(), "Dockerfile"), "utf8");
        const interactiveSetup = dockerfile.slice(
          dockerfile.indexOf("&& (chmod 644 /etc/bash.bashrc"),
        );
        const hook =
          interactiveSetup.match(/'(\[ -f \/tmp\/nemoclaw-proxy-env\.sh \][^'\n]*)'/)?.[1] ?? "";
        fs.writeFileSync(
          bashrc,
          hook.replaceAll("/tmp/nemoclaw-proxy-env.sh", '"$MEMORY_TEST_RUNTIME_ENV"') + "\n",
        );

        const probe = [
          "/usr/bin/env",
          "-u",
          "NODE_OPTIONS",
          "node",
          "-e",
          `
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.SQLITE_TMPDIR;
fs.writeFileSync(path.join(dir, "fresh-child.txt"), "temporary data");
console.log(JSON.stringify({ dir, token: process.env.OPENCLAW_GATEWAY_TOKEN ?? null }));
`,
        ];
        const command =
          mode === "exec"
            ? wrapExecCommandWithRuntimeEnv(probe).map((arg) =>
                arg.replaceAll('"/tmp/nemoclaw-proxy-env.sh"', '"$MEMORY_TEST_RUNTIME_ENV"'),
              )
            : [
                "/bin/bash",
                "--noprofile",
                "--rcfile",
                bashrc,
                "-ic",
                'exec "$@"',
                "connect-sqlite-probe",
                ...probe,
              ];
        const childEnv = { ...fixtureEnv };
        delete childEnv.SQLITE_TMPDIR;
        delete childEnv.OPENCLAW_GATEWAY_TOKEN;
        const child = spawnSync("/bin/bash", command.slice(1), {
          encoding: "utf8",
          env: childEnv,
          timeout: 5000,
        });
        expect(child.status, child.stderr).toBe(0);
        expect(JSON.parse(child.stdout)).toEqual({
          dir: sqliteTmp,
          token: mode === "exec" ? null : "fixture-gateway-token",
        });
        expect(fs.statSync(sqliteTmp).mode & 0o777).toBe(0o700);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { initial: "caller-disabled", uid: 0 },
    { initial: "1", uid: 1000 },
  ])("keeps the sandbox client marker unset for uid $uid", ({ initial, uid }) => {
    const block = sourceBlock(
      source,
      "# OpenClaw 2026.9.1 enforces owner-only SQLite",
      "# Begin the root PID 1 readiness lease",
    );
    const result = runBash([
      `id() { if [ "\${1:-}" = "-u" ]; then printf ${JSON.stringify(String(uid))}; else command id "$@"; fi; }`,
      "run_requested_openclaw_backup_quiesce() { :; }",
      "prepare_openshell_sqlite_tmpdir() { :; }",
      `export NEMOCLAW_OPENCLAW_SHARED_STATE=${JSON.stringify(initial)}`,
      block,
      'printf "%s\\n" "${NEMOCLAW_OPENCLAW_SHARED_STATE:-unset}"',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("unset");
  });

  it("keeps retired split-state variables out of connect shells", () => {
    const block = sourceBlock(
      source,
      "    # The native lifecycle uses the sandbox identity for both the gateway and",
      '    if [ -n "${OPENCLAW_GATEWAY_PORT:-}" ]; then',
    );
    const result = runBash([block]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "unset NEMOCLAW_OPENCLAW_SHARED_STATE",
      "unset NEMOCLAW_OPENCLAW_GATEWAY_STATE_DIR",
      "unset NEMOCLAW_OPENCLAW_PAIRING_OBSERVER_DIR",
      "unset NEMOCLAW_OPENCLAW_PAIRING_OBSERVER_UID",
    ]);
  });
});
