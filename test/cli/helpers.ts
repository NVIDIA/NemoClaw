// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import { execTimeout, testTimeout, testTimeoutOptions } from "../helpers/timeouts";

export { execTimeout, testTimeout, testTimeoutOptions };

export const CLI = path.join(import.meta.dirname, "..", "..", "bin", "nemoclaw.js");
export const HERMES_CLI = path.join(import.meta.dirname, "..", "..", "bin", "nemohermes.js");
export const PARSER_EXIT_CODE = 2;

export function readOpenClawExpectedVersion(): string {
  const manifestPath = path.join(
    import.meta.dirname,
    "..",
    "..",
    "agents",
    "openclaw",
    "manifest.yaml",
  );
  const manifest = parseYaml(fs.readFileSync(manifestPath, "utf8")) as {
    expected_version?: unknown;
  };
  if (typeof manifest.expected_version === "string" && manifest.expected_version.trim()) {
    return manifest.expected_version;
  }
  throw new Error("agents/openclaw/manifest.yaml is missing expected_version");
}

export const OPENCLAW_EXPECTED_VERSION = readOpenClawExpectedVersion();

export type CliRunResult = {
  code: number;
  out: string;
};

export type CliErrorShape = {
  status?: number;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};

export type CliErrorCandidate = {
  status?: unknown;
  stdout?: unknown;
  stderr?: unknown;
};

export function isCliErrorCandidate(value: unknown): value is CliErrorCandidate {
  return typeof value === "object" && value !== null;
}

export function readBufferOrStringProperty(
  value: CliErrorCandidate,
  key: "stdout" | "stderr",
): string | Buffer | undefined {
  const property = value[key];
  return typeof property === "string" || Buffer.isBuffer(property) ? property : undefined;
}

export function toText(value: string | Buffer | undefined): string {
  return typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : "";
}

export function readCliErrorOutput(error: CliErrorShape | string | null | undefined): CliRunResult {
  if (!error || typeof error === "string") {
    return { code: 1, out: String(error || "") };
  }
  return {
    code: typeof error.status === "number" ? error.status : 1,
    out: `${toText(error.stdout)}${toText(error.stderr)}`,
  };
}

function splitCliArgs(args: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let tokenStarted = false;

  for (const char of args.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      tokenStarted = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      tokenStarted = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }
    current += char;
    tokenStarted = true;
  }

  if (escaped) current += "\\";
  if (quote) throw new Error(`Unterminated quote in test CLI args: ${args}`);
  if (tokenStarted) tokens.push(current);
  return tokens;
}

export function normalizeChildExit(code: number | null, signal: NodeJS.Signals | null): number | null {
  if (code !== null) return code;
  if (signal === "SIGTERM") return 143;
  if (signal === "SIGINT") return 130;
  return null;
}

export function waitForChildExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve(normalizeChildExit(code, signal)));
  });
}

export function isChildRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

export function run(args: string): CliRunResult {
  return runWithEnv(args);
}

