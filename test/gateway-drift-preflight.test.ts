// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { testTimeoutOptions } from "./helpers/timeouts";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const ARTIFACT_ROOT = process.env.E2E_ARTIFACT_DIR;
const WORK_ROOT = (() => {
  const parent = ARTIFACT_ROOT ?? os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, "nemoclaw-gateway-drift-preflight-"));
})();
const commandTimeoutMs = 45_000;

const liveGatewayPids: number[] = [];

afterAll(() => {
  for (const pid of liveGatewayPids.splice(0)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already exited.
    }
  }
  if (!ARTIFACT_ROOT) fs.rmSync(WORK_ROOT, { recursive: true, force: true });
});

type CommandResult = {
  caseDir: string;
  output: string;
  status: number | null;
  signal: NodeJS.Signals | null;
};

function writeFileExecutable(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o755 });
}

function writeRegistry(home: string): void {
  const stateDir = path.join(home, ".nemoclaw");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "sandboxes.json"),
    `${JSON.stringify(
      {
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
            agent: "openclaw",
            agentVersion: "test-version",
          },
        },
        defaultSandbox: "alpha",
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

function writeFakeOpenshell(binDir: string): void {
  writeFileExecutable(
    path.join(binDir, "openshell"),
    `#!/usr/bin/env bash
set -uo pipefail
: "\${NEMOCLAW_FAKE_CASE_DIR:?}"
printf '%s\n' "$*" >> "$NEMOCLAW_FAKE_CASE_DIR/openshell-calls.log"
case "\${1:-}" in
  --version|-V)
    printf 'openshell 0.0.37\n'
    exit 0
    ;;
  status)
    printf 'Server Status\n\n  Gateway: nemoclaw\n  Gateway endpoint: http://127.0.0.1:8080\n  Status: Connected\n'
    exit 0
    ;;
  gateway)
    if [ "\${2:-}" = "info" ]; then
      printf 'Gateway Info\n\n  Gateway: nemoclaw\n  Gateway endpoint: http://127.0.0.1:8080\n'
      exit 0
    fi
    ;;
  sandbox)
    if [ "\${2:-}" = "list" ]; then
      printf '%s\n' 'Error: status: Internal, message: "failed to decode Protobuf message: Sandbox.metadata: SandboxResponse.sandbox: invalid wire type value: 6"' >&2
      exit "\${NEMOCLAW_FAKE_SANDBOX_LIST_EXIT:-1}"
    fi
    ;;
esac
printf 'unexpected openshell args: %s\n' "$*" >&2
exit 9
`,
  );
}

function writeFakeDocker(
  binDir: string,
  options: {
    gatewayImage?: string;
    gatewayPorts?: string;
    gatewayRunning?: string;
  } = {},
): void {
  const gatewayRunning = options.gatewayRunning ?? "true";
  const gatewayPorts =
    options.gatewayPorts ?? '{"30051/tcp":[{"HostIp":"0.0.0.0","HostPort":"8080"}]}';
  const gatewayImage = options.gatewayImage ?? "ghcr.io/nvidia/openshell/cluster:0.0.37";
  writeFileExecutable(
    path.join(binDir, "docker"),
    `#!/usr/bin/env bash
set -uo pipefail
case_dir="\${NEMOCLAW_FAKE_CASE_DIR:-\${TMPDIR:-/tmp}/nemoclaw-gateway-drift-preflight-current}"
printf '%s\n' "$*" >> "$case_dir/docker-calls.log"
format=""
if [ "\${1:-}" = "inspect" ] || { [ "\${1:-}" = "container" ] && [ "\${2:-}" = "inspect" ]; }; then
  while [ "$#" -gt 0 ]; do
    if [ "\${1:-}" = "--format" ]; then
      shift
      format="\${1:-}"
      break
    fi
    shift
  done
  case "$format" in
    '{{.State.Running}}'|"'{{.State.Running}}'")
      printf '%s\n' ${JSON.stringify(gatewayRunning)}
      exit 0
      ;;
    '{{json .NetworkSettings.Ports}}'|"'{{json .NetworkSettings.Ports}}'")
      printf '%s\n' ${JSON.stringify(gatewayPorts)}
      exit 0
      ;;
    '{{.Config.Image}}'|"'{{.Config.Image}}'")
      printf '%s\n' ${JSON.stringify(gatewayImage)}
      exit 0
      ;;
  esac
fi
printf 'unexpected docker args: %s\n' "$*" >&2
exit 9
`,
  );
}

function writeFakeDockerNoCluster(binDir: string): void {
  writeFileExecutable(
    path.join(binDir, "docker"),
    `#!/usr/bin/env bash
set -uo pipefail
printf '%s\n' "$*" >> "$NEMOCLAW_FAKE_CASE_DIR/docker-calls.log"
if [ "\${1:-}" = "inspect" ] || { [ "\${1:-}" = "container" ] && [ "\${2:-}" = "inspect" ]; }; then
  printf 'Error: No such object\n' >&2
  exit 1
