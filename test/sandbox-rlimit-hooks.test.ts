// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOCKERFILE = path.join(ROOT, "Dockerfile");
const DOCKERFILE_BASE = path.join(ROOT, "Dockerfile.base");
const HERMES_DOCKERFILE = path.join(ROOT, "agents", "hermes", "Dockerfile");
const SANDBOX_RLIMITS = path.join(ROOT, "scripts", "lib", "sandbox-rlimits.sh");
const FORK_STORM_NPROC_LIMIT = 128;
const FORK_STORM_SAFETY_CAP = FORK_STORM_NPROC_LIMIT * 2;

function dockerRunCommandBetween(
  dockerfile: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = dockerfile.indexOf(startMarker);
  const end = dockerfile.indexOf(endMarker, start);
  expect(start, `Expected Dockerfile block start marker ${startMarker}`).not.toBe(-1);
  expect(end, `Expected Dockerfile block end marker ${endMarker}`).toBeGreaterThan(start);
  const runIndex = dockerfile.indexOf("RUN ", start);
  expect(runIndex, `Expected RUN instruction after ${startMarker}`).not.toBe(-1);
  expect(runIndex, `Expected RUN instruction before ${endMarker}`).toBeLessThanOrEqual(end);
  const sourceLines = dockerfile.slice(runIndex, end).split("\n");
  const finalLineIndex = sourceLines.findIndex((line) => !line.trimEnd().endsWith("\\"));
  expect(
    finalLineIndex,
    `Expected complete RUN instruction before ${endMarker}`,
  ).toBeGreaterThanOrEqual(0);
  const runLines = sourceLines.slice(0, finalLineIndex + 1);
  return runLines
    .join("\n")
    .trim()
    .replace(/^RUN\s+/, "")
    .replace(/\\\n/g, " ");
}

function runLoggedDockerShell(command: string, tmp: string) {
  const logPath = path.join(tmp, "calls.log");
  fs.rmSync(logPath, { force: true });
  const scriptPath = path.join(tmp, "run-docker-block.sh");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `call_log=${JSON.stringify(logPath)}`,
      command,
    ].join("\n"),
    { mode: 0o700 },
  );
  return spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
}

function copyRlimitFixture(rlimitLib: string): void {
  copyRlimitFixtureWithNprocLimit(rlimitLib, process.platform === "darwin" ? 4096 : 512);
}

function copyRlimitFixtureWithNprocLimit(rlimitLib: string, limit: number): void {
  fs.writeFileSync(
    rlimitLib,
    fs
      .readFileSync(SANDBOX_RLIMITS, "utf-8")
      .replace(/^NEMOCLAW_SANDBOX_NPROC_LIMIT=512$/m, `NEMOCLAW_SANDBOX_NPROC_LIMIT=${limit}`),
  );
}

function rlimitShim(rlimitLib: string): string {
  return `[ -f ${rlimitLib} ] && . ${rlimitLib} && harden_resource_limits --quiet && verify_resource_limits`;
}

type ProbeKey = "nproc" | "nofile" | "raise_nproc" | "raise_nofile";
type ProbeValues = Partial<Record<ProbeKey | "fork_status" | "spawned", string>>;

function parseProbeOutput(stdout: string): ProbeValues {
  return Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line): [string, string] => {
        const [key, value = ""] = line.split("=", 2);
        return [key, value];
      }),
  ) as ProbeValues;
}

function expectSystemRlimitHookEnforcesLimits(hookPath: string): void {
  const probe = [
    "set -euo pipefail",
    `source ${JSON.stringify(hookPath)}`,
    'nproc_limit="$(ulimit -u)"',
    'nofile_limit="$(ulimit -n)"',
    "set +e",
    "(ulimit -Su 5000) >/dev/null 2>&1",
    'raise_nproc="$?"',
    "(ulimit -Sn 1048576) >/dev/null 2>&1",
    'raise_nofile="$?"',
    "set -e",
    'printf "nproc=%s\\n" "$nproc_limit"',
    'printf "nofile=%s\\n" "$nofile_limit"',
    'printf "raise_nproc=%s\\n" "$raise_nproc"',
    'printf "raise_nofile=%s\\n" "$raise_nofile"',
  ].join("\n");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", probe], {
    encoding: "utf-8",
    timeout: 5000,
  });

  expect(result.status, result.stderr).toBe(0);
  const values = parseProbeOutput(result.stdout);
  const nproc = Number(values.nproc);
  const nofile = Number(values.nofile);
  expect(Number.isInteger(nproc)).toBe(true);
  expect(nproc).toBeLessThanOrEqual(4096);
  expect(Number.isInteger(nofile)).toBe(true);
  expect(nofile).toBeLessThanOrEqual(65536);
  expect(Number(values.raise_nproc)).not.toBe(0);
  expect(Number(values.raise_nofile)).not.toBe(0);
}