export function runWithEnv(
  args: string,
  env: Record<string, string | undefined> = {},
  timeout: number = execTimeout(),
): CliRunResult {
  const parsedArgs = splitCliArgs(args);
  const mergeStderrOnSuccess = parsedArgs.includes("2>&1");
  const cliArgs = parsedArgs.filter((token) => token !== "2>&1");
  const result = spawnSync(process.execPath, [CLI, ...cliArgs], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    env: {
      ...process.env,
      HOME: fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-test-")),
      NEMOCLAW_HEALTH_POLL_COUNT: "1",
      NEMOCLAW_HEALTH_POLL_INTERVAL: "0",
      ...env,
    },
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const errorOutput = result.error ? String(result.error) : "";
  const code = typeof result.status === "number" ? result.status : 1;
  if (code === 0) {
    return { code, out: mergeStderrOnSuccess ? `${stdout}${stderr}` : stdout };
  }
  return { code, out: `${stdout}${stderr}${errorOutput}` };
}

export function readRecordedArgs(markerFile: string): string[] {
  return fs.readFileSync(markerFile, "utf8").trim().split(/\s+/);
}

export type SandboxEntry = {
  name: string;
  model: string;
  provider: string;
  gpuEnabled: boolean;
  policies: string[];
  agent?: string;
  openshellDriver?: string | null;
  agentVersion?: string | null;
};

export type SandboxOverrides = Partial<SandboxEntry> & Record<string, unknown>;

export function writeRecordingCommand(
  binDir: string,
  command: string,
  markerFile: string,
  exitCode: number,
): void {
  fs.writeFileSync(
    path.join(binDir, command),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(markerFile)}`,
      `exit ${exitCode}`,
    ].join("\n"),
    { mode: 0o755 },
  );
}

export function writeSandboxRegistry(
  home: string,
  sandboxNameOrOverrides: string | SandboxOverrides = "alpha",
  sandboxOverridesArg: SandboxOverrides = {},
): void {
  const sandboxName =
    typeof sandboxNameOrOverrides === "string" ? sandboxNameOrOverrides : "alpha";
  const sandboxOverrides =
    typeof sandboxNameOrOverrides === "string" ? sandboxOverridesArg : sandboxNameOrOverrides;
  const registryDir = path.join(home, ".nemoclaw");
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, "sandboxes.json"),
    JSON.stringify({
      sandboxes: {
        [sandboxName]: {
          name: sandboxName,
          model: "test-model",
          provider: "nvidia-prod",
          gpuEnabled: false,
          policies: [],
          ...sandboxOverrides,
        },
      },
      defaultSandbox: sandboxName,
    }),
    { mode: 0o600 },
  );
}

// Several sandbox commands (status, connect, logs, policy-list) now preflight
// `docker info` to classify a Docker daemon outage (#4428). Tests that should
// exercise the normal (Docker-up) path must stub a healthy `docker info` so
// they stay hermetic regardless of whether the host/CI runner has a running
// Docker daemon.
export function writeHealthyDockerStub(localBin: string): void {
  fs.writeFileSync(
    path.join(localBin, "docker"),
    ["#!/usr/bin/env bash", 'if [ "$1" = "info" ]; then echo "24.0.0"; exit 0; fi', "exit 0"].join(
      "\n",
    ),
    { mode: 0o755 },
  );
}

export const FAKE_OPENCLAW_LOG_LINE = "openclaw gateway log: policy checker ready";
export const FAKE_OPENSHELL_LOG_LINE = "openshell audit log: DENIED example.com:443";

type LogsTestSetupOptions = {
  gatewayStartedMarker?: string;
};

export function createLogsTestSetup(
  prefix: string,
  openshellLines: string[] = [],
  options: LogsTestSetupOptions = {},
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const localBin = path.join(home, "bin");
  const markerFile = path.join(home, "logs-calls");
  const gatewayStartedLines = options.gatewayStartedMarker
    ? [`  printf '%s\\n' ${JSON.stringify(options.gatewayStartedMarker)} >> "$marker_file"`]
    : [];
  fs.mkdirSync(localBin, { recursive: true });
  writeSandboxRegistry(home);
  fs.writeFileSync(
    path.join(localBin, "openshell"),
    [
      "#!/usr/bin/env bash",
      `marker_file=${JSON.stringify(markerFile)}`,
      'printf \'%s\\n\' "$*" >> "$marker_file"',
      ...openshellLines,
      'if [ "$1" = "settings" ]; then',
      "  exit 0",
      "fi",
      'if [ "$1" = "sandbox" ]; then',
      ...gatewayStartedLines,
      `  echo ${JSON.stringify(FAKE_OPENCLAW_LOG_LINE)}`,
      "  exit 0",
      "fi",
      'if [ "$1" = "logs" ]; then',
      `  echo ${JSON.stringify(FAKE_OPENSHELL_LOG_LINE)}`,
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  // `logs` now preflights the Docker daemon (#4428); stub a healthy daemon.
  writeHealthyDockerStub(localBin);

  return {
    home,
    localBin,
    markerFile,
    readCalls: () =>
      fs.existsSync(markerFile) ? fs.readFileSync(markerFile, "utf8").trim().split(/\n/) : [],
    runLogs: (args = "alpha logs", env: Record<string, string | undefined> = {}) =>
      runWithEnv(args, {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
        ...env,
      }),
  };
}

export function createDoctorTestSetup(prefix: string, openshellLines: string[], sandboxName = "alpha") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const localBin = path.join(home, "bin");
  const markerFile = path.join(home, "doctor-calls");
  fs.mkdirSync(localBin, { recursive: true });
  writeSandboxRegistry(home, sandboxName);

  fs.writeFileSync(
    path.join(localBin, "openshell"),
    [
      "#!/usr/bin/env bash",
      `marker_file=${JSON.stringify(markerFile)}`,
      'printf \'%s\\n\' "$*" >> "$marker_file"',
      ...openshellLines,
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(localBin, "docker"),
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = "info" ]; then echo "24.0.0"; exit 0; fi',
      'if [ "$1" = "inspect" ]; then printf "true\\tnone\\topenshell:test\\n"; exit 0; fi',
      'if [ "$1" = "port" ]; then echo "0.0.0.0:8080"; exit 0; fi',
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(localBin, "curl"), ["#!/usr/bin/env bash", "exit 7"].join("\n"), {
    mode: 0o755,
  });

  return {
    home,
    localBin,
    readCalls: () =>
      fs.existsSync(markerFile) ? fs.readFileSync(markerFile, "utf8").trim().split(/\n/) : [],
    runDoctor: (args = `${sandboxName} doctor --json`) =>
      runWithEnv(
        args,
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
        30000,
      ),
  };
}

export function createCloudflaredServiceDir(prefix: string): { sandboxName: string; serviceDir: string } {
  const suffix = [
    process.pid.toString(36),
    Date.now().toString(36),
    Math.random().toString(36).slice(2, 10),
  ].join("-");
  const sandboxName = `${prefix}${suffix}`;
  const serviceDir = path.join("/tmp", `nemoclaw-services-${sandboxName}`);
  fs.rmSync(serviceDir, { recursive: true, force: true });
  fs.mkdirSync(serviceDir, { recursive: true });
  return { sandboxName, serviceDir };
}

export function createDebugCommandTestEnv(
  prefix: string,
  options: { extraSandboxNames?: string[] } = {},
): Record<string, string> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const localBin = path.join(home, "bin");
  const sandboxName = `${prefix}${process.pid.toString(36)}-${Date.now().toString(36)}`;
  fs.mkdirSync(localBin, { recursive: true });
  // Register the env-sourced sandbox plus any extra names supplied via the
  // --sandbox flag so the validation gate accepts them.
  writeSandboxRegistry(home, sandboxName);
  if (options.extraSandboxNames && options.extraSandboxNames.length > 0) {
    const registryPath = path.join(home, ".nemoclaw", "sandboxes.json");
    const current = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as {
      sandboxes: Record<string, unknown>;
      defaultSandbox?: string | null;
    };
    for (const extra of options.extraSandboxNames) {
      current.sandboxes[extra] = {
        name: extra,
        model: "test-model",
        provider: "nvidia-prod",
        gpuEnabled: false,
        policies: [],
      };
    }
    fs.writeFileSync(registryPath, JSON.stringify(current), { mode: 0o600 });
  }
  const registeredNames = [sandboxName, ...(options.extraSandboxNames ?? [])];
  const listLines = ["NAME", ...registeredNames.map((name) => `${name}      Ready`)];
  fs.writeFileSync(
    path.join(localBin, "openshell"),
    [
      "#!/bin/sh",
      'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
      ...listLines.map((line) => `  echo ${JSON.stringify(line)}`),
      "  exit 0",
      "fi",
      "echo 'openshell ok'",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(localBin, "docker"), ["#!/bin/sh", "exit 0"].join("\n"), {
    mode: 0o755,
  });
  fs.writeFileSync(
    path.join(localBin, "dmesg"),
    ["#!/bin/sh", "echo 'nemoclaw test kernel message'", "exit 0"].join("\n"),
    { mode: 0o755 },
  );
  return {
    HOME: home,
    NEMOCLAW_HOME: path.join(home, ".nemoclaw"),
    NEMOCLAW_SANDBOX: sandboxName,
    PATH: `${localBin}:${process.env.PATH || ""}`,
  };
}

export function writeHostAliasDockerStub(
  localBin: string,
  dockerLog: string,
  hostAliases: { ip: string; hostnames: string[] }[],
  { gatewayRunning = true }: { gatewayRunning?: boolean } = {},
): void {
  const resource = JSON.stringify({
    metadata: { resourceVersion: "123" },
    spec: { podTemplate: { spec: { hostAliases } } },
  });
  fs.writeFileSync(
    path.join(localBin, "docker"),
    [
      "#!/usr/bin/env bash",
      `log_file=${JSON.stringify(dockerLog)}`,
      'printf "%s\\n" "$@" >> "$log_file"',
      'if [ "$1" = "ps" ]; then',
      gatewayRunning ? '  printf "%s\\n" "openshell-cluster-nemoclaw"' : "  :",
      "  exit 0",
      "fi",
      'if printf "%s\\n" "$@" | grep -q "^get$"; then',
      `  printf "%s\\n" ${JSON.stringify(resource)}`,
      "fi",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
}
