// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");
const NORMALIZER_SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "lib",
  "normalize_mutable_config_perms.py",
);
const startSource = fs.readFileSync(START_SCRIPT, "utf-8");
const normalizerSource = fs.readFileSync(NORMALIZER_SCRIPT, "utf-8");

function extractShellFunction(name: string): string {
  const match = startSource.match(new RegExp(`${name}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
  const body =
    match?.[1] ??
    (() => {
      throw new Error(`Expected ${name} in scripts/nemoclaw-start.sh`);
    })();
  return `${name}() {${body}\n}`;
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

  it("refuses a child-planted config symlink without chmodding its target (#6047)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-oneshot-symlink-"));
    const configDir = path.join(root, ".openclaw");
    const protectedTarget = path.join(root, "protected-target");
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, "openclaw.json"), "{}\n");
    fs.writeFileSync(path.join(configDir, ".config-hash"), "hash\n");
    fs.writeFileSync(protectedTarget, "protected\n", { mode: 0o640 });
    const initialProtectedMode = mode(protectedTarget);

    const normalizeFunction = extractShellFunction("normalize_mutable_config_perms").replace(
      'local config_dir="/sandbox/.openclaw"',
      `local config_dir=${JSON.stringify(configDir)}`,
    );
    const script = [
      "set -euo pipefail",
      normalizeFunction,
      oneShotFunction,
      "rc=0",
      `run_oneshot_command bash -c 'rm "$1/openclaw.json"; ln -s "$2" "$1/openclaw.json"; exit 42' bash ${JSON.stringify(configDir)} ${JSON.stringify(protectedTarget)} || rc=$?`,
      'printf "rc=%s\\n" "$rc"',
    ].join("\n");

    try {
      const result = runBash(script);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("rc=1");
      expect(result.stderr).toContain(
        "Refusing mutable config permission normalization — descriptor-safe repair detected an unsafe link, race, owner, or metadata state",
      );
      expect(result.stderr).toContain(
        "[one-shot] command status=42; permission cleanup status=1; returning cleanup failure",
      );
      expect(mode(protectedTarget)).toBe(initialProtectedMode);
      expect(fs.lstatSync(path.join(configDir, "openclaw.json")).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked config directory without following a non-directory target (#6047)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-config-dir-symlink-"));
    const configDir = path.join(root, ".openclaw");
    const protectedTarget = path.join(root, "protected-target");
    fs.writeFileSync(protectedTarget, "protected\n", { mode: 0o640 });
    const initialProtectedMode = mode(protectedTarget);
    fs.symlinkSync(protectedTarget, configDir);

    const normalizeFunction = extractShellFunction("normalize_mutable_config_perms").replace(
      'local config_dir="/sandbox/.openclaw"',
      `local config_dir=${JSON.stringify(configDir)}`,
    );
    const script = [
      "set -euo pipefail",
      normalizeFunction,
      "rc=0",
      "normalize_mutable_config_perms || rc=$?",
      'printf "rc=%s\\n" "$rc"',
    ].join("\n");

    try {
      const result = runBash(script);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("rc=1");
      expect(result.stderr).toContain(
        "Refusing mutable config permission normalization — descriptor-safe classification failed",
      );
      expect(mode(protectedTarget)).toBe(initialProtectedMode);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a config replacement while the owner descriptor remains pinned (#6047)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-config-dir-phase-race-"));
    const configDir = path.join(root, ".openclaw");
    const normalizedDir = path.join(root, ".openclaw-normalized");
    const normalizerPath = path.join(root, "normalize-mutable-config.py");
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, "openclaw.json"), "{}\n");
    fs.writeFileSync(path.join(configDir, ".config-hash"), "hash\n");
    fs.chmodSync(configDir, 0o700);
    fs.chmodSync(path.join(configDir, "openclaw.json"), 0o600);

    const injectedNormalizer = normalizerSource.replace(
      "        return root_fd, capture_source_fd\n",
      [
        `        os.rename(config_dir, ${JSON.stringify(normalizedDir)})`,
        "        os.mkdir(config_dir, 0o700)",
        '        with open(os.path.join(config_dir, "openclaw.json"), "w", encoding="utf-8") as config_file:',
        '            config_file.write("{}\\n")',
        '        with open(os.path.join(config_dir, ".config-hash"), "w", encoding="utf-8") as hash_file:',
        '            hash_file.write("hash\\n")',
        '        os.chmod(os.path.join(config_dir, "openclaw.json"), 0o600)',
        '        os.chmod(os.path.join(config_dir, ".config-hash"), 0o600)',
        "        return root_fd, capture_source_fd",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(normalizerPath, injectedNormalizer);
    const normalizeFunction = extractShellFunction("normalize_mutable_config_perms").replace(
      'local config_dir="/sandbox/.openclaw"',
      `local config_dir=${JSON.stringify(configDir)}`,
    );
    const script = [
      "set -euo pipefail",
      `export NEMOCLAW_MUTABLE_CONFIG_NORMALIZER=${JSON.stringify(normalizerPath)}`,
      normalizeFunction,
      "rc=0",
      "normalize_mutable_config_perms || rc=$?",
      'printf "rc=%s\\n" "$rc"',
    ].join("\n");

    try {
      const result = runBash(script);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("rc=1");
      expect(result.stderr).toContain(
        "Refusing mutable config permission normalization — descriptor-safe repair detected an unsafe link, race, owner, or metadata state",
      );
      expect(mode(normalizedDir)).toBe(0o2770);
      expect(mode(configDir)).toBe(0o700);
      expect(mode(path.join(configDir, "openclaw.json"))).toBe(0o600);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("never chmods a protected target during background symlink swaps (#6047)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-oneshot-race-"));
    const configDir = path.join(root, ".openclaw");
    const racePath = path.join(configDir, "race-file");
    const protectedTarget = path.join(root, "protected-target");
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, "openclaw.json"), "{}\n");
    fs.writeFileSync(path.join(configDir, ".config-hash"), "hash\n");
    fs.writeFileSync(racePath, "mutable\n");
    fs.writeFileSync(protectedTarget, "protected\n", { mode: 0o640 });
    const initialProtectedMode = mode(protectedTarget);
    for (let index = 0; index < 300; index++) {
      fs.writeFileSync(path.join(configDir, `filler-${index}`), "x\n");
    }

    const normalizeFunction = extractShellFunction("normalize_mutable_config_perms").replace(
      'local config_dir="/sandbox/.openclaw"',
      `local config_dir=${JSON.stringify(configDir)}`,
    );
    const script = [
      "set -euo pipefail",
      normalizeFunction,
      oneShotFunction,
      "rc=0",
      "run_oneshot_command bash -c 'exit 42' || rc=$?",
      'printf "rc=%s\\n" "$rc"',
    ].join("\n");
    const mutator = spawn(
      process.execPath,
      [
        "-e",
        [
          'const fs = require("node:fs");',
          "const [racePath, target] = process.argv.slice(1);",
          "for (;;) {",
          "  try { fs.unlinkSync(racePath); } catch {}",
          '  fs.writeFileSync(racePath, "mutable\\n");',
          "  fs.unlinkSync(racePath);",
          "  fs.symlinkSync(target, racePath);",
          "}",
        ].join("\n"),
        racePath,
        protectedTarget,
      ],
      { stdio: "ignore" },
    );
    const stopped = new Promise<void>((resolve) => mutator.once("close", () => resolve()));

    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const result = runBash(script);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/rc=(?:1|42)/);
      expect(mode(protectedTarget)).toBe(initialProtectedMode);
    } finally {
      mutator.kill("SIGKILL");
      await stopped;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