fi
exit 0
`,
  );
}

function writeFakeGatewayBinary(binDir: string, version = "0.0.43"): string {
  const gatewayBin = path.join(binDir, "openshell-gateway");
  writeFileExecutable(
    gatewayBin,
    `#!/usr/bin/env bash
case "\${1:-}" in --version|-V) printf 'openshell-gateway %s\n' ${JSON.stringify(version)}; exit 0 ;; esac
exec -a "$0" sleep 600
`,
  );
  return gatewayBin;
}

function writeHostProcessMarker(home: string, gatewayBin: string, pid = 999999): void {
  const stateDir = path.join(home, ".local", "state", "nemoclaw", "openshell-docker-gateway");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "runtime.json"),
    `${JSON.stringify(
      {
        version: 1,
        pid,
        driver: "docker",
        platform: process.platform,
        arch: process.arch,
        endpoint: "http://127.0.0.1:8080",
        desiredEnvHash: "deadbeef",
        gatewayBin,
        openshellVersion: "0.0.44",
        dockerHost: "unix:///run/docker.sock",
        createdAt: "2026-05-25T10:27:03.702Z",
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

function prepareCase(name: string): { binDir: string; caseDir: string; home: string } {
  const caseDir = path.join(WORK_ROOT, name);
  const home = path.join(caseDir, "home");
  const binDir = path.join(caseDir, "bin");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(caseDir, "openshell-calls.log"), "");
  fs.writeFileSync(path.join(caseDir, "docker-calls.log"), "");
  writeRegistry(home);
  writeFakeOpenshell(binDir);
  return { binDir, caseDir, home };
}

function runCli(caseDir: string, home: string, binDir: string, args: string[]): CommandResult {
  const result = spawnSync(process.execPath, [CLI_ENTRYPOINT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: home,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      TMPDIR: caseDir,
      NO_COLOR: "1",
      NEMOCLAW_DISABLE_GATEWAY_DRIFT_PREFLIGHT: "0",
      NEMOCLAW_FAKE_CASE_DIR: caseDir,
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    },
    timeout: commandTimeoutMs,
  });
  return {
    caseDir,
    output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
    status: result.status,
    signal: result.signal,
  };
}

function runBackupCase(
  name: string,
  options: { gatewayImage?: string; gatewayRunning?: string } = {},
): CommandResult {
  const { binDir, caseDir, home } = prepareCase(name);
  writeFakeDocker(binDir, options);
  return runCli(caseDir, home, binDir, ["backup-all"]);
}

function runHostProcessCase(
  name: string,
  options: { liveMarker?: boolean; noMarker?: boolean; version?: string; command?: string[] } = {},
): CommandResult {
  const { binDir, caseDir, home } = prepareCase(name);
  writeFakeDockerNoCluster(binDir);
  const gatewayBin = writeFakeGatewayBinary(binDir, options.version ?? "0.0.43");
  if (options.noMarker !== true) {
    if (options.liveMarker) {
      const child = spawn(gatewayBin, ["serve"], { detached: false, stdio: "ignore" });
      expect(child.pid, "fake gateway process must have a pid").toBeTypeOf("number");
      const pid = child.pid as number;
      liveGatewayPids.push(pid);
      writeHostProcessMarker(home, gatewayBin, pid);
    } else {
      writeHostProcessMarker(home, gatewayBin, 999999);
    }
  }
  return runCli(caseDir, home, binDir, options.command ?? ["backup-all"]);
}

function logsFor(caseDir: string): string {
  const readIfExists = (name: string) => {
    const file = path.join(caseDir, name);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  };
  return [
    "--- fake openshell calls ---",
    readIfExists("openshell-calls.log"),
    "--- fake docker calls ---",
    readIfExists("docker-calls.log"),
  ].join("\n");
}

function expectContains(result: CommandResult, pattern: RegExp, description: string): void {
  expect(
    result.output,
    `${description}\n${logsFor(result.caseDir)}\n--- command output ---\n${result.output}`,
  ).toMatch(pattern);
}

function expectNotContains(result: CommandResult, pattern: RegExp, description: string): void {
  expect(
    result.output,
    `${description}\n${logsFor(result.caseDir)}\n--- command output ---\n${result.output}`,
  ).not.toMatch(pattern);
}

function expectSandboxListCalled(result: CommandResult, expected: boolean): void {
  const calls = fs.readFileSync(path.join(result.caseDir, "openshell-calls.log"), "utf-8");
  const called = calls.split(/\r?\n/).some((line) => /^sandbox\s+list(?:\s|$)/.test(line.trim()));
  expect(
    called,
    `sandbox list calls expectation failed\n${logsFor(result.caseDir)}\n${result.output}`,
  ).toBe(expected);
}

describe("gateway drift preflight E2E migration", () => {
  it(
    "fails closed before unsafe sandbox state mutation when gateway schema or binary drift is detected",
    testTimeoutOptions(180_000),
    () => {
      expect(fs.existsSync(CLI_ENTRYPOINT), "repo CLI entrypoint must exist").toBe(true);

      const protobuf = runBackupCase("protobuf-mismatch", {
        gatewayImage: "ghcr.io/nvidia/openshell/cluster:0.0.37",
        gatewayRunning: "false",
      });
      expect(protobuf.signal, protobuf.output).toBeNull();
      expectContains(
        protobuf,
        /protobuf|schema mismatch|invalid wire type/i,
        "protobuf mismatch is surfaced",
      );
      expectContains(
        protobuf,
        /No sandbox data was changed|Refusing to trust OpenShell sandbox state/i,
        "fail-closed no-mutation guidance is printed",
      );
      expectNotContains(
        protobuf,
        /Skipping '?alpha'? \(not running\)/,
        "running sandbox is not misclassified as stopped",
      );
      expectNotContains(
        protobuf,
        /Backup complete/i,
        "backup does not proceed after unsafe state RPC",
      );
      expectSandboxListCalled(protobuf, true);

      const imageDrift = runBackupCase("patched-image-drift", {
        gatewayImage: "nemoclaw-cluster:0.0.36-fuse-overlayfs-aa8b8487",
      });
      expect(imageDrift.status, imageDrift.output).not.toBe(0);
      expectContains(
        imageDrift,
        /schema preflight failed|gateway schema preflight failed|image.*does not match|Running gateway image/i,
        "gateway image drift preflight is surfaced",
      );
      expectContains(imageDrift, /0\.0\.37/, "installed OpenShell version is reported");
      expectContains(
        imageDrift,
        /nemoclaw-cluster:0\.0\.36-fuse-overlayfs-aa8b8487|0\.0\.36/,
        "patched stale gateway image/version is reported",
      );
      expectSandboxListCalled(imageDrift, false);

      const hostBackup = runHostProcessCase("host-process-backup", { liveMarker: true });
      expect(hostBackup.status, hostBackup.output).not.toBe(0);
      expectContains(
        hostBackup,
        /schema preflight failed|gateway schema preflight failed|Running gateway binary/i,
        "host-process gateway drift preflight is surfaced",
      );
      expectContains(hostBackup, /0\.0\.37/, "installed OpenShell version is reported");
      expectContains(
        hostBackup,
        /Running gateway binary.*0\.0\.43/,
        "running host-process gateway binary/version is reported",
      );
      expectContains(
        hostBackup,
        /No sandbox data was changed|Refusing to trust OpenShell sandbox state/i,
        "fail-closed no-mutation guidance is printed",
      );
      expectNotContains(
        hostBackup,
        /Running gateway image/i,
        "host-process drift does not claim a cluster image",
      );
      expectSandboxListCalled(hostBackup, false);

      const hostUpgrade = runHostProcessCase("host-process-upgrade", {
        command: ["upgrade-sandboxes", "--check"],
      });
      expect(hostUpgrade.status, hostUpgrade.output).not.toBe(0);
      expectContains(
        hostUpgrade,
        /schema preflight failed|gateway schema preflight failed|Running gateway binary/i,
        "host-process gateway drift preflight is surfaced for upgrade-sandboxes",
      );
      expectContains(
        hostUpgrade,
        /Running gateway binary.*0\.0\.43/,
        "running host-process gateway binary/version is reported for upgrade-sandboxes",
      );
      expectSandboxListCalled(hostUpgrade, false);

      const noMarker = runHostProcessCase("host-process-no-marker", { noMarker: true });
      expect(noMarker.status, noMarker.output).not.toBe(0);
      expectContains(
        noMarker,
        /schema preflight failed|gateway schema preflight failed|Running gateway binary/i,
        "host-process gateway drift is detected via fallback resolver without runtime marker",
      );
      expectContains(
        noMarker,
        /Running gateway binary.*0\.0\.43/,
        "fallback-resolved gateway binary/version is reported",
      );
      expectSandboxListCalled(noMarker, false);

      const stale = (() => {
        const { binDir, caseDir, home } = prepareCase("host-process-stale-marker");
        const oldInstall = path.join(caseDir, "old-install");
        fs.mkdirSync(oldInstall, { recursive: true });
        writeFakeDockerNoCluster(binDir);
        writeFakeGatewayBinary(binDir, "0.0.37");
        const staleGateway = writeFakeGatewayBinary(oldInstall, "0.0.43");
        writeHostProcessMarker(home, staleGateway, 999999);
        return runCli(caseDir, home, binDir, ["backup-all"]);
      })();
      expectNotContains(
        stale,
        /Running gateway binary.*0\.0\.43/,
        "stale marker binary is not used to fabricate drift",
      );
      expectSandboxListCalled(stale, true);
    },
  );
});