function expectHookDeniesBoundedForkStorm(hookPath: string): void {
  const probe = [
    "set -u",
    `source ${JSON.stringify(hookPath)}`,
    'spawned="0"',
    'fork_status="0"',
    "pids=()",
    "cleanup() {",
    "  set +e",
    '  for pid in "${pids[@]:-}"; do kill "$pid" 2>/dev/null || true; done',
    "}",
    "trap cleanup EXIT",
    "for i in $(seq 1 5000); do",
    "  sleep 60 &",
    '  fork_status="$?"',
    '  [ "$fork_status" -eq 0 ] || break',
    '  pids+=("$!")',
    '  spawned="$i"',
    `  [ "$i" -lt ${FORK_STORM_SAFETY_CAP} ] || break`,
    "done",
    'printf "spawned=%s\\n" "$spawned"',
    'printf "fork_status=%s\\n" "$fork_status"',
  ].join("\n");
  const result: SpawnSyncReturns<string> = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-c", probe],
    {
      encoding: "utf-8",
      timeout: 10000,
    },
  );

  expect(result.status, result.stderr).toBe(0);
  const values = parseProbeOutput(result.stdout);
  const spawned = Number(values.spawned ?? "5000");
  const forkStatus = Number(values.fork_status ?? "0");
  const forkStderr = result.stderr;
  const deniedByRlimit =
    forkStatus !== 0 || /Resource temporarily unavailable|fork: retry|fork/i.test(forkStderr);
  expect(deniedByRlimit, `spawned=${spawned} stderr=${forkStderr}`).toBe(true);
  expect(spawned).toBeLessThan(5000);
}

