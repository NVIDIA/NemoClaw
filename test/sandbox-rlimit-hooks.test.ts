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
const FORK_STORM_LIMIT_HEADROOM = 512;
const FORK_STORM_SAFETY_HEADROOM = 128;

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

type ProbeKey = "nproc" | "nofile" | "raise_nproc" | "raise_nofile" | "shadow";
type ProbeValues = Partial<Record<ProbeKey | "fork_error" | "fork_status" | "spawned", string>>;

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

function occurrenceCount(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function currentUserProcessCount(): number {
  const result = spawnSync("bash", ["-lc", 'ps -u "$(id -u)" -o pid= | wc -l'], {
    encoding: "utf-8",
    timeout: 5000,
  });
  expect(result.status, result.stderr).toBe(0);
  const count = Number(result.stdout.trim());
  expect(Number.isInteger(count), result.stdout).toBe(true);
  return count;
}

function expectSystemRlimitHookEnforcesLimits(hookPath: string): void {
  const probe = [
    "set -euo pipefail",
    `source ${JSON.stringify(hookPath)}`,
    'nproc_limit="$(builtin ulimit -u)"',
    'nofile_limit="$(builtin ulimit -n)"',
    "set +e",
    "(builtin ulimit -Su 5000) >/dev/null 2>&1",
    'raise_nproc="$?"',
    "(builtin ulimit -Sn 1048576) >/dev/null 2>&1",
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

function expectSystemRlimitHookUsesBuiltinUlimit(hookPath: string): void {
  const probe = [
    "set -euo pipefail",
    "ulimit() {",
    '  case "$1:$#" in',
    "    -Su:2 | -Hu:2 | -Sn:2 | -Hn:2) return 0 ;;",
    "    -Su:1 | -Hu:1 | -Sn:1 | -Hn:1) printf '%s\\n' 999999; return 0 ;;",
    "  esac",
    "  return 0",
    "}",
    `source ${JSON.stringify(hookPath)}`,
    'printf "shadow=%s\\n" "$(type -t ulimit)"',
    'printf "nproc=%s\\n" "$(builtin ulimit -u)"',
    'printf "nofile=%s\\n" "$(builtin ulimit -n)"',
  ].join("\n");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", probe], {
    encoding: "utf-8",
    timeout: 5000,
  });

  expect(result.status, result.stderr).toBe(0);
  const values = parseProbeOutput(result.stdout);
  expect(values.shadow).toBe("function");
  expect(Number(values.nproc)).toBeLessThanOrEqual(4096);
  expect(Number(values.nofile)).toBeLessThanOrEqual(65536);
}

function expectHookDeniesBoundedForkStorm(hookPath: string, safetyCap: number): void {
  const probePath = path.join(path.dirname(hookPath), "fork-storm-probe.py");
  fs.writeFileSync(
    probePath,
    [
      "import errno",
      "import subprocess",
      "import sys",
      "",
      "safety_cap = int(sys.argv[1])",
      "spawned = 0",
      "fork_status = 0",
      "fork_error = ''",
      "children = []",
      "try:",
      "    for attempt in range(1, 5001):",
      "        try:",
      "            child = subprocess.Popen(['sleep', '30'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)",
      "        except OSError as exc:",
      "            fork_status = exc.errno or errno.EAGAIN",
      "            fork_error = str(exc)",
      "            break",
      "        children.append(child)",
      "        spawned = attempt",
      "        if attempt >= safety_cap:",
      "            break",
      "finally:",
      "    for child in children:",
      "        child.terminate()",
      "    for child in children:",
      "        try:",
      "            child.wait(timeout=2)",
      "        except subprocess.TimeoutExpired:",
      "            child.kill()",
      "            child.wait(timeout=2)",
      "",
      "print(f'spawned={spawned}')",
      "print(f'fork_status={fork_status}')",
      "if fork_error:",
      "    print(f'fork_error={fork_error}')",
      "",
    ].join("\n"),
  );
  const probe = [
    "set -euo pipefail",
    `source ${JSON.stringify(hookPath)}`,
    `exec python3 ${JSON.stringify(probePath)} ${safetyCap}`,
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
  const forkStderr = `${values.fork_error ?? ""}\n${result.stderr}`;
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
      expectSystemRlimitHookUsesBuiltinUlimit(rlimitHook);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  forkStormIt(
    "connect shell hook denies a bounded 5000-process fork storm with Resource temporarily unavailable",
    () => {
      const dockerfile = fs.readFileSync(DOCKERFILE_BASE, "utf-8");
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fork-storm-rlimit-"));
      const profileHook = path.join(tmp, "profile.d", "nemoclaw-proxy.sh");
      const rlimitHook = path.join(tmp, "profile.d", "nemoclaw-rlimits.sh");
      const rlimitLib = path.join(tmp, "sandbox-rlimits.sh");
      const bashrc = path.join(tmp, "bash.bashrc");
      const nprocLimit = currentUserProcessCount() + FORK_STORM_LIMIT_HEADROOM;
      const safetyCap = nprocLimit + FORK_STORM_SAFETY_HEADROOM;
      expect(safetyCap).toBeGreaterThan(nprocLimit);
      try {
        fs.mkdirSync(path.dirname(profileHook), { recursive: true });
        copyRlimitFixtureWithNprocLimit(rlimitLib, nprocLimit);
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
        expectHookDeniesBoundedForkStorm(rlimitHook, safetyCap);
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
    const expectedProxyShim = "[ -f /tmp/nemoclaw-proxy-env.sh ] && . /tmp/nemoclaw-proxy-env.sh";
    const expectedRlimitShim = rlimitShim(rlimitLib);

    try {
      fs.mkdirSync(path.dirname(profileHook), { recursive: true });
      copyRlimitFixture(rlimitLib);
      fs.writeFileSync(
        bashrc,
        [
          "# NemoClaw runtime proxy config — see /tmp/nemoclaw-proxy-env.sh (#2704)",
          "[ -f /tmp/nemoclaw-proxy-env.sh ] && . /tmp/nemoclaw-proxy-env.sh",
          "# NemoClaw sandbox resource limits — see sandbox-rlimits.sh (#2173)",
          "[ -f /usr/local/lib/nemoclaw/sandbox-rlimits.sh ] && . /usr/local/lib/nemoclaw/sandbox-rlimits.sh && harden_resource_limits --quiet && verify_resource_limits",
        ].join("\n"),
      );
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
      const bashrcBody = fs.readFileSync(bashrc, "utf-8");
      expect(occurrenceCount(bashrcBody, expectedProxyShim)).toBe(1);
      expect(occurrenceCount(bashrcBody, expectedRlimitShim)).toBe(1);
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
