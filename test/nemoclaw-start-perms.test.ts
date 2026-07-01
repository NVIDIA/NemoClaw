// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");
const startSource = fs.readFileSync(START_SCRIPT, "utf-8");

function extractShellFunction(name: string): string {
  const match = startSource.match(new RegExp(`${name}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
  if (!match) {
    throw new Error(`Expected ${name} in scripts/nemoclaw-start.sh`);
  }
  return `${name}() {${match[1]}\n}`;
}

function runBash(script: string) {
  return spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    timeout: 10_000,
  });
}

function mode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o7777;
}

const oneShotFunction = extractShellFunction("run_oneshot_command");

describe("nemoclaw-start one-shot command lifecycle", () => {
  it("restores a real mutable config tree and preserves child exit status (#6047)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-oneshot-perms-"));
    const configDir = path.join(root, ".openclaw");
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, "openclaw.json"), "{}\n");
    fs.writeFileSync(path.join(configDir, ".config-hash"), "hash\n");

    const normalizeFunction = extractShellFunction("normalize_mutable_config_perms").replace(
      'local config_dir="/sandbox/.openclaw"',
      `local config_dir=${JSON.stringify(configDir)}`,
    );
    const script = [
      "set -euo pipefail",
      "lock_openclaw_config_baseline_if_present() { return 0; }",
      normalizeFunction,
      oneShotFunction,
      "rc=0",
      `run_oneshot_command bash -c 'chmod 700 "$1"; chmod 600 "$1/openclaw.json" "$1/.config-hash"; exit 42' bash ${JSON.stringify(configDir)} || rc=$?`,
      'printf "rc=%s\\n" "$rc"',
    ].join("\n");

    try {
      const result = runBash(script);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("rc=42");
      expect(mode(configDir)).toBe(0o2770);
      expect(mode(path.join(configDir, "openclaw.json"))).toBe(0o660);
      expect(mode(path.join(configDir, ".config-hash"))).toBe(0o660);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("forwards TERM and INT to the direct child, reaps it, and still runs cleanup (#6047)", () => {
    for (const signal of ["TERM", "INT"] as const) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-oneshot-signal-"));
      const childScript = path.join(root, "child.sh");
      const childPidFile = path.join(root, "child.pid");
      const signalMarker = path.join(root, "signal.marker");
      const cleanupMarker = path.join(root, "cleanup.marker");
      fs.writeFileSync(
        childScript,
        [
          "#!/usr/bin/env bash",
          'pid_file="$1"',
          'signal_marker="$2"',
          'signal="$3"',
          'trap \'printf "%s\\n" "$signal" >"$signal_marker"; exit 23\' "$signal"',
          'printf "%s\\n" "$$" >"$pid_file"',
          "while :; do sleep 0.05; done",
        ].join("\n"),
        { mode: 0o700 },
      );
      const script = [
        "set -euo pipefail",
        `normalize_mutable_config_perms() { printf 'cleanup\\n' >${JSON.stringify(cleanupMarker)}; }`,
        oneShotFunction,
        "rc=0",
        `run_oneshot_command bash ${JSON.stringify(childScript)} ${JSON.stringify(childPidFile)} ${JSON.stringify(signalMarker)} ${signal} &`,
        "runner_pid=$!",
        `for _ in {1..100}; do [ -s ${JSON.stringify(childPidFile)} ] && break; sleep 0.02; done`,
        `[ -s ${JSON.stringify(childPidFile)} ] || { kill -KILL "$runner_pid" 2>/dev/null || true; exit 90; }`,
        `kill -${signal} "$runner_pid"`,
        'wait "$runner_pid" || rc=$?',
        `child_pid="$(cat ${JSON.stringify(childPidFile)})"`,
        'orphan=0; kill -0 "$child_pid" 2>/dev/null && orphan=1',
        'printf "rc=%s orphan=%s\\n" "$rc" "$orphan"',
      ].join("\n");

      try {
        const result = runBash(script);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("rc=23 orphan=0");
        expect(fs.readFileSync(signalMarker, "utf-8")).toBe(`${signal}\n`);
        expect(fs.readFileSync(cleanupMarker, "utf-8")).toBe("cleanup\n");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("returns cleanup failure and reports both statuses (#6047)", () => {
    const script = [
      "set -euo pipefail",
      "normalize_mutable_config_perms() { return 17; }",
      oneShotFunction,
      "rc=0",
      "run_oneshot_command bash -c 'exit 42' || rc=$?",
      'printf "rc=%s\\n" "$rc"',
    ].join("\n");

    const result = runBash(script);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("rc=17");
    expect(result.stderr).toContain(
      "[one-shot] command status=42; permission cleanup status=17; returning cleanup failure",
    );
  });
});