describe("sandbox rlimit system hooks (#2173)", () => {
  const forkStormIt = process.platform === "linux" ? it : it.skip;

  it("connect shell reports numeric nproc <=4096 and nofile <=65536 and denies raising limits after system-wide rlimit hook startup", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE_BASE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-base-rlimit-hooks-"));
    const profileHook = path.join(tmp, "profile.d", "nemoclaw-proxy.sh");
    const rlimitHook = path.join(tmp, "profile.d", "nemoclaw-rlimits.sh");
    const rlimitLib = path.join(tmp, "sandbox-rlimits.sh");
    const bashrc = path.join(tmp, "bash.bashrc");
    const expectedRlimitShim = rlimitShim(rlimitLib);

    try {
      fs.mkdirSync(path.dirname(profileHook), { recursive: true });
      copyRlimitFixture(rlimitLib);
      fs.writeFileSync(bashrc, "# existing bashrc\n");
      const command = dockerRunCommandBetween(
        dockerfile,
        "# System-wide proxy hooks",
        "# Install OpenClaw CLI + PyYAML",
      )
        .replaceAll("/usr/local/lib/nemoclaw/sandbox-rlimits.sh", rlimitLib)
        .replaceAll("/etc/profile.d/nemoclaw-rlimits.sh", rlimitHook)
        .replaceAll("/etc/profile.d/nemoclaw-proxy.sh", profileHook)
        .replaceAll("/etc/bash.bashrc", bashrc);

      const result = runLoggedDockerShell(command, tmp);
      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(rlimitHook, "utf-8")).toContain(expectedRlimitShim);
      expect(fs.readFileSync(bashrc, "utf-8")).toContain(expectedRlimitShim);
      expectSystemRlimitHookEnforcesLimits(rlimitHook);
      expectSystemRlimitHookEnforcesLimits(bashrc);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  forkStormIt(
    "connect shell hook denies a bounded 5000-process fork storm with Resource temporarily unavailable",
    () => {
      expect(FORK_STORM_SAFETY_CAP).toBeGreaterThan(FORK_STORM_NPROC_LIMIT);
      const dockerfile = fs.readFileSync(DOCKERFILE_BASE, "utf-8");
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fork-storm-rlimit-"));
      const profileHook = path.join(tmp, "profile.d", "nemoclaw-proxy.sh");
      const rlimitHook = path.join(tmp, "profile.d", "nemoclaw-rlimits.sh");
      const rlimitLib = path.join(tmp, "sandbox-rlimits.sh");
      const bashrc = path.join(tmp, "bash.bashrc");

      try {
        fs.mkdirSync(path.dirname(profileHook), { recursive: true });
        copyRlimitFixtureWithNprocLimit(rlimitLib, FORK_STORM_NPROC_LIMIT);
        fs.writeFileSync(bashrc, "# existing bashrc\n");
        const command = dockerRunCommandBetween(
          dockerfile,
          "# System-wide proxy hooks",
          "# Install OpenClaw CLI + PyYAML",
        )
          .replaceAll("/usr/local/lib/nemoclaw/sandbox-rlimits.sh", rlimitLib)
          .replaceAll("/etc/profile.d/nemoclaw-rlimits.sh", rlimitHook)
          .replaceAll("/etc/profile.d/nemoclaw-proxy.sh", profileHook)
          .replaceAll("/etc/bash.bashrc", bashrc);

        const result = runLoggedDockerShell(command, tmp);
        expect(result.status, result.stderr).toBe(0);
        expectHookDeniesBoundedForkStorm(rlimitHook);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it("stale OpenClaw base replay preserves effective connect-shell rlimit hooks", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-rlimit-hooks-"));
    const profileHook = path.join(tmp, "profile.d", "nemoclaw-proxy.sh");
    const rlimitHook = path.join(tmp, "profile.d", "nemoclaw-rlimits.sh");
    const rlimitLib = path.join(tmp, "sandbox-rlimits.sh");
    const bashrc = path.join(tmp, "bash.bashrc");

    try {
      fs.mkdirSync(path.dirname(profileHook), { recursive: true });
      copyRlimitFixture(rlimitLib);
      fs.writeFileSync(bashrc, "# stale base bashrc\n");
      const command = dockerRunCommandBetween(
        dockerfile,
        "# System-wide shell hooks",
        "# Pin config hash at build time",
      )
        .replaceAll("/usr/local/lib/nemoclaw/sandbox-rlimits.sh", rlimitLib)
        .replaceAll("/etc/profile.d/nemoclaw-rlimits.sh", rlimitHook)
        .replaceAll("/etc/profile.d/nemoclaw-proxy.sh", profileHook)
        .replaceAll("/etc/bash.bashrc", bashrc);

      const result = runLoggedDockerShell(command, tmp);
      expect(result.status, result.stderr).toBe(0);
      expectSystemRlimitHookEnforcesLimits(rlimitHook);
      expectSystemRlimitHookEnforcesLimits(bashrc);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("stale Hermes base replay preserves effective connect-shell rlimit hooks", () => {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-rlimit-hooks-"));
    const localLib = path.join(tmp, "lib");
    const profileHook = path.join(tmp, "profile.d", "nemoclaw-rlimits.sh");
    const rlimitLib = path.join(localLib, "sandbox-rlimits.sh");
    const initLib = path.join(localLib, "sandbox-init.sh");
    const validator = path.join(localLib, "validate-hermes-env-secret-boundary.py");
    const startBin = path.join(tmp, "nemoclaw-start");
    const bashrc = path.join(tmp, "bash.bashrc");
    const expectedRlimitShim = rlimitShim(rlimitLib);

    try {
      fs.mkdirSync(localLib, { recursive: true });
      fs.mkdirSync(path.dirname(profileHook), { recursive: true });
      copyRlimitFixture(rlimitLib);
      fs.writeFileSync(initLib, "# init fixture\n");
      fs.writeFileSync(validator, "# validator fixture\n");
      fs.writeFileSync(startBin, "#!/usr/bin/env bash\n");
      fs.writeFileSync(bashrc, "# stale hermes bashrc\n");
      const command = dockerRunCommandBetween(
        dockerfile,
        "# Copy startup script and the secret-boundary validator.",
        "# Wrap the hermes CLI",
      )
        .replaceAll("/usr/local/bin/nemoclaw-start", startBin)
        .replaceAll("/usr/local/lib/nemoclaw/sandbox-init.sh", initLib)
        .replaceAll("/usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py", validator)
        .replaceAll("/usr/local/lib/nemoclaw/sandbox-rlimits.sh", rlimitLib)
        .replaceAll("/etc/profile.d/nemoclaw-rlimits.sh", profileHook)
        .replaceAll("/etc/profile.d", path.dirname(profileHook))
        .replaceAll("/etc/bash.bashrc", bashrc);

      const result = runLoggedDockerShell(command, tmp);
      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(profileHook, "utf-8")).toContain(expectedRlimitShim);
      expect(fs.readFileSync(bashrc, "utf-8")).toContain(expectedRlimitShim);
      expectSystemRlimitHookEnforcesLimits(profileHook);
      expectSystemRlimitHookEnforcesLimits(bashrc);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
