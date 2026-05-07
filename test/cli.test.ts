// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { execSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { execTimeout, testTimeout, testTimeoutOptions } from "./helpers/timeouts";

const CLI = path.join(import.meta.dirname, "..", "bin", "nemoclaw.js");
const HERMES_CLI = path.join(import.meta.dirname, "..", "bin", "nemohermes.js");
const PARSER_EXIT_CODE = 2;

type CliRunResult = {
  code: number;
  out: string;
};

type CliErrorShape = {
  status?: number;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};

type CliErrorCandidate = {
  status?: unknown;
  stdout?: unknown;
  stderr?: unknown;
};

function isCliErrorCandidate(value: unknown): value is CliErrorCandidate {
  return typeof value === "object" && value !== null;
}

function readBufferOrStringProperty(
  value: CliErrorCandidate,
  key: "stdout" | "stderr",
): string | Buffer | undefined {
  const property = value[key];
  return typeof property === "string" || Buffer.isBuffer(property) ? property : undefined;
}

function toText(value: string | Buffer | undefined): string {
  return typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : "";
}

function readCliErrorOutput(error: CliErrorShape | string | null | undefined): CliRunResult {
  if (!error || typeof error === "string") {
    return { code: 1, out: String(error || "") };
  }
  return {
    code: typeof error.status === "number" ? error.status : 1,
    out: `${toText(error.stdout)}${toText(error.stderr)}`,
  };
}

function normalizeChildExit(code: number | null, signal: NodeJS.Signals | null): number | null {
  if (code !== null) return code;
  if (signal === "SIGTERM") return 143;
  if (signal === "SIGINT") return 130;
  return null;
}

function waitForChildExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve(normalizeChildExit(code, signal)));
  });
}

function isChildRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function run(args: string): CliRunResult {
  return runWithEnv(args);
}

function runWithEnv(
  args: string,
  env: Record<string, string | undefined> = {},
  timeout: number = execTimeout(),
): CliRunResult {
  try {
    const out = execSync(`node "${CLI}" ${args}`, {
      encoding: "utf-8",
      stdio: "pipe",
      timeout,
      env: {
        ...process.env,
        HOME: "/tmp/nemoclaw-cli-test-" + Date.now(),
        NEMOCLAW_HEALTH_POLL_COUNT: "1",
        NEMOCLAW_HEALTH_POLL_INTERVAL: "0",
        ...env,
      },
    });
    return { code: 0, out };
  } catch (err) {
    if (isCliErrorCandidate(err)) {
      return readCliErrorOutput({
        status: typeof err.status === "number" ? err.status : undefined,
        stdout: readBufferOrStringProperty(err, "stdout"),
        stderr: readBufferOrStringProperty(err, "stderr"),
      });
    }
    return readCliErrorOutput(String(err));
  }
}

function readRecordedArgs(markerFile: string): string[] {
  return fs.readFileSync(markerFile, "utf8").trim().split(/\s+/);
}

type SandboxEntry = {
  name: string;
  model: string;
  provider: string;
  gpuEnabled: boolean;
  policies: string[];
  agent?: string;
};

function writeRecordingCommand(
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

function writeSandboxRegistry(
  home: string,
  sandboxNameOrOverrides: string | Partial<SandboxEntry> = "alpha",
  sandboxOverridesArg: Partial<SandboxEntry> = {},
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

const FAKE_OPENCLAW_LOG_LINE = "openclaw gateway log: policy checker ready";
const FAKE_OPENSHELL_LOG_LINE = "openshell audit log: DENIED example.com:443";

function createLogsTestSetup(prefix: string, openshellLines: string[] = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const localBin = path.join(home, "bin");
  const markerFile = path.join(home, "logs-calls");
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

function createDoctorTestSetup(prefix: string, openshellLines: string[], sandboxName = "alpha") {
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

function createCloudflaredServiceDir(prefix: string): { sandboxName: string; serviceDir: string } {
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

function createDebugCommandTestEnv(prefix: string): Record<string, string> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const localBin = path.join(home, "bin");
  fs.mkdirSync(localBin, { recursive: true });
  fs.writeFileSync(
    path.join(localBin, "openshell"),
    [
      "#!/bin/sh",
      'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
      "  echo 'NAME'",
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
  return {
    HOME: home,
    PATH: `${localBin}:${process.env.PATH || ""}`,
  };
}

describe("CLI dispatch", () => {
  it("config get validates flags and values before dispatch", async () => {
    const sandboxConfigModule = await import("../dist/lib/sandbox-config.js");
    const { parseConfigGetArgs } = (sandboxConfigModule.default ?? sandboxConfigModule) as {
      parseConfigGetArgs: (
        args: string[],
      ) =>
        | { ok: true; opts: { key: string | null; format: string } }
        | { ok: false; errors: string[] };
    };

    const missingKey = parseConfigGetArgs(["--key"]);
    expect(missingKey.ok).toBe(false);
    expect(missingKey).toEqual(
      expect.objectContaining({
        errors: expect.arrayContaining([expect.stringContaining("--key requires a value")]),
      }),
    );

    const missingFormat = parseConfigGetArgs(["--format"]);
    expect(missingFormat.ok).toBe(false);
    expect(missingFormat).toEqual(
      expect.objectContaining({
        errors: expect.arrayContaining([expect.stringContaining("--format requires a value")]),
      }),
    );

    const badFormat = parseConfigGetArgs(["--format", "xml"]);
    expect(badFormat.ok).toBe(false);
    expect(badFormat).toEqual(
      expect.objectContaining({
        errors: expect.arrayContaining([expect.stringContaining("Unknown format: xml")]),
      }),
    );

    const unknownFlag = parseConfigGetArgs(["--bogus"]);
    expect(unknownFlag.ok).toBe(false);
    expect(unknownFlag).toEqual(
      expect.objectContaining({
        errors: expect.arrayContaining([expect.stringContaining("Unknown flag: --bogus")]),
      }),
    );

    expect(parseConfigGetArgs(["--key", "gateway.auth", "--format", "yaml"])).toEqual({
      ok: true,
      opts: { key: "gateway.auth", format: "yaml" },
    });
  });

  it("help exits 0 and shows sections", () => {
    const r = run("help");
    expect(r.code).toBe(0);
    expect(r.out.includes("Getting Started")).toBeTruthy();
    expect(r.out.includes("Sandbox Management")).toBeTruthy();
    expect(r.out.includes("Policy Presets")).toBeTruthy();
    expect(r.out.includes("Compatibility Commands")).toBeTruthy();
    expect(r.out).toContain("nemoclaw upgrade-sandboxes");
    expect(r.out).toContain("(--check, --auto, --yes|-y)");
    expect(r.out).toContain("nemoclaw gc");
    expect(r.out).toContain("(--yes|-y|--force, --dry-run)");
    expect(r.out).toContain("nemoclaw onboard");
    expect(r.out).toContain("Configure inference endpoint and credentials");
    expect(r.out).toContain("nemoclaw onboard --from");
    expect(r.out).toContain("Use a custom Dockerfile for the sandbox image");
  });

  it("--help exits 0", () => {
    expect(run("--help").code).toBe(0);
  });

  it("version exits 0", () => {
    const r = run("version");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toMatch(/^nemoclaw v/);
  });

  it("-h exits 0", () => {
    expect(run("-h").code).toBe(0);
  });

  it("no args exits 0 (shows help)", () => {
    const r = run("");
    expect(r.code).toBe(0);
    expect(r.out.includes("nemoclaw")).toBeTruthy();
  });

  it("bare unknown name surfaces sandbox-not-found (#2164)", testTimeoutOptions(35_000), () => {
    // Longer timeout: when openshell is installed but the gateway is down,
    // the CLI probes the gateway before reporting "not found" and the
    // default 10s is not enough for the connection to time out.
    const r = runWithEnv("boguscmd", {}, execTimeout(30_000));
    expect(r.code).toBe(1);
    expect(r.out.includes("Sandbox 'boguscmd' does not exist")).toBeTruthy();
  });

  it("unknown command with non-sandbox action exits 1", () => {
    const r = run("boguscmd boguscmd2");
    expect(r.code).toBe(1);
    expect(r.out.includes("Unknown command")).toBeTruthy();
  });

  it("suggests list for a mistyped list command", () => {
    // Isolate from any real openshell gateway on the host so recovery
    // doesn't intercept the typo suggestion.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-typo-suggest-"));
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      ["#!/usr/bin/env bash", "exit 1"].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("liost", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Unknown command: liost");
    expect(r.out).toContain("Did you mean: nemoclaw list?");
  });

  it("recovers a live sandbox before suggesting a bare command typo", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-recover-typo-"));
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'printf "%s\\n" "$*" >> "$HOME/openshell-calls.log"',
        'case "$*" in',
        '  "status") printf "Status: Connected\\nGateway: nemoclaw\\n"; exit 0 ;;',
        '  "gateway info -g nemoclaw") printf "Gateway: nemoclaw\\n"; exit 0 ;;',
        '  "sandbox list") echo "liost Ready"; exit 0 ;;',
        '  "sandbox get liost") printf "Name: liost\\nPhase: Ready\\nPolicy:\\n"; exit 0 ;;',
        '  "policy get --full liost") exit 1 ;;',
        '  "inference get") exit 1 ;;',
        '  "sandbox connect liost") echo "CONNECTED_LIOST"; exit 0 ;;',
        "  *) exit 0 ;;",
        "esac",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("liost", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
      NEMOCLAW_CONNECT_TIMEOUT: "1",
      NEMOCLAW_NO_CONNECT_HINT: "1",
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("CONNECTED_LIOST");
    expect(r.out).not.toContain("Unknown command: liost");
  });

  it("explains sandbox connect command order when the sandbox name is last", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-order-"));
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home);
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      ["#!/usr/bin/env bash", "exit 1"].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("hermes connect alpha", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out).toContain("Sandbox 'hermes' does not exist");
    expect(r.out).toContain("Command order is: nemoclaw <sandbox-name> connect");
    expect(r.out).toContain("Did you mean: nemoclaw alpha connect?");
  });

  it("list exits 0", () => {
    const r = run("list");
    expect(r.code).toBe(0);
    // With empty HOME, should say no sandboxes
    expect(r.out.includes("No sandboxes")).toBeTruthy();
  });

  it("list --help exits 0 and shows list usage", () => {
    const r = run("list --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("list [--json]");
    expect(r.out).toContain("List all sandboxes");
  });

  it("nemohermes list --help uses alias branding", () => {
    const out = execSync(`node "${HERMES_CLI}" list --help`, {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: execTimeout(),
      env: {
        ...process.env,
        HOME: `/tmp/nemoclaw-cli-test-${Date.now()}`,
      },
    });
    expect(out).toContain("$ nemohermes list [--json]");
    expect(out).not.toContain("$ nemoclaw list [--json]");
  });

  it("list --json emits structured empty inventory", () => {
    const r = run("list --json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      schemaVersion: 1,
      defaultSandbox: null,
      recovery: {
        recoveredFromSession: false,
        recoveredFromGateway: 0,
      },
      lastOnboardedSandbox: null,
      sandboxes: [],
    });
  });

  it("list --json emits structured sandbox details", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-list-json-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "configured-model",
            provider: "configured-provider",
            gpuEnabled: true,
            policies: ["pypi"],
            agent: "openclaw",
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "ps"),
      ["#!/bin/sh", "echo '123 ssh openshell-alpha'", "exit 0"].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("list --json", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      schemaVersion: 1,
      defaultSandbox: "alpha",
      recovery: {
        recoveredFromSession: false,
        recoveredFromGateway: 0,
      },
      lastOnboardedSandbox: null,
      sandboxes: [
        {
          name: "alpha",
          model: "configured-model",
          provider: "configured-provider",
          gpuEnabled: true,
          policies: ["pypi"],
          agent: "openclaw",
          isDefault: true,
          activeSessionCount: 1,
          connected: true,
        },
      ],
    });
  });

  it("list forwards oclif parse errors for unknown options", () => {
    const r = run("list --bogus");
    expect(r.code).toBe(2);
    expect(r.out.includes("Nonexistent flag: --bogus")).toBeTruthy();
    expect(r.out.includes("See more help with --help")).toBeTruthy();
  });

  it("status --help exits 0 and shows status usage", () => {
    const r = run("status --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("status [--json]");
    expect(r.out).toContain("Show sandbox list and service status");
  });

  it("status --json emits parseable structured status without credentials", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-status-json-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const sandboxName = `alpha-${process.pid}-${Date.now()}`;
    const serviceDir = path.join("/tmp", `nemoclaw-services-${sandboxName}`);
    fs.rmSync(serviceDir, { recursive: true, force: true });
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          [sandboxName]: {
            name: sandboxName,
            model: "configured-model",
            provider: "configured-provider",
            gpuEnabled: true,
            policies: ["npm"],
            agent: "openclaw",
            dashboardPort: 18789,
            providerCredentialHashes: {
              OPENAI_API_KEY: "sk-should-not-render-000000000000",
            },
            messagingChannels: ["slack"],
            dashboardUrl: "http://127.0.0.1:18789/?token=dashboard-secret",
            logs: "Bearer should-not-render xoxb-should-not-render-000000",
          },
        },
        defaultSandbox: sandboxName,
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  echo 'Gateway inference:'",
        "  echo",
        "  echo '  Provider: nvidia-prod'",
        "  echo '  Model: nvidia/nemotron'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const r = runWithEnv("status --json", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });

      expect(r.code).toBe(0);
      expect(r.out.trim().startsWith("{")).toBe(true);
      expect(r.out.trim().endsWith("}")).toBe(true);
      expect(r.out).not.toContain("Sandboxes:");
      expect(r.out).not.toContain("(stopped)");

      const parsed = JSON.parse(r.out);
      expect(parsed).toMatchObject({
        schemaVersion: 1,
        defaultSandbox: sandboxName,
        liveInference: {
          provider: "nvidia-prod",
          model: "nvidia/nemotron",
        },
        sandboxes: [
          {
            name: sandboxName,
            model: "nvidia/nemotron",
            provider: "nvidia-prod",
            gpuEnabled: true,
            policies: ["npm"],
            agent: "openclaw",
            dashboardPort: 18789,
            isDefault: true,
          },
        ],
        services: [
          {
            name: "cloudflared",
            running: false,
            pid: null,
          },
        ],
      });
      expect(r.out).not.toMatch(
        /Bearer|nvapi-|sk-|xoxb-|xapp-|password|api[-_]?key|providerCredentialHashes|dashboard-secret|should-not-render/i,
      );
    } finally {
      fs.rmSync(serviceDir, { recursive: true, force: true });
    }
  });

  it("status rejects unknown flags through current dispatch path", () => {
    const r = run("status --bogus");
    expect(r.code).toBe(2);
    expect(r.out).toContain("Nonexistent flag: --bogus");
  });

  it("status rejects unexpected positional arguments through current dispatch path", () => {
    const r = run("status bogus");
    expect(r.code).toBe(2);
    expect(r.out).toContain("Unexpected argument: bogus");
  });

  it("tunnel start --help exits 0 and shows tunnel usage", () => {
    const r = run("tunnel start --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("tunnel start");
    expect(r.out).toContain("Start the cloudflared public-URL tunnel");
  });

  it("deprecated start --help exits 0 and shows alias usage", () => {
    const r = run("start --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("start");
    expect(r.out).toContain("Deprecated alias");
  });

  it("tunnel stop --help exits 0 and shows tunnel usage", () => {
    const r = run("tunnel stop --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("tunnel stop");
    expect(r.out).toContain("Stop the cloudflared public-URL tunnel");
  });

  it("deprecated stop --help exits 0 and shows alias usage", () => {
    const r = run("stop --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("stop");
    expect(r.out).toContain("Deprecated alias");
  });

  it("credentials help exits 0 and shows credential subcommands", () => {
    const r = run("credentials --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage: nemoclaw credentials <subcommand>");
    expect(r.out).toContain("list");
    expect(r.out).toContain("reset <PROVIDER> [--yes]");
  });

  it("credentials list --help exits 0 and shows list usage", () => {
    const r = run("credentials list --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("credentials list");
    expect(r.out).toContain("List provider credentials");
  });

  it("credentials reset without provider keeps provider-specific usage", () => {
    const r = run("credentials reset --yes");
    expect(r.code).toBe(1);
    expect(r.out).toContain("Usage: nemoclaw credentials reset <PROVIDER> [--yes]");
    expect(r.out).toContain("PROVIDER is an OpenShell provider name");
  });

  it("maintenance command help exits 0 and shows migrated usage", () => {
    const backup = run("backup-all --help");
    expect(backup.code).toBe(0);
    expect(backup.out).toContain("backup-all");
    expect(backup.out).toContain("Back up all sandbox state before upgrade");

    const upgrade = run("upgrade-sandboxes --help");
    expect(upgrade.code).toBe(0);
    expect(upgrade.out).toContain("upgrade-sandboxes [--check] [--auto] [--yes|-y]");
    expect(upgrade.out).toContain("Detect and rebuild stale sandboxes");

    const gc = run("gc --help");
    expect(gc.code).toBe(0);
    expect(gc.out).toContain("gc [--dry-run] [--yes|-y|--force]");
    expect(gc.out).toContain("Remove orphaned sandbox Docker images");
  });

  it("maintenance commands dispatch through oclif", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-maintenance-"));
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(
      path.join(localBin, "docker"),
      ["#!/bin/sh", "if [ \"$1\" = \"images\" ]; then exit 0; fi", "exit 0"].join("\n"),
      { mode: 0o755 },
    );

    const backup = runWithEnv("backup-all", { HOME: home });
    expect(backup.code).toBe(0);
    expect(backup.out).toContain("No sandboxes registered. Nothing to back up.");

    const upgrade = runWithEnv("upgrade-sandboxes --check", { HOME: home });
    expect(upgrade.code).toBe(0);
    expect(upgrade.out).toContain("No sandboxes found in the registry.");

    const gc = runWithEnv("gc --dry-run", { HOME: home, PATH: `${localBin}:${process.env.PATH || ""}` });
    expect(gc.code).toBe(0);
    expect(gc.out).toContain("No sandbox images found on the host.");
  });

  it("shows skill install help when --help follows install", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-skill-help-"));
    writeSandboxRegistry(home);

    const r = runWithEnv("alpha skill install --help", { HOME: home });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage: nemoclaw <sandbox> skill install <path>");
    expect(r.out).toContain("Deploy a skill directory");
    expect(r.out).not.toContain("sandbox:skill:install");
    expect(r.out).not.toContain("--help");
    expect(r.out).not.toContain("No SKILL.md found");
  });

  it("requires a skill install path before action dispatch", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-skill-missing-path-"));
    writeSandboxRegistry(home);

    const r = runWithEnv("alpha skill install 2>&1", { HOME: home });

    expect(r.code).not.toBe(0);
    expect(r.out).toContain("path");
  });

  it("points plugin-shaped directories away from skill install", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-plugin-hint-"));
    const pluginDir = path.join(home, "openclaw-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    writeSandboxRegistry(home);
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ name: "demo-plugin", openclaw: { extensions: ["./dist/index.js"] } }),
    );

    const r = runWithEnv(`alpha skill install ${JSON.stringify(pluginDir)}`, { HOME: home });

    expect(r.code).toBe(1);
    expect(r.out).toContain("No SKILL.md found in");
    expect(r.out).toContain("This looks like an OpenClaw plugin");
    expect(r.out).toContain("nemoclaw onboard --from <Dockerfile>");
  });

  it("detects openclaw.plugin.json as a plugin marker", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-plugin-marker-"));
    const pluginDir = path.join(home, "openclaw-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    writeSandboxRegistry(home);
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({ name: "demo" }),
    );

    const r = runWithEnv(`alpha skill install ${JSON.stringify(pluginDir)}`, { HOME: home });

    expect(r.code).toBe(1);
    expect(r.out).toContain("No SKILL.md found in");
    expect(r.out).toContain("This looks like an OpenClaw plugin");
    expect(r.out).toContain("nemoclaw onboard --from <Dockerfile>");
  });

  it(
    "start does not prompt for NVIDIA_API_KEY before launching local services",
    testTimeoutOptions(35_000),
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-start-no-key-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      const markerFile = path.join(home, "start-args");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(
        path.join(registryDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
              policies: [],
            },
          },
          defaultSandbox: "alpha",
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(localBin, "bash"),
        [
          "#!/bin/sh",
          `marker_file=${JSON.stringify(markerFile)}`,
          'printf \'%s\\n\' "$@" > "$marker_file"',
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const r = runWithEnv(
        "start",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
          NVIDIA_API_KEY: "",
          TELEGRAM_BOT_TOKEN: "",
        },
        30000,
      );

      expect(r.code).toBe(0);
      expect(r.out).not.toContain("NVIDIA API Key required");
      // Services module now runs in-process (no bash shelling)
      expect(r.out).toContain("NemoClaw Services");
    },
  );

  it("onboard --help exits 0 and shows usage", () => {
    const r = run("onboard --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("USAGE");
    expect(r.out).toContain("nemoclaw onboard");
    expect(r.out).toContain("--from <Dockerfile>");
  });

  it("unknown onboard option exits 1", () => {
    const r = run("onboard --non-interactiv");
    expect(r.code).toBe(PARSER_EXIT_CODE);
    expect(r.out).toContain("Nonexistent flag: --non-interactiv");
  });

  it("accepts onboard --resume in CLI parsing", () => {
    const r = run("onboard --resume --non-interactiv");
    expect(r.code).toBe(PARSER_EXIT_CODE);
    expect(r.out).toContain("Nonexistent flag: --non-interactiv");
  });

  it("accepts the third-party software flag in onboard CLI parsing", () => {
    const r = run("onboard --yes-i-accept-third-party-software --non-interactiv");
    expect(r.code).toBe(PARSER_EXIT_CODE);
    expect(r.out).toContain("Nonexistent flag: --non-interactiv");
  });

  it("setup --help exits 0 and shows onboard usage", () => {
    const r = run("setup --help");
    expect(r.code).toBe(0);
    expect(r.out.includes("setup` is deprecated")).toBeTruthy();
    expect(r.out.includes("Usage: nemoclaw onboard")).toBeTruthy();
    expect(r.out.includes("Unknown onboard option")).toBeFalsy();
  });

  it("setup forwards unknown options into onboard parsing", () => {
    const r = run("setup --non-interactiv");
    expect(r.code).toBe(PARSER_EXIT_CODE);
    expect(r.out).toContain("Nonexistent flag: --non-interactiv");
  });

  it("setup forwards --resume into onboard parsing", () => {
    const r = run("setup --resume --non-interactive --yes-i-accept-third-party-software");
    expect(r.code).toBe(1);
    expect(r.out.includes("deprecated")).toBeTruthy();
    expect(r.out.includes("No resumable onboarding session was found")).toBeTruthy();
  });

  it("resume rejection clarifies --resume semantics and points to onboard (#2281)", () => {
    const r = run("onboard --resume --non-interactive --yes-i-accept-third-party-software");
    expect(r.code).toBe(1);
    expect(r.out.includes("No resumable onboarding session was found")).toBeTruthy();
    expect(r.out.includes("--resume only continues an interrupted onboarding run")).toBeTruthy();
    expect(
      r.out.includes("To change configuration on an existing sandbox, rebuild it"),
    ).toBeTruthy();
    expect(r.out.includes("nemoclaw onboard")).toBeTruthy();
  });

  it("#2753: refuses non-interactive --resume when sandbox step never completed and no name is provided", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-resume-no-name-"));
    const localBin = path.join(home, "bin");
    const nemoclawDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(nemoclawDir, { recursive: true });
    // Fake openshell so preflight passes and we reach the resume sandbox-name
    // init where the new guard lives.
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "--version" ]; then echo "openshell 0.0.36"; exit 0; fi',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    // Simulates a pre-fix on-disk session that recorded only provider/model
    // (with #2753's onboard fix, sandboxName is no longer written here either).
    fs.writeFileSync(
      path.join(nemoclawDir, "onboard-session.json"),
      JSON.stringify(
        {
          version: 1,
          sessionId: "session-1",
          resumable: true,
          status: "in_progress",
          mode: "interactive",
          startedAt: "2026-05-03T00:00:00.000Z",
          updatedAt: "2026-05-03T00:00:00.000Z",
          lastStepStarted: "inference",
          lastCompletedStep: "inference",
          failure: null,
          sandboxName: null,
          provider: "nvidia-prod",
          model: "nvidia/nemotron-3-super-120b-a12b",
          endpointUrl: null,
          credentialEnv: null,
          preferredInferenceApi: null,
          nimContainer: null,
          policyPresets: null,
          metadata: { gatewayName: "nemoclaw" },
          steps: {
            preflight: { status: "complete", startedAt: null, completedAt: null, error: null },
            gateway: { status: "complete", startedAt: null, completedAt: null, error: null },
            provider_selection: {
              status: "complete",
              startedAt: null,
              completedAt: null,
              error: null,
            },
            inference: { status: "complete", startedAt: null, completedAt: null, error: null },
            sandbox: { status: "pending", startedAt: null, completedAt: null, error: null },
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    const r = runWithEnv(
      "onboard --resume --non-interactive --yes-i-accept-third-party-software",
      {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
        NEMOCLAW_SANDBOX_NAME: "",
      },
    );

    expect(r.code).toBe(1);
    expect(r.out.includes("Cannot resume non-interactive onboard")).toBeTruthy();
    expect(r.out.includes("--name <sandbox>")).toBeTruthy();
  });

  it("#2753: whitespace-only NEMOCLAW_SANDBOX_NAME does not satisfy the resume guard", () => {
    // The env-var ingest pipeline trims and rejects whitespace-only values
    // before populating requestedSandboxName, so the guard sees no recovered
    // name and fires correctly.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-resume-ws-name-"));
    const localBin = path.join(home, "bin");
    const nemoclawDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(nemoclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "--version" ]; then echo "openshell 0.0.36"; exit 0; fi',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(nemoclawDir, "onboard-session.json"),
      JSON.stringify(
        {
          version: 1,
          sessionId: "session-1",
          resumable: true,
          status: "in_progress",
          mode: "interactive",
          startedAt: "2026-05-03T00:00:00.000Z",
          updatedAt: "2026-05-03T00:00:00.000Z",
          lastStepStarted: "inference",
          lastCompletedStep: "inference",
          failure: null,
          sandboxName: null,
          provider: "nvidia-prod",
          model: "nvidia/nemotron-3-super-120b-a12b",
          endpointUrl: null,
          credentialEnv: null,
          preferredInferenceApi: null,
          nimContainer: null,
          policyPresets: null,
          metadata: { gatewayName: "nemoclaw" },
          steps: {
            preflight: { status: "complete", startedAt: null, completedAt: null, error: null },
            gateway: { status: "complete", startedAt: null, completedAt: null, error: null },
            provider_selection: {
              status: "complete",
              startedAt: null,
              completedAt: null,
              error: null,
            },
            inference: { status: "complete", startedAt: null, completedAt: null, error: null },
            sandbox: { status: "pending", startedAt: null, completedAt: null, error: null },
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    const r = runWithEnv(
      "onboard --resume --non-interactive --yes-i-accept-third-party-software",
      {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
        NEMOCLAW_SANDBOX_NAME: "   ",
      },
    );

    expect(r.code).toBe(1);
    expect(r.out.includes("Cannot resume non-interactive onboard")).toBeTruthy();
  });

  it("setup-spark --help exits 0 and shows onboard usage", () => {
    const r = run("setup-spark --help");
    expect(r.code).toBe(0);
    expect(r.out.includes("setup-spark` is deprecated")).toBeTruthy();
    expect(r.out.includes("Use `nemoclaw onboard` instead")).toBeTruthy();
    expect(r.out.includes("Usage: nemoclaw onboard")).toBeTruthy();
    expect(r.out.includes("Unknown onboard option")).toBeFalsy();
  });

  it("setup-spark is a deprecated compatibility alias for onboard", () => {
    const r = run("setup-spark --resume --non-interactive --yes-i-accept-third-party-software");
    expect(r.code).toBe(1);
    expect(r.out.includes("setup-spark` is deprecated")).toBeTruthy();
    expect(r.out.includes("Use `nemoclaw onboard` instead")).toBeTruthy();
    expect(r.out.includes("No resumable onboarding session was found")).toBeTruthy();
  });

  it("deploy --help exits 0 and shows deprecated usage", () => {
    const r = run("deploy --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("deploy [instance-name]");
    expect(r.out).toContain("Deprecated Brev-specific bootstrap path");
  });

  it("debug --help exits 0 and shows usage", () => {
    const r = run("debug --help");
    expect(r.code).toBe(0);
    expect(r.out.includes("Collect NemoClaw diagnostic information")).toBeTruthy();
    expect(r.out.includes("--quick")).toBeTruthy();
    expect(r.out.includes("--output")).toBeTruthy();
  });

  it("debug --quick exits 0 and produces diagnostic output", testTimeoutOptions(30_000), () => {
    const r = runWithEnv(
      "debug --quick",
      createDebugCommandTestEnv("nemoclaw-cli-debug-quick-"),
      30000,
    );
    expect(r.code).toBe(0);
    expect(r.out.includes("Collecting diagnostics")).toBeTruthy();
    expect(r.out.includes("System")).toBeTruthy();
    expect(r.out.includes("Onboard Session")).toBeTruthy();
    expect(r.out.includes("Done")).toBeTruthy();
  });

  it("debug exits 1 on unknown option", () => {
    const r = run("debug --quik");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("Nonexistent flag: --quik");
  });

  it("debug --output without a path is rejected by oclif", () => {
    const r = run("debug --output");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("Flag --output expects a value");
  });

  it("help mentions debug command", () => {
    const r = run("help");
    expect(r.code).toBe(0);
    expect(r.out.includes("Troubleshooting")).toBeTruthy();
    expect(r.out.includes("nemoclaw debug")).toBeTruthy();
  });

  it("debug --sandbox NAME targets the specified sandbox", testTimeoutOptions(30_000), () => {
    const r = runWithEnv(
      "debug --quick --sandbox mybox",
      createDebugCommandTestEnv("nemoclaw-cli-debug-sandbox-"),
      30000,
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("Collecting diagnostics for sandbox 'mybox'");
  });

  it("debug --sandbox without a name exits 1", () => {
    const r = run("debug --sandbox");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("--sandbox");
  });

  it("debug warns when default sandbox is stale", testTimeoutOptions(), () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-stale-"));
    fs.mkdirSync(path.join(home, ".nemoclaw"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".nemoclaw", "sandboxes.json"),
      JSON.stringify({ sandboxes: {}, defaultSandbox: "ghost" }),
      { mode: 0o600 },
    );
    const r = runWithEnv("debug --quick 2>&1", { HOME: home });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Warning");
    expect(r.out).toContain("ghost");
    expect(r.out).toContain("--sandbox NAME");
  });

  it("debug --sandbox skips stale default warning", testTimeoutOptions(), () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-stale-"));
    fs.mkdirSync(path.join(home, ".nemoclaw"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".nemoclaw", "sandboxes.json"),
      JSON.stringify({ sandboxes: {}, defaultSandbox: "ghost" }),
      { mode: 0o600 },
    );
    const r = runWithEnv("debug --quick --sandbox mybox 2>&1", { HOME: home });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("default sandbox 'ghost'");
    expect(r.out).not.toContain("--sandbox NAME");
    expect(r.out).toContain("Collecting diagnostics for sandbox 'mybox'");
  });

  it("gateway-token help keeps the public sandbox-scoped usage", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-token-help-"));
    writeSandboxRegistry(home);

    const r = runWithEnv("alpha gateway-token --help", { HOME: home });

    expect(r.code).toBe(0);
    expect(r.out).toContain("$ nemoclaw <name> gateway-token [--quiet|-q]");
    expect(r.out).not.toContain("sandbox:gateway");
  });

  it("doctor fails a present sandbox that is not Ready", () => {
    const setup = createDoctorTestSetup("nemoclaw-cli-doctor-not-ready-", [
      'case "$*" in',
      '  "status") printf "Server Status\\n\\n  Gateway: nemoclaw\\n  Status: Connected\\n"; exit 0 ;;',
      '  "gateway info -g nemoclaw") printf "Gateway: nemoclaw\\n"; exit 0 ;;',
      '  "sandbox list") printf "NAME STATUS\\nalpha Creating\\n"; exit 0 ;;',
      '  "inference get") printf "Provider: nvidia-prod\\nModel: test-model\\n"; exit 0 ;;',
      "esac",
    ]);

    const r = setup.runDoctor();

    expect(r.code).toBe(1);
    const report = JSON.parse(r.out) as {
      checks: Array<{ label: string; status: string; detail: string }>;
    };
    const liveSandbox = report.checks.find((check) => check.label === "Live sandbox");
    expect(liveSandbox).toEqual(
      expect.objectContaining({
        status: "fail",
        detail: expect.stringContaining("Creating"),
      }),
    );
  });

  it("doctor does not query sandbox state from a different active gateway", () => {
    const setup = createDoctorTestSetup("nemoclaw-cli-doctor-wrong-gateway-", [
      'case "$*" in',
      '  "status") printf "Server Status\\n\\n  Gateway: other\\n  Status: Connected\\n"; exit 0 ;;',
      '  "gateway info -g nemoclaw") printf "Gateway: nemoclaw\\n"; exit 0 ;;',
      '  "gateway select nemoclaw") exit 1 ;;',
      '  "gateway start --name nemoclaw --port 8080") exit 1 ;;',
      '  "sandbox list") echo "queried wrong gateway sandbox list" >> "$marker_file"; exit 0 ;;',
      "esac",
    ]);

    const r = setup.runDoctor("alpha doctor");

    expect(r.code).toBe(1);
    expect(r.out).toContain("OpenShell status");
    expect(r.out).toContain("Gateway: other");
    expect(setup.readCalls().some((call) => /^sandbox list(\s|$)/.test(call))).toBe(false);
  });

  it("doctor treats a live non-cloudflared PID as stale", () => {
    const { sandboxName, serviceDir } = createCloudflaredServiceDir("doctorpid-");
    const setup = createDoctorTestSetup(
      "nemoclaw-cli-doctor-wrong-cloudflared-pid-",
      [
        'case "$*" in',
        '  "status") printf "Server Status\\n\\n  Gateway: nemoclaw\\n  Status: Connected\\n"; exit 0 ;;',
        '  "gateway info -g nemoclaw") printf "Gateway: nemoclaw\\n"; exit 0 ;;',
        `  "sandbox list") printf "NAME STATUS\\n${sandboxName} Ready\\n"; exit 0 ;;`,
        '  "inference get") printf "Provider: nvidia-prod\\nModel: test-model\\n"; exit 0 ;;',
        "esac",
      ],
      sandboxName,
    );
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    const sleeperPid = sleeper.pid;
    if (typeof sleeperPid !== "number") {
      throw new Error("expected spawned helper process to have a PID");
    }

    try {
      fs.writeFileSync(path.join(serviceDir, "cloudflared.pid"), String(sleeperPid));
      const r = setup.runDoctor(`${sandboxName} doctor --json`);

      const report = JSON.parse(r.out) as {
        checks: Array<{ label: string; status: string; detail: string }>;
      };
      const cloudflared = report.checks.find((check) => check.label === "cloudflared");
      expect(cloudflared).toEqual(
        expect.objectContaining({
          status: "warn",
          detail: `stale PID ${sleeperPid}`,
        }),
      );
    } finally {
      sleeper.kill();
      fs.rmSync(serviceDir, { recursive: true, force: true });
    }
  });

  it("doctor accepts a live cloudflared PID", () => {
    const { sandboxName, serviceDir } = createCloudflaredServiceDir("doctorcloudflared-");
    const setup = createDoctorTestSetup(
      "nemoclaw-cli-doctor-cloudflared-pid-",
      [
        'case "$*" in',
        '  "status") printf "Server Status\\n\\n  Gateway: nemoclaw\\n  Status: Connected\\n"; exit 0 ;;',
        '  "gateway info -g nemoclaw") printf "Gateway: nemoclaw\\n"; exit 0 ;;',
        `  "sandbox list") printf "NAME STATUS\\n${sandboxName} Ready\\n"; exit 0 ;;`,
        '  "inference get") printf "Provider: nvidia-prod\\nModel: test-model\\n"; exit 0 ;;',
        "esac",
      ],
      sandboxName,
    );
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cloudflared-shim-"));
    const cloudflaredBin = path.join(shimDir, "cloudflared");
    fs.symlinkSync(process.execPath, cloudflaredBin);
    const sleeper = spawn(cloudflaredBin, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    const sleeperPid = sleeper.pid;
    if (typeof sleeperPid !== "number") {
      throw new Error("expected spawned helper process to have a PID");
    }

    try {
      fs.writeFileSync(path.join(serviceDir, "cloudflared.pid"), String(sleeperPid));
      const r = setup.runDoctor(`${sandboxName} doctor --json`);

      const report = JSON.parse(r.out) as {
        checks: Array<{ label: string; status: string; detail: string }>;
      };
      const cloudflared = report.checks.find((check) => check.label === "cloudflared");
      expect(cloudflared).toEqual(
        expect.objectContaining({
          status: "ok",
          detail: `running (PID ${sleeperPid})`,
        }),
      );
    } finally {
      sleeper.kill();
      fs.rmSync(serviceDir, { recursive: true, force: true });
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  it("sandbox inspection help keeps public sandbox-scoped usage", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-inspection-help-"));
    writeSandboxRegistry(home);

    const connect = runWithEnv("alpha connect --help", { HOME: home });
    expect(connect.code).toBe(0);
    expect(connect.out).toContain("Usage: nemoclaw alpha connect");
    expect(connect.out).not.toContain("sandbox:connect");

    const status = runWithEnv("alpha status --help", { HOME: home });
    expect(status.code).toBe(0);
    expect(status.out).toContain("<name> status");
    expect(status.out).not.toContain("sandbox:status");

    const doctor = runWithEnv("alpha doctor --help", { HOME: home });
    expect(doctor.code).toBe(0);
    expect(doctor.out).toContain("<name> doctor [--json]");
    expect(doctor.out).not.toContain("sandbox:doctor");

    const logs = runWithEnv("alpha logs --help", { HOME: home });
    expect(logs.code).toBe(0);
    expect(logs.out).toContain("<name> logs");
    expect(logs.out).toContain("--follow");
    expect(logs.out).toContain("--tail");
    expect(logs.out).toContain("--since");
    expect(logs.out).not.toContain("sandbox:logs");

    const destroy = runWithEnv("alpha destroy --help", { HOME: home });
    expect(destroy.code).toBe(0);
    expect(destroy.out).toContain("<name> destroy [--yes|-y|--force]");
    expect(destroy.out).not.toContain("sandbox:destroy");

    const rebuild = runWithEnv("alpha rebuild --help", { HOME: home });
    expect(rebuild.code).toBe(0);
    expect(rebuild.out).toContain("<name> rebuild [--yes|-y|--force] [--verbose|-v]");
    expect(rebuild.out).not.toContain("sandbox:rebuild");

    for (const action of ["policy-add", "policy-remove", "policy-list"]) {
      const policy = runWithEnv(`alpha ${action} --help`, { HOME: home });
      expect(policy.code).toBe(0);
      expect(policy.out).toContain(`<name> ${action}`);
      expect(policy.out).not.toContain(`sandbox:${action}`);
    }

    const channels = runWithEnv("alpha channels list --help", { HOME: home });
    expect(channels.code).toBe(0);
    expect(channels.out).toContain("<name> channels list");
    expect(channels.out).not.toContain("sandbox:channels:list");

    for (const subcommand of ["add", "remove", "stop", "start"]) {
      const result = runWithEnv(`alpha channels ${subcommand} --help`, { HOME: home });
      expect(result.code).toBe(0);
      expect(result.out).toContain(`<name> channels ${subcommand}`);
      expect(result.out).not.toContain(`sandbox:channels:${subcommand}`);
    }

    const config = runWithEnv("alpha config get --help", { HOME: home });
    expect(config.code).toBe(0);
    expect(config.out).toContain("<name> config get");
    expect(config.out).toContain("--format json|yaml");
    expect(config.out).not.toContain("sandbox:config:get");
  });

  it("policy mutation dry-run paths dispatch through oclif", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-policy-dry-run-"));
    writeSandboxRegistry(home);

    const add = runWithEnv("alpha policy-add github --dry-run", { HOME: home });
    expect(add.code).toBe(0);
    expect(add.out).toContain("--dry-run: no changes applied.");

    const registryPath = path.join(home, ".nemoclaw", "sandboxes.json");
    const registryJson = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    registryJson.sandboxes.alpha.policies = ["github"];
    fs.writeFileSync(registryPath, JSON.stringify(registryJson), { mode: 0o600 });

    const remove = runWithEnv("alpha policy-remove github --dry-run", { HOME: home });
    expect(remove.code).toBe(0);
    expect(remove.out).toContain("--dry-run: no changes applied.");
  });

  it("channels mutation dry-run paths dispatch through oclif", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-channels-dry-run-"));
    writeSandboxRegistry(home);

    const add = runWithEnv("alpha channels add telegram --dry-run", { HOME: home });
    expect(add.code).toBe(0);
    expect(add.out).toContain("--dry-run: would enable channel 'telegram' for 'alpha'.");

    const remove = runWithEnv("alpha channels remove telegram --dry-run", { HOME: home });
    expect(remove.code).toBe(0);
    expect(remove.out).toContain("--dry-run: would remove channel 'telegram' for 'alpha'.");

    const stop = runWithEnv("alpha channels stop telegram --dry-run", { HOME: home });
    expect(stop.code).toBe(0);
    expect(stop.out).toContain("--dry-run: would stop channel 'telegram' for 'alpha'.");

    const start = runWithEnv("alpha channels start telegram --dry-run", { HOME: home });
    expect(start.code).toBe(0);
    expect(start.out).toContain("Channel 'telegram' is already enabled for 'alpha'. Nothing to do.");
  });

  it("supports oclif-native sandbox command forms", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-native-sandbox-"));
    writeSandboxRegistry(home);

    const statusHelp = runWithEnv("sandbox status alpha --help", { HOME: home });
    expect(statusHelp.code).toBe(0);
    expect(statusHelp.out).toContain("$ nemoclaw sandbox status <name>");
    expect(statusHelp.out).not.toContain("Sandbox 'sandbox' does not exist");

    const policy = runWithEnv("sandbox policy add alpha github --dry-run", { HOME: home });
    expect(policy.code).toBe(0);
    expect(policy.out).toContain("--dry-run: no changes applied.");

    const channels = runWithEnv("sandbox channels add alpha telegram --dry-run", { HOME: home });
    expect(channels.code).toBe(0);
    expect(channels.out).toContain("--dry-run: would enable channel 'telegram' for 'alpha'.");

    const snapshots = runWithEnv("sandbox snapshot list alpha", { HOME: home });
    expect(snapshots.code).toBe(0);
    expect(snapshots.out).toContain("No snapshots found for 'alpha'.");
  });

  it("policy and channel mutations reject missing parser-owned values before dispatch", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-mutation-missing-values-"));
    writeSandboxRegistry(home);

    const missingPolicyFile = runWithEnv("alpha policy-add --from-file 2>&1", { HOME: home });
    expect(missingPolicyFile.code).not.toBe(0);
    expect(missingPolicyFile.out).toContain("--from-file");

    const missingChannel = runWithEnv("alpha channels add 2>&1", { HOME: home });
    expect(missingChannel.code).not.toBe(0);
    expect(missingChannel.out).toContain("channel");
  });

  it("diagnostic commands reject invalid parser-owned flags before dispatch", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-diagnostics-invalid-flags-"));
    writeSandboxRegistry(home);

    const badConfigFormat = runWithEnv("alpha config get --format xml 2>&1", { HOME: home });
    expect(badConfigFormat.code).not.toBe(0);
    expect(badConfigFormat.out).toContain("--format");
    expect(badConfigFormat.out).toContain("json");
    expect(badConfigFormat.out).toContain("yaml");

    const badDoctorFlag = runWithEnv("alpha doctor --bogus 2>&1", { HOME: home });
    expect(badDoctorFlag.code).not.toBe(0);
    expect(badDoctorFlag.out).toContain("Nonexistent flag: --bogus");
  });

  it("shields help keeps public sandbox-scoped usage", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-shields-help-"));
    writeSandboxRegistry(home);

    const down = runWithEnv("alpha shields down --help", { HOME: home });
    expect(down.code).toBe(0);
    expect(down.out).toContain("<name> shields down");
    expect(down.out).not.toContain("sandbox:shields:down");

    const up = runWithEnv("alpha shields up --help", { HOME: home });
    expect(up.code).toBe(0);
    expect(up.out).toContain("<name> shields up");
    expect(up.out).not.toContain("sandbox:shields:up");

    const status = runWithEnv("alpha shields status --help", { HOME: home });
    expect(status.code).toBe(0);
    expect(status.out).toContain("<name> shields status");
    expect(status.out).not.toContain("sandbox:shields:status");
  });

  it("snapshot subcommand help keeps public sandbox-scoped usage", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-snapshot-help-"));
    writeSandboxRegistry(home);

    const parent = runWithEnv("alpha snapshot --help", { HOME: home });
    expect(parent.code).toBe(0);
    expect(parent.out).toContain("nemoclaw alpha snapshot create");
    expect(parent.out).toContain("nemoclaw alpha snapshot list");
    expect(parent.out).not.toContain("sandbox:snapshot");

    const list = runWithEnv("alpha snapshot list --help", { HOME: home });
    expect(list.code).toBe(0);
    expect(list.out).toContain("<name> snapshot list");
    expect(list.out).not.toContain("sandbox:snapshot:list");

    const create = runWithEnv("alpha snapshot create --help", { HOME: home });
    expect(create.code).toBe(0);
    expect(create.out).toContain("<name> snapshot create [--name <name>]");
    expect(create.out).not.toContain("sandbox:snapshot:create");

    const restore = runWithEnv("alpha snapshot restore --help", { HOME: home });
    expect(restore.code).toBe(0);
    expect(restore.out).toContain("<name> snapshot restore [selector] [--to <dst>]");
    expect(restore.out).not.toContain("sandbox:snapshot:restore");
  });

  it("snapshot list dispatches through oclif", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-snapshot-list-"));
    writeSandboxRegistry(home);

    const r = runWithEnv("alpha snapshot list", { HOME: home });
    expect(r.code).toBe(0);
    expect(r.out).toContain("No snapshots found for 'alpha'.");
  });

  it("unknown snapshot subcommands fail before action dispatch", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-snapshot-unknown-"));
    writeSandboxRegistry(home);

    const r = runWithEnv("alpha snapshot bogus 2>&1", { HOME: home });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("Unexpected argument: bogus");
  });

  it("routes logs to OpenClaw and OpenShell log sources", () => {
    const setup = createLogsTestSetup("nemoclaw-cli-logs-routing-");
    const r = setup.runLogs();

    const calls = setup.readCalls();
    expect(r.code).toBe(0);
    expect(calls).toEqual([
      "settings set alpha --key ocsf_json_enabled --value true",
      "sandbox exec -n alpha -- tail -n 200 /tmp/gateway.log",
      "logs alpha -n 200 --source all",
    ]);
    expect(r.out).toContain(FAKE_OPENCLAW_LOG_LINE);
    expect(r.out).toContain(FAKE_OPENSHELL_LOG_LINE);
  });

  it("shows logs help without calling OpenShell", () => {
    const setup = createLogsTestSetup("nemoclaw-cli-logs-help-");
    const r = setup.runLogs("alpha logs --help");

    expect(r.code).toBe(0);
    expect(r.out).toContain("<name> logs");
    expect(r.out).toContain("--follow");
    expect(r.out).toContain("--tail");
    expect(r.out).toContain("--since");
    expect(setup.readCalls()).toEqual([]);
  });

  it("passes --tail line count to both log sources", () => {
    const setup = createLogsTestSetup("nemoclaw-cli-logs-tail-");
    const r = setup.runLogs("alpha logs --tail 50");

    const calls = setup.readCalls();
    expect(r.code).toBe(0);
    expect(calls).toEqual([
      "settings set alpha --key ocsf_json_enabled --value true",
      "sandbox exec -n alpha -- tail -n 50 /tmp/gateway.log",
      "logs alpha -n 50 --source all",
    ]);
  });

  it("passes -n line count to both log sources", () => {
    const setup = createLogsTestSetup("nemoclaw-cli-logs-n-");
    const r = setup.runLogs("alpha logs -n 25");

    const calls = setup.readCalls();
    expect(r.code).toBe(0);
    expect(calls).toEqual([
      "settings set alpha --key ocsf_json_enabled --value true",
      "sandbox exec -n alpha -- tail -n 25 /tmp/gateway.log",
      "logs alpha -n 25 --source all",
    ]);
  });

  it("passes --since to OpenShell logs without an unfiltered gateway tail", () => {
    const setup = createLogsTestSetup("nemoclaw-cli-logs-since-");
    const r = setup.runLogs("alpha logs --since 5m");

    const calls = setup.readCalls();
    expect(r.code).toBe(0);
    expect(calls).toEqual([
      "settings set alpha --key ocsf_json_enabled --value true",
      "logs alpha -n 200 --source all --since 5m",
    ]);
    expect(calls.some((call) => call.startsWith("sandbox exec -n alpha"))).toBe(false);
  });

  it("passes --follow --since to OpenShell logs without an unfiltered gateway tail", () => {
    const setup = createLogsTestSetup("nemoclaw-cli-logs-since-follow-");
    const r = setup.runLogs("alpha logs --follow --since 5m");

    const calls = setup.readCalls();
    expect(r.code).toBe(0);
    expect(calls).toContain("settings set alpha --key ocsf_json_enabled --value true");
    expect(calls).toContain("logs alpha -n 200 --source all --since 5m --tail");
    expect(calls.some((call) => call.startsWith("sandbox exec -n alpha"))).toBe(false);
  });

  it("rejects malformed logs flags before calling OpenShell", () => {
    const setup = createLogsTestSetup("nemoclaw-cli-logs-malformed-");
    const missingTail = setup.runLogs("alpha logs --tail 2>&1");
    const zeroTail = setup.runLogs("alpha logs --tail 0 2>&1");
    const nonNumericTail = setup.runLogs("alpha logs -n foo 2>&1");
    const missingSince = setup.runLogs("alpha logs --since 2>&1");
    const malformedSince = setup.runLogs("alpha logs --since someday 2>&1");

    for (const result of [missingTail, zeroTail, nonNumericTail, missingSince, malformedSince]) {
      expect(result.code).not.toBe(0);
    }
    expect(missingTail.out).toContain("--tail");
    expect(zeroTail.out).toContain("--tail");
    expect(nonNumericTail.out).toContain("Expected an integer");
    expect(missingSince.out).toContain("--since");
    expect(malformedSince.out).toContain("--since requires a positive duration");
    expect(setup.readCalls()).toEqual([]);
  });

  it("rejects unknown logs flags before calling OpenShell", () => {
    const setup = createLogsTestSetup("nemoclaw-cli-logs-unknown-");
    const r = setup.runLogs("alpha logs --bogus 2>&1");

    expect(r.code).not.toBe(0);
    expect(r.out).toContain("Nonexistent flag: --bogus");
    expect(setup.readCalls()).toEqual([]);
  });

  it("enables OpenShell audit events before reading logs", () => {
    const setup = createLogsTestSetup("nemoclaw-cli-logs-audit-");
    const r = setup.runLogs();

    const calls = setup.readCalls();
    expect(r.code).toBe(0);
    expect(calls[0]).toBe("settings set alpha --key ocsf_json_enabled --value true");
    expect(r.out).toContain(FAKE_OPENSHELL_LOG_LINE);
  });

  it("warns when OpenShell audit events cannot be enabled", () => {
    const setup = createLogsTestSetup("nemoclaw-cli-logs-audit-failed-", [
      'if [ "$1" = "settings" ]; then',
      "  echo 'settings unavailable' >&2",
      "  exit 7",
      "fi",
    ]);

    const r = setup.runLogs("alpha logs 2>&1");

    expect(r.code).toBe(0);
    expect(r.out).toContain("failed to enable OpenShell audit logs for sandbox 'alpha'");
    expect(r.out).toContain("openshell settings set alpha --key ocsf_json_enabled --value true");
    expect(r.out).toContain("settings unavailable");
    expect(r.out).toContain(FAKE_OPENCLAW_LOG_LINE);
    expect(r.out).toContain(FAKE_OPENSHELL_LOG_LINE);
  });

  it("continues log collection when audit enable times out", () => {
    const setup = createLogsTestSetup("nemoclaw-cli-logs-audit-timeout-", [
      'if [ "$1" = "settings" ]; then',
      "  sleep 5",
      "  exit 0",
      "fi",
    ]);

    const r = setup.runLogs("alpha logs 2>&1", { NEMOCLAW_LOGS_PROBE_TIMEOUT_MS: "1500" });

    expect(r.code).toBe(0);
    expect(r.out).toContain("failed to enable OpenShell audit logs for sandbox 'alpha'");
    expect(r.out).toContain("ETIMEDOUT");
    expect(r.out).toContain(FAKE_OPENCLAW_LOG_LINE);
    expect(r.out).toContain(FAKE_OPENSHELL_LOG_LINE);
  });

  it("continues to OpenShell logs when the OpenClaw gateway log probe times out", () => {
    const setup = createLogsTestSetup("nemoclaw-cli-logs-openclaw-timeout-", [
      'if [ "$1" = "sandbox" ]; then',
      "  sleep 2",
      "  exit 0",
      "fi",
    ]);

    const r = setup.runLogs("alpha logs 2>&1", { NEMOCLAW_LOGS_PROBE_TIMEOUT_MS: "500" });

    expect(r.code).toBe(0);
    expect(r.out).toContain("OpenClaw log source unavailable");
    expect(r.out).toContain("ETIMEDOUT");
    expect(r.out).toContain(FAKE_OPENSHELL_LOG_LINE);
  });

  it("maps --follow to OpenShell live log streaming", () => {
    const setup = createLogsTestSetup("nemoclaw-cli-logs-follow-");
    const r = setup.runLogs("alpha logs --follow");

    const calls = setup.readCalls();
    expect(r.code).toBe(0);
    expect(calls).toContain("settings set alpha --key ocsf_json_enabled --value true");
    expect(calls).toContain("sandbox exec -n alpha -- tail -n 200 -f /tmp/gateway.log");
    expect(calls).toContain("logs alpha -n 200 --source all --tail");
    expect(r.out).toContain(FAKE_OPENCLAW_LOG_LINE);
    expect(r.out).toContain(FAKE_OPENSHELL_LOG_LINE);
  });

  it("starts OpenClaw logs before enabling audit logs for logs --follow", () => {
    const setup = createLogsTestSetup("nemoclaw-cli-logs-follow-audit-slow-", [
      'if [ "$1" = "settings" ]; then',
      "  sleep 1",
      "  exit 0",
      "fi",
    ]);

    const start = Date.now();
    const r = setup.runLogs("alpha logs --follow", { NEMOCLAW_LOGS_PROBE_TIMEOUT_MS: "2000" });
    const calls = setup.readCalls();

    expect(Date.now() - start).toBeGreaterThanOrEqual(900);
    expect(r.code).toBe(0);
    // All three calls must happen: OpenClaw log stream, audit enable, OpenShell log stream.
    expect(calls).toContain("sandbox exec -n alpha -- tail -n 200 -f /tmp/gateway.log");
    expect(calls).toContain("settings set alpha --key ocsf_json_enabled --value true");
    expect(calls).toContain("logs alpha -n 200 --source all --tail");
    // Audit enable must complete before OpenShell logs start (both are synchronous
    // relative to each other). We can't assert ordering vs the OpenClaw spawn
    // because spawn() is async and marker-file write order is racy.
    const auditIdx = calls.indexOf("settings set alpha --key ocsf_json_enabled --value true");
    const openshellIdx = calls.indexOf("logs alpha -n 200 --source all --tail");
    expect(auditIdx).toBeLessThan(openshellIdx);
    expect(r.out).toContain(FAKE_OPENCLAW_LOG_LINE);
    expect(r.out).toContain(FAKE_OPENSHELL_LOG_LINE);
  });

  it("keeps logs --follow running when one log source exits", testTimeoutOptions(), async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-logs-follow-source-exit-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const markerFile = path.join(home, "logs-follow-source-exit-args");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `marker_file=${JSON.stringify(markerFile)}`,
        'printf \'%s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "settings" ]; then',
        "  exit 0",
        "fi",
        'if [ "$1" = "logs" ]; then',
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ]; then',
        "  trap 'exit 0' TERM INT",
        "  while true; do sleep 1; done",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const child = spawn(process.execPath, [CLI, "alpha", "logs", "--follow"], {
      cwd: path.join(import.meta.dirname, ".."),
      env: { ...process.env, HOME: home, PATH: `${localBin}:${process.env.PATH || ""}` },
      stdio: "ignore",
    });
    const exitPromise = waitForChildExit(child);
    const readCalls = () =>
      fs.existsSync(markerFile) ? fs.readFileSync(markerFile, "utf8").trim().split(/\n/) : [];

    try {
      let calls: string[] = [];
      const pollTimeoutMs = Math.min(testTimeout(10_000), Math.max(1_000, testTimeout() - 5_000));
      const deadline = Date.now() + pollTimeoutMs;
      while (Date.now() < deadline) {
        calls = readCalls();
        if (
          calls.includes("logs alpha -n 200 --source all --tail") &&
          calls.includes("sandbox exec -n alpha -- tail -n 200 -f /tmp/gateway.log")
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(isChildRunning(child)).toBe(true);
      expect(calls).toContain("logs alpha -n 200 --source all --tail");
      expect(calls).toContain("sandbox exec -n alpha -- tail -n 200 -f /tmp/gateway.log");
    } finally {
      if (isChildRunning(child)) {
        child.kill("SIGTERM");
      }
      expect(await exitPromise).toBe(143);
    }
  });

  it("waits for logs --follow children to stop after SIGTERM", testTimeoutOptions(), async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-logs-follow-sigterm-wait-"));
    const localBin = path.join(home, "bin");
    const markerFile = path.join(home, "logs-follow-sigterm-wait-args");
    const releaseFile = path.join(home, "release-log-children");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home);
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `marker_file=${JSON.stringify(markerFile)}`,
        `release_file=${JSON.stringify(releaseFile)}`,
        'printf \'%s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "settings" ]; then',
        "  exit 0",
        "fi",
        'if [ "$1" = "logs" ] || [ "$1" = "sandbox" ]; then',
        "  trap 'printf \"%s term-start\\n\" \"$*\" >> \"$marker_file\"; while [ ! -f \"$release_file\" ]; do sleep 0.05; done; printf \"%s term-end\\n\" \"$*\" >> \"$marker_file\"; exit 0' TERM INT",
        "  while true; do sleep 1; done",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const child = spawn(process.execPath, [CLI, "alpha", "logs", "--follow"], {
      cwd: path.join(import.meta.dirname, ".."),
      env: { ...process.env, HOME: home, PATH: `${localBin}:${process.env.PATH || ""}` },
      stdio: "ignore",
    });
    let hasExited = false;
    const exitPromise = waitForChildExit(child).then((code) => {
      hasExited = true;
      return code;
    });
    const readCalls = () =>
      fs.existsSync(markerFile) ? fs.readFileSync(markerFile, "utf8").trim().split(/\n/) : [];

    try {
      let calls: string[] = [];
      const pollTimeoutMs = Math.min(testTimeout(10_000), Math.max(1_000, testTimeout() - 5_000));
      const deadline = Date.now() + pollTimeoutMs;
      while (Date.now() < deadline) {
        calls = readCalls();
        if (
          calls.includes("logs alpha -n 200 --source all --tail") &&
          calls.includes("sandbox exec -n alpha -- tail -n 200 -f /tmp/gateway.log")
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(calls).toContain("logs alpha -n 200 --source all --tail");
      expect(calls).toContain("sandbox exec -n alpha -- tail -n 200 -f /tmp/gateway.log");
      child.kill("SIGTERM");

      let callsAfterTerm: string[] = [];
      const termDeadline = Date.now() + Math.min(testTimeout(5_000), Math.max(1_000, testTimeout() - 5_000));
      while (Date.now() < termDeadline) {
        callsAfterTerm = readCalls();
        if (callsAfterTerm.some((call) => call.endsWith("term-start")) || hasExited) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(callsAfterTerm.some((call) => call.endsWith("term-start"))).toBe(true);
      expect(hasExited).toBe(false);
      fs.writeFileSync(releaseFile, "1");
      expect(await exitPromise).toBe(143);
    } finally {
      fs.writeFileSync(releaseFile, "1");
      if (isChildRunning(child)) {
        child.kill("SIGKILL");
      }
    }
  });

  it("uses named sandbox exec for bridge status helpers", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-status-messaging-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const markerFile = path.join(home, "openshell.log");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
            messagingChannels: ["telegram"],
            agent: "hermes",
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `marker_file=${JSON.stringify(markerFile)}`,
        'printf \'%s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ]; then',
        '  if [ "$8" = "tail -n 200 /tmp/gateway.log 2>/dev/null | grep -cE \\"getUpdates conflict|409[[:space:]:]+Conflict\\" || true" ]; then',
        "    echo 1",
        "    exit 0",
        "  fi",
        '  if [ "$8" = "tail -n 10 /tmp/gateway.log 2>/dev/null" ]; then',
        "    echo 'getUpdates conflict'",
        "    exit 0",
        "  fi",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("status", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    const log = fs.readFileSync(markerFile, "utf8");
    expect(r.code).toBe(0);
    expect(log).toContain(
      'sandbox exec -n alpha -- sh -c tail -n 200 /tmp/gateway.log 2>/dev/null | grep -cE "getUpdates conflict|409[[:space:]:]+Conflict" || true',
    );
    expect(log).toContain("sandbox exec -n alpha -- sh -c tail -n 10 /tmp/gateway.log 2>/dev/null");
    expect(log).not.toContain("sandbox exec alpha sh -c");
  });

  it("destroys the gateway runtime when the last sandbox is removed", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-last-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "docker.log");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\n" >> "$log_file"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy -y", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("sandbox delete alpha");
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("NAME STATUS");
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("forward stop 18789");
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("gateway destroy -g nemoclaw");
    expect(fs.readFileSync(bashLog, "utf8")).toContain("volume ls -q --filter");
  });

  it("keeps the gateway runtime when other sandboxes still exist", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-shared-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "docker.log");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
          beta: {
            name: "beta",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\nbeta Ready\\n" >> "$log_file"',
        '  printf "NAME STATUS\\nbeta Ready\\n"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("sandbox delete alpha");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("forward stop 18789");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway destroy -g nemoclaw");
    if (fs.existsSync(bashLog)) {
      expect(fs.readFileSync(bashLog, "utf8")).not.toContain("volume ls -q --filter");
    }
  });

  it("keeps the gateway runtime when the live gateway still reports sandboxes", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-live-shared-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "docker.log");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\nbeta Ready\\n" >> "$log_file"',
        '  printf "NAME STATUS\\nbeta Ready\\n"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("sandbox delete alpha");
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("beta Ready");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("forward stop 18789");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway destroy -g nemoclaw");
    if (fs.existsSync(bashLog)) {
      expect(fs.readFileSync(bashLog, "utf8")).not.toContain("volume ls -q --filter");
    }
  });

  it("fails destroy when openshell sandbox delete returns a real error", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-failure-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "delete" ]; then',
        '  echo "transport error: gateway unavailable" >&2',
        "  exit 1",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out).toContain("transport error: gateway unavailable");
    expect(r.out).toContain("Failed to destroy sandbox 'alpha'.");
    expect(r.out).not.toContain("Sandbox 'alpha' destroyed");

    const registryAfter = JSON.parse(
      fs.readFileSync(path.join(registryDir, "sandboxes.json"), "utf8"),
    );
    expect(registryAfter.sandboxes.alpha).toBeTruthy();
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("sandbox delete alpha");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway destroy -g nemoclaw");
  });

  it("treats an already-missing sandbox as destroyed and clears the stale registry entry", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-missing-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "docker.log");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "delete" ]; then',
        '  printf \'%s\\n\' "$*" >> "$log_file"',
        '  echo "Error: status: Not Found, message: \\"sandbox not found\\"" >&2',
        "  exit 1",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\n" >> "$log_file"',
        '  printf "NAME STATUS\\n"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("already absent from the live gateway");
    expect(r.out).toContain("Sandbox 'alpha' destroyed");

    const registryAfter = JSON.parse(
      fs.readFileSync(path.join(registryDir, "sandboxes.json"), "utf8"),
    );
    expect(registryAfter.sandboxes.alpha).toBeFalsy();
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("sandbox delete alpha");
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("forward stop 18789");
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("gateway destroy -g nemoclaw");
    expect(fs.readFileSync(bashLog, "utf8")).toContain("volume ls -q --filter");
  });

  it("deletes messaging providers when destroying a sandbox", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-providers-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "docker.log");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\n" >> "$log_file"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    const log = fs.readFileSync(openshellLog, "utf8");
    expect(log).toContain("provider delete alpha-telegram-bridge");
    expect(log).toContain("provider delete alpha-discord-bridge");
    expect(log).toContain("provider delete alpha-slack-bridge");
  });

  it("passes plain logs through without the tail flag", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-logs-plain-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const markerFile = path.join(home, "logs-plain-args");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `marker_file=${JSON.stringify(markerFile)}`,
        'printf \'%s \' "$@" > "$marker_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha logs", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    const recordedArgs = readRecordedArgs(markerFile);
    expect(recordedArgs).toEqual(["logs", "alpha", "-n", "200", "--source", "all"]);
    expect(recordedArgs).not.toContain("--tail");
  });

  it("connect does not pre-start a duplicate port forward", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-forward-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const markerFile = path.join(home, "openshell-calls");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `marker_file=${JSON.stringify(markerFile)}`,
        'printf \'%s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        "  echo 'alpha   Ready   2m ago'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "connect" ] && [ "$3" = "alpha" ]; then',
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(localBin, "sleep"), ["#!/usr/bin/env bash", "exit 0"].join("\n"), {
      mode: 0o755,
    });

    const r = runWithEnv("alpha connect", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    const calls = fs.readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
    expect(calls).toContain("sandbox get alpha");
    expect(calls).toContain("sandbox connect alpha");
    expect(calls.some((call) => call.startsWith("forward start --background 18789"))).toBe(false);
  });

  it("shows connect help without opening an interactive session", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-help-"));
    const localBin = path.join(home, "bin");
    const markerFile = path.join(home, "openshell-calls");
    const sshMarkerFile = path.join(home, "ssh-calls");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >> ${JSON.stringify(markerFile)}`,
        "exit 99",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeRecordingCommand(localBin, "ssh", sshMarkerFile, 98);

    const r = runWithEnv("alpha connect --help", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });
    const implicit = runWithEnv("alpha --help", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage: nemoclaw alpha connect");
    expect(r.out).toContain("--probe-only");
    expect(implicit.code).toBe(0);
    expect(implicit.out).toContain("Usage: nemoclaw alpha connect");
    expect(fs.existsSync(markerFile)).toBe(false);
    expect(fs.existsSync(sshMarkerFile)).toBe(false);
  });

  it("rejects the removed skip-permissions connect flag", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-probe-flags-"));
    const localBin = path.join(home, "bin");
    const markerFile = path.join(home, "openshell-calls");
    const sshMarkerFile = path.join(home, "ssh-calls");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >> ${JSON.stringify(markerFile)}`,
        "exit 99",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeRecordingCommand(localBin, "ssh", sshMarkerFile, 98);
    writeSandboxRegistry(home);

    const r = runWithEnv("alpha connect --dangerously-skip-permissions", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out).toContain("--dangerously-skip-permissions was removed");
    expect(fs.existsSync(markerFile)).toBe(false);
    expect(fs.existsSync(sshMarkerFile)).toBe(false);
  });

  it("connect --probe-only recovers the gateway without opening SSH", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-probe-"));
    const localBin = path.join(home, "bin");
    const markerFile = path.join(home, "openshell-calls");
    const sshMarkerFile = path.join(home, "ssh-calls");
    const stateFile = path.join(home, "probe-state");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home);
    fs.writeFileSync(stateFile, "stopped");
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `marker_file=${JSON.stringify(markerFile)}`,
        `state_file=${JSON.stringify(stateFile)}`,
        'printf \'%s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ] && [ "$3" = "--name" ] && [ "$4" = "alpha" ]; then',
        '  cmd="$8"',
        '  case "$cmd" in',
        '    *"OPENCLAW="*)',
        '      echo recovered > "$state_file"',
        "      echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'",
        "      echo 'GATEWAY_PID=123'",
        "      exit 42",
        "      ;;",
        "    *'curl -so'*)",
        "      echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'",
        '      if [ "$(cat "$state_file")" = recovered ]; then echo RUNNING; else echo STOPPED; fi',
        "      exit 0",
        "      ;;",
        "  esac",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeRecordingCommand(localBin, "ssh", sshMarkerFile, 98);

    const r = runWithEnv("alpha connect --probe-only", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Probe complete: recovered OpenClaw gateway");
    const calls = fs.readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
    expect(calls).toContain("sandbox get alpha");
    expect(calls.some((call) => call.startsWith("sandbox exec --name alpha -- sh -c"))).toBe(true);
    expect(calls).not.toContain("sandbox ssh-config alpha");
    expect(calls).not.toContain("sandbox connect alpha");
    expect(fs.existsSync(sshMarkerFile)).toBe(false);
  });

  it("waits for recovered gateway health before failing probe-only", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-probe-wait-"));
    const localBin = path.join(home, "bin");
    const markerFile = path.join(home, "openshell-calls");
    const stateFile = path.join(home, "probe-state");
    const readyCountFile = path.join(home, "ready-count");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home);
    fs.writeFileSync(stateFile, "stopped");
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `marker_file=${JSON.stringify(markerFile)}`,
        `state_file=${JSON.stringify(stateFile)}`,
        `ready_count_file=${JSON.stringify(readyCountFile)}`,
        'printf \'%s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ] && [ "$3" = "--name" ] && [ "$4" = "alpha" ]; then',
        '  cmd="$8"',
        '  case "$cmd" in',
        '    *"OPENCLAW="*)',
        '      echo recovered > "$state_file"',
        "      echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'",
        "      echo 'GATEWAY_PID=123'",
        "      exit 0",
        "      ;;",
        "    *'curl -so'*)",
        "      echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'",
        '      if [ "$(cat "$state_file")" != recovered ]; then echo STOPPED; exit 0; fi',
        '      count=$(cat "$ready_count_file" 2>/dev/null || echo 0)',
        "      count=$((count + 1))",
        '      echo "$count" > "$ready_count_file"',
        '      if [ "$count" -ge 3 ]; then echo RUNNING; else echo STOPPED; fi',
        "      exit 0",
        "      ;;",
        "  esac",
        "fi",
        'if [ "$1" = "forward" ]; then',
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha connect --probe-only", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
      NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS: "3",
      NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS: "0",
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Probe complete: recovered OpenClaw gateway");
    expect(fs.readFileSync(readyCountFile, "utf8").trim()).toBe("3");
  });

  it("treats leading --probe-only as an implicit connect probe", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-probe-leading-"));
    const localBin = path.join(home, "bin");
    const markerFile = path.join(home, "openshell-calls");
    const sshMarkerFile = path.join(home, "ssh-calls");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home);
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `marker_file=${JSON.stringify(markerFile)}`,
        'printf \'%s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ] && [ "$3" = "--name" ] && [ "$4" = "alpha" ]; then',
        '  cmd="$8"',
        '  if [[ "$cmd" == *"curl -so"* ]]; then echo "__NEMOCLAW_SANDBOX_EXEC_STARTED__"; echo RUNNING; exit 0; fi',
        '  if [[ "$cmd" == *"OPENCLAW="* ]]; then echo "__NEMOCLAW_SANDBOX_EXEC_STARTED__"; echo UNEXPECTED_RECOVERY; exit 1; fi',
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeRecordingCommand(localBin, "ssh", sshMarkerFile, 98);

    const r = runWithEnv("alpha --probe-only", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Probe complete: OpenClaw gateway is running");
    const calls = fs.readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
    expect(calls).toContain("sandbox get alpha");
    expect(calls.some((call) => call.startsWith("sandbox exec --name alpha -- sh -c"))).toBe(true);
    expect(calls).not.toContain("sandbox ssh-config alpha");
    expect(calls).not.toContain("sandbox connect alpha");
    expect(fs.existsSync(sshMarkerFile)).toBe(false);
  });

  it("connect --probe-only does not retry a failed sandbox exec recovery over SSH", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-probe-no-ssh-"));
    const localBin = path.join(home, "bin");
    const markerFile = path.join(home, "openshell-calls");
    const sshMarkerFile = path.join(home, "ssh-calls");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home);
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `marker_file=${JSON.stringify(markerFile)}`,
        'printf \'%s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ] && [ "$3" = "--name" ] && [ "$4" = "alpha" ]; then',
        '  cmd="$8"',
        '  if [[ "$cmd" == *"OPENCLAW="* ]]; then echo "__NEMOCLAW_SANDBOX_EXEC_STARTED__"; echo RECOVERY_FAILED >&2; exit 42; fi',
        '  if [[ "$cmd" == *"curl -so"* ]]; then echo "__NEMOCLAW_SANDBOX_EXEC_STARTED__"; echo STOPPED; exit 0; fi',
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "ssh-config" ]; then',
        "  echo 'Host openshell-alpha'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeRecordingCommand(localBin, "ssh", sshMarkerFile, 98);

    const r = runWithEnv("alpha connect --probe-only", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    const calls = fs.readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
    expect(calls).toContain("sandbox get alpha");
    expect(calls.some((call) => call.startsWith("sandbox exec --name alpha -- sh -c"))).toBe(true);
    expect(calls).not.toContain("sandbox ssh-config alpha");
    expect(fs.existsSync(sshMarkerFile)).toBe(false);
  });

  it("connect --probe-only falls back to SSH when sandbox exec never starts", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-connect-probe-exec-fallback-"),
    );
    const localBin = path.join(home, "bin");
    const openshellCalls = path.join(home, "openshell-calls");
    const sshCalls = path.join(home, "ssh-calls");
    const stateFile = path.join(home, "probe-state");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home);
    fs.writeFileSync(stateFile, "stopped");
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `calls=${JSON.stringify(openshellCalls)}`,
        'printf \'%s\\n\' "$*" >> "$calls"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ]; then',
        "  echo 'error: sandbox exec transport failed before command start' >&2",
        "  exit 2",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "ssh-config" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Host openshell-alpha'",
        "  echo '  HostName 127.0.0.1'",
        "  echo '  User sandbox'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "ssh"),
      [
        "#!/usr/bin/env bash",
        `calls=${JSON.stringify(sshCalls)}`,
        `state_file=${JSON.stringify(stateFile)}`,
        'cmd="${@: -1}"',
        'printf \'ARGS %s\\n\' "$*" >> "$calls"',
        'printf \'CMD %s\\n\' "$cmd" >> "$calls"',
        'if [[ "$cmd" == *"OPENCLAW="* ]]; then',
        '  echo recovered > "$state_file"',
        "  echo 'GATEWAY_PID=456'",
        "  exit 0",
        "fi",
        'if [[ "$cmd" == *"curl -so"* ]]; then',
        '  if [ "$(cat "$state_file")" = recovered ]; then echo RUNNING; else echo STOPPED; fi',
        "  exit 0",
        "fi",
        "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha connect --probe-only", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Probe complete: recovered OpenClaw gateway");
    const openshellLog = fs.readFileSync(openshellCalls, "utf8");
    const sshLog = fs.readFileSync(sshCalls, "utf8");
    expect(openshellLog).toContain("sandbox exec --name alpha -- sh -c");
    expect(openshellLog).toContain("sandbox ssh-config alpha");
    expect(openshellLog).not.toContain("sandbox connect");
    expect(sshLog).toContain('OPENCLAW="$(command -v openclaw)"');
    expect(sshLog).not.toMatch(/(^|\s)-tt?(\s|$)/);
  });

  it("connect --probe-only falls back to SSH when sandbox exec times out after starting", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-connect-probe-exec-timeout-"),
    );
    const localBin = path.join(home, "bin");
    const openshellCalls = path.join(home, "openshell-calls");
    const sshCalls = path.join(home, "ssh-calls");
    const stateFile = path.join(home, "probe-state");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home);
    fs.writeFileSync(stateFile, "stopped");
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `calls=${JSON.stringify(openshellCalls)}`,
        'printf \'%s\\n\' "$*" >> "$calls"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ]; then',
        "  echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'",
        "  sleep 1",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "ssh-config" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Host openshell-alpha'",
        "  echo '  HostName 127.0.0.1'",
        "  echo '  User sandbox'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "ssh"),
      [
        "#!/usr/bin/env bash",
        `calls=${JSON.stringify(sshCalls)}`,
        `state_file=${JSON.stringify(stateFile)}`,
        'cmd="${@: -1}"',
        'printf \'CMD %s\\n\' "$cmd" >> "$calls"',
        'if [[ "$cmd" == *"OPENCLAW="* ]]; then',
        '  echo recovered > "$state_file"',
        "  echo 'GATEWAY_PID=789'",
        "  exit 0",
        "fi",
        'if [[ "$cmd" == *"curl -so"* ]]; then',
        '  if [ "$(cat "$state_file")" = recovered ]; then echo RUNNING; else echo STOPPED; fi',
        "  exit 0",
        "fi",
        "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha connect --probe-only", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
      NEMOCLAW_SANDBOX_EXEC_TIMEOUT_MS: "50",
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Probe complete: recovered OpenClaw gateway");
    const openshellLog = fs.readFileSync(openshellCalls, "utf8");
    const sshLog = fs.readFileSync(sshCalls, "utf8");
    expect(openshellLog).toContain("sandbox exec --name alpha -- sh -c");
    expect(openshellLog).toContain("sandbox ssh-config alpha");
    expect(sshLog).toContain('OPENCLAW="$(command -v openclaw)"');
  });

  it("recovers non-OpenClaw agents over SSH instead of root sandbox exec", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-probe-agent-"));
    const localBin = path.join(home, "bin");
    const openshellCalls = path.join(home, "openshell-calls");
    const sshCalls = path.join(home, "ssh-calls");
    const stateFile = path.join(home, "probe-state");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, { agent: "hermes" });
    fs.writeFileSync(stateFile, "stopped");
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `calls=${JSON.stringify(openshellCalls)}`,
        `state_file=${JSON.stringify(stateFile)}`,
        'printf \'%s\\n\' "$*" >> "$calls"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ] && [ "$3" = "--name" ] && [ "$4" = "alpha" ]; then',
        '  cmd="$8"',
        '  if [[ "$cmd" == *"curl -so"* ]]; then',
        "    echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'",
        '    if [ "$(cat "$state_file")" = recovered ]; then echo RUNNING; else echo STOPPED; fi',
        "    exit 0",
        "  fi",
        '  if [[ "$cmd" == *"HERMES_HOME=/sandbox/.hermes"* || "$cmd" == *"AGENT_BIN="* ]]; then',
        "    echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'",
        "    echo UNEXPECTED_ROOT_EXEC_RECOVERY",
        "    exit 1",
        "  fi",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "ssh-config" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Host openshell-alpha'",
        "  echo '  HostName 127.0.0.1'",
        "  echo '  User sandbox'",
        "  exit 0",
        "fi",
        'if [ "$1" = "forward" ]; then',
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "ssh"),
      [
        "#!/usr/bin/env bash",
        `calls=${JSON.stringify(sshCalls)}`,
        `state_file=${JSON.stringify(stateFile)}`,
        'cmd="${@: -1}"',
        'printf \'ARGS %s\\n\' "$*" >> "$calls"',
        'printf \'CMD %s\\n\' "$cmd" >> "$calls"',
        'if [[ "$cmd" == *"AGENT_BIN=\'/usr/local/bin/hermes\'"* ]]; then',
        '  echo recovered > "$state_file"',
        "  echo 'GATEWAY_PID=789'",
        "  exit 0",
        "fi",
        "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha connect --probe-only", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Probe complete: recovered Hermes Agent gateway");
    const openshellLog = fs.readFileSync(openshellCalls, "utf8");
    const sshLog = fs.readFileSync(sshCalls, "utf8");
    expect(openshellLog).toContain("sandbox exec --name alpha -- sh -c");
    expect(openshellLog).toContain("sandbox ssh-config alpha");
    expect(openshellLog).not.toContain("HERMES_HOME=/sandbox/.hermes");
    expect(openshellLog).not.toContain("AGENT_BIN=");
    expect(openshellLog).not.toContain("sandbox connect");
    expect(sshLog).toContain("HERMES_HOME=/sandbox/.hermes");
    expect(sshLog).toContain("AGENT_BIN='/usr/local/bin/hermes'");
    expect(sshLog).not.toMatch(/(^|\s)-tt?(\s|$)/);
  });

  it("waits for sandbox readiness before connecting", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-wait-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const markerFile = path.join(home, "openshell-calls");
    const stateFile = path.join(home, "sandbox-list-count");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `marker_file=${JSON.stringify(markerFile)}`,
        `state_file=${JSON.stringify(stateFile)}`,
        'printf \'%s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Pending'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  count=$(cat "$state_file" 2>/dev/null || echo 0)',
        "  count=$((count + 1))",
        '  echo "$count" > "$state_file"',
        '  if [ "$count" -eq 1 ]; then',
        "    echo 'alpha   ContainerCreating   10s ago'",
        "  else",
        "    echo 'alpha   Ready   20s ago'",
        "  fi",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "connect" ] && [ "$3" = "alpha" ]; then',
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(localBin, "sleep"), ["#!/usr/bin/env bash", "exit 0"].join("\n"), {
      mode: 0o755,
    });

    const r = runWithEnv(
      "alpha connect",
      {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      },
      execTimeout(30_000),
    );

    expect(r.code).toBe(0);
    expect(r.out.includes("Waiting for sandbox 'alpha' to be ready")).toBeTruthy();
    expect(r.out.includes("Sandbox is ready. Connecting")).toBeTruthy();
    const calls = fs.readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
    expect(calls).toContain("sandbox get alpha");
    expect(calls.filter((call) => call === "sandbox list").length).toBeGreaterThanOrEqual(2);
    expect(calls).toContain("sandbox connect alpha");
  });

  it("prints recovery guidance when readiness polling hits a terminal sandbox state", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-failed-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const markerFile = path.join(home, "openshell-calls");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `marker_file=${JSON.stringify(markerFile)}`,
        'printf \'%s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Failed'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        "  echo 'alpha   Failed   1m ago'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "connect" ] && [ "$3" = "alpha" ]; then',
        "  echo 'should-not-connect' >> \"$marker_file\"",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha connect", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out.includes("Sandbox 'alpha' is in 'Failed' state")).toBeTruthy();
    expect(r.out.includes("nemoclaw alpha logs --follow")).toBeTruthy();
    expect(r.out.includes("nemoclaw alpha status")).toBeTruthy();
    const calls = fs.readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
    expect(calls).toContain("sandbox get alpha");
    expect(calls).toContain("sandbox list");
    expect(calls).not.toContain("should-not-connect");
  });

  it("removes stale registry entries when connect targets a missing live sandbox", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-stale-connect-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Error: status: NotFound, message: \"sandbox not found\"' >&2",
        "  exit 1",
        "fi",
        // Simulate a healthy, active `nemoclaw` named gateway so the
        // lifecycle guard confirms healthy_named and the registry removal
        // path fires. Without this, the guard preserves the entry (#2276).
        'if [ "$1" = "status" ]; then',
        "  printf 'Server Status\\n\\n  Gateway: nemoclaw\\n  Status: Connected\\n'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  printf 'Gateway: nemoclaw\\n'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha connect", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out.includes("Removed stale local registry entry")).toBeTruthy();
    const saved = JSON.parse(fs.readFileSync(path.join(registryDir, "sandboxes.json"), "utf8"));
    expect(saved.sandboxes.alpha).toBeUndefined();
  });

  it("recovers a missing registry entry from the last onboard session during list", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-list-session-recover-"));
    const localBin = path.join(home, "bin");
    const nemoclawDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(nemoclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(nemoclawDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          gamma: {
            name: "gamma",
            model: "existing-model",
            provider: "existing-provider",
            gpuEnabled: false,
            policies: ["npm"],
          },
        },
        defaultSandbox: "gamma",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(nemoclawDir, "onboard-session.json"),
      JSON.stringify(
        {
          version: 1,
          sessionId: "session-1",
          resumable: true,
          status: "complete",
          mode: "interactive",
          startedAt: "2026-03-31T00:00:00.000Z",
          updatedAt: "2026-03-31T00:00:00.000Z",
          lastStepStarted: "policies",
          lastCompletedStep: "policies",
          failure: null,
          sandboxName: "alpha",
          provider: "nvidia-prod",
          model: "nvidia/nemotron-3-super-120b-a12b",
          endpointUrl: null,
          credentialEnv: null,
          preferredInferenceApi: null,
          nimContainer: null,
          policyPresets: ["pypi"],
          metadata: { gatewayName: "nemoclaw" },
          steps: {
            preflight: { status: "complete", startedAt: null, completedAt: null, error: null },
            gateway: { status: "complete", startedAt: null, completedAt: null, error: null },
            sandbox: { status: "complete", startedAt: null, completedAt: null, error: null },
            provider_selection: {
              status: "complete",
              startedAt: null,
              completedAt: null,
              error: null,
            },
            inference: { status: "complete", startedAt: null, completedAt: null, error: null },
            openclaw: { status: "complete", startedAt: null, completedAt: null, error: null },
            policies: { status: "complete", startedAt: null, completedAt: null, error: null },
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "status" ]; then',
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  echo '  Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway Info'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        "  echo 'NAME           STATUS     AGE'",
        "  echo 'alpha          Ready      2m ago'",
        "  exit 0",
        "fi",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  exit 0",
        "fi",
        'if [ "$1" = "--version" ]; then',
        "  echo 'openshell 0.0.16'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("list", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(
      r.out.includes("Recovered sandbox inventory from the last onboard session."),
    ).toBeTruthy();
    expect(r.out.includes("alpha")).toBeTruthy();
    expect(r.out.includes("gamma")).toBeTruthy();
    const saved = JSON.parse(fs.readFileSync(path.join(nemoclawDir, "sandboxes.json"), "utf8"));
    expect(saved.sandboxes.alpha).toBeTruthy();
    expect(saved.sandboxes.alpha.policies).toEqual(["pypi"]);
    expect(saved.sandboxes.gamma).toBeTruthy();
    expect(saved.defaultSandbox).toBe("gamma");
  });

  it("imports additional live sandboxes into the registry during list recovery", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-list-live-recover-"));
    const localBin = path.join(home, "bin");
    const nemoclawDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(nemoclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(nemoclawDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          gamma: {
            name: "gamma",
            model: "existing-model",
            provider: "existing-provider",
            gpuEnabled: false,
            policies: ["npm"],
          },
        },
        defaultSandbox: "gamma",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(nemoclawDir, "onboard-session.json"),
      JSON.stringify(
        {
          version: 1,
          sessionId: "session-1",
          resumable: true,
          status: "complete",
          mode: "interactive",
          startedAt: "2026-03-31T00:00:00.000Z",
          updatedAt: "2026-03-31T00:00:00.000Z",
          lastStepStarted: "policies",
          lastCompletedStep: "policies",
          failure: null,
          sandboxName: "alpha",
          provider: "nvidia-prod",
          model: "nvidia/nemotron-3-super-120b-a12b",
          endpointUrl: null,
          credentialEnv: null,
          preferredInferenceApi: null,
          nimContainer: null,
          policyPresets: ["pypi"],
          metadata: { gatewayName: "nemoclaw" },
          steps: {
            preflight: { status: "complete", startedAt: null, completedAt: null, error: null },
            gateway: { status: "complete", startedAt: null, completedAt: null, error: null },
            sandbox: { status: "complete", startedAt: null, completedAt: null, error: null },
            provider_selection: {
              status: "complete",
              startedAt: null,
              completedAt: null,
              error: null,
            },
            inference: { status: "complete", startedAt: null, completedAt: null, error: null },
            openclaw: { status: "complete", startedAt: null, completedAt: null, error: null },
            policies: { status: "complete", startedAt: null, completedAt: null, error: null },
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "status" ]; then',
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  echo '  Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway Info'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        "  echo 'NAME        PHASE'",
        "  echo 'alpha       Ready'",
        "  echo 'beta        Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  exit 0",
        "fi",
        'if [ "$1" = "--version" ]; then',
        "  echo 'openshell 0.0.16'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("list", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(
      r.out.includes("Recovered sandbox inventory from the last onboard session."),
    ).toBeTruthy();
    expect(
      r.out.includes("Recovered 1 sandbox entry from the live OpenShell gateway."),
    ).toBeTruthy();
    expect(r.out.includes("alpha")).toBeTruthy();
    expect(r.out.includes("beta")).toBeTruthy();
    expect(r.out.includes("gamma")).toBeTruthy();
    const saved = JSON.parse(fs.readFileSync(path.join(nemoclawDir, "sandboxes.json"), "utf8"));
    expect(saved.sandboxes.alpha).toBeTruthy();
    expect(saved.sandboxes.alpha.policies).toEqual(["pypi"]);
    expect(saved.sandboxes.beta).toBeTruthy();
    expect(saved.sandboxes.gamma).toBeTruthy();
    expect(saved.defaultSandbox).toBe("gamma");
  });

  it("skips invalid recovered sandbox names during list recovery", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-list-invalid-recover-"));
    const localBin = path.join(home, "bin");
    const nemoclawDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(nemoclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(nemoclawDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          gamma: {
            name: "gamma",
            model: "existing-model",
            provider: "existing-provider",
            gpuEnabled: false,
            policies: ["npm"],
          },
        },
        defaultSandbox: "gamma",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(nemoclawDir, "onboard-session.json"),
      JSON.stringify(
        {
          version: 1,
          sessionId: "session-1",
          resumable: true,
          status: "complete",
          mode: "interactive",
          startedAt: "2026-03-31T00:00:00.000Z",
          updatedAt: "2026-03-31T00:00:00.000Z",
          lastStepStarted: "policies",
          lastCompletedStep: "policies",
          failure: null,
          sandboxName: "Alpha",
          provider: "nvidia-prod",
          model: "nvidia/nemotron-3-super-120b-a12b",
          endpointUrl: null,
          credentialEnv: null,
          preferredInferenceApi: null,
          nimContainer: null,
          policyPresets: ["pypi"],
          metadata: { gatewayName: "nemoclaw" },
          steps: {
            preflight: { status: "complete", startedAt: null, completedAt: null, error: null },
            gateway: { status: "complete", startedAt: null, completedAt: null, error: null },
            sandbox: { status: "complete", startedAt: null, completedAt: null, error: null },
            provider_selection: {
              status: "complete",
              startedAt: null,
              completedAt: null,
              error: null,
            },
            inference: { status: "complete", startedAt: null, completedAt: null, error: null },
            openclaw: { status: "complete", startedAt: null, completedAt: null, error: null },
            policies: { status: "complete", startedAt: null, completedAt: null, error: null },
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "status" ]; then',
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  echo '  Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway Info'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        "  echo 'NAME        PHASE'",
        "  echo 'alpha       Ready'",
        "  echo 'Bad_Name    Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  exit 0",
        "fi",
        'if [ "$1" = "--version" ]; then',
        "  echo 'openshell 0.0.16'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("list", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out.includes("alpha")).toBeTruthy();
    expect(r.out.includes("Bad_Name")).toBeFalsy();
    const saved = JSON.parse(fs.readFileSync(path.join(nemoclawDir, "sandboxes.json"), "utf8"));
    expect(saved.sandboxes.alpha).toBeTruthy();
    expect(saved.sandboxes.Bad_Name).toBeUndefined();
    expect(saved.sandboxes.Alpha).toBeUndefined();
    expect(saved.sandboxes.gamma).toBeTruthy();
  });

  it("connect recovers a named sandbox from the last onboard session when the registry is empty", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-recover-session-"));
    const localBin = path.join(home, "bin");
    const nemoclawDir = path.join(home, ".nemoclaw");
    const markerFile = path.join(home, "connect-args");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(nemoclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(nemoclawDir, "onboard-session.json"),
      JSON.stringify(
        {
          version: 1,
          sessionId: "session-1",
          resumable: true,
          status: "complete",
          mode: "interactive",
          startedAt: "2026-03-31T00:00:00.000Z",
          updatedAt: "2026-03-31T00:00:00.000Z",
          lastStepStarted: "policies",
          lastCompletedStep: "policies",
          failure: null,
          sandboxName: "alpha",
          provider: "nvidia-prod",
          model: "nvidia/nemotron-3-super-120b-a12b",
          endpointUrl: null,
          credentialEnv: null,
          preferredInferenceApi: null,
          nimContainer: null,
          policyPresets: null,
          metadata: { gatewayName: "nemoclaw" },
          steps: {
            preflight: { status: "complete", startedAt: null, completedAt: null, error: null },
            gateway: { status: "complete", startedAt: null, completedAt: null, error: null },
            sandbox: { status: "complete", startedAt: null, completedAt: null, error: null },
            provider_selection: {
              status: "complete",
              startedAt: null,
              completedAt: null,
              error: null,
            },
            inference: { status: "complete", startedAt: null, completedAt: null, error: null },
            openclaw: { status: "complete", startedAt: null, completedAt: null, error: null },
            policies: { status: "complete", startedAt: null, completedAt: null, error: null },
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `marker_file=${JSON.stringify(markerFile)}`,
        'printf \'%s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "status" ]; then',
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  echo '  Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway Info'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        "  echo 'NAME           STATUS     AGE'",
        "  echo 'alpha          Ready      2m ago'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "connect" ] && [ "$3" = "alpha" ]; then',
        "  exit 0",
        "fi",
        'if [ "$1" = "--version" ]; then',
        "  echo 'openshell 0.0.16'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha connect", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    const log = fs.readFileSync(markerFile, "utf8");
    expect(log.includes("sandbox list")).toBeTruthy();
    expect(log.includes("sandbox get alpha")).toBeTruthy();
    expect(log.includes("sandbox connect alpha")).toBeTruthy();
  });

  it("connect surfaces sandbox-not-found when recovery cannot find the requested sandbox (#2164)", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-connect-unknown-after-recovery-"),
    );
    const localBin = path.join(home, "bin");
    const nemoclawDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(nemoclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(nemoclawDir, "onboard-session.json"),
      JSON.stringify(
        {
          version: 1,
          sessionId: "session-1",
          resumable: true,
          status: "complete",
          mode: "interactive",
          startedAt: "2026-03-31T00:00:00.000Z",
          updatedAt: "2026-03-31T00:00:00.000Z",
          lastStepStarted: "policies",
          lastCompletedStep: "policies",
          failure: null,
          sandboxName: "alpha",
          provider: "nvidia-prod",
          model: "nvidia/nemotron-3-super-120b-a12b",
          endpointUrl: null,
          credentialEnv: null,
          preferredInferenceApi: null,
          nimContainer: null,
          policyPresets: null,
          metadata: { gatewayName: "nemoclaw" },
          steps: {
            preflight: { status: "complete", startedAt: null, completedAt: null, error: null },
            gateway: { status: "complete", startedAt: null, completedAt: null, error: null },
            sandbox: { status: "complete", startedAt: null, completedAt: null, error: null },
            provider_selection: {
              status: "complete",
              startedAt: null,
              completedAt: null,
              error: null,
            },
            inference: { status: "complete", startedAt: null, completedAt: null, error: null },
            openclaw: { status: "complete", startedAt: null, completedAt: null, error: null },
            policies: { status: "complete", startedAt: null, completedAt: null, error: null },
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "status" ]; then',
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  echo '  Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway Info'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        "  echo 'No sandboxes found.'",
        "  exit 0",
        "fi",
        'if [ "$1" = "--version" ]; then',
        "  echo 'openshell 0.0.16'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("beta connect", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out.includes("Sandbox 'beta' does not exist")).toBeTruthy();
    // Recovery from onboard-session.json restores "alpha" into the local registry,
    // so the helper lists it rather than the empty-registry onboard hint.
    expect(r.out.includes("Registered sandboxes: alpha")).toBeTruthy();
  });

  it("preserves SIGINT exit semantics for logs --follow", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-logs-sigint-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "--version" ]; then',
        "  echo 'openshell 0.0.16'",
        "  exit 0",
        "fi",
        'if [ "$1" = "settings" ]; then',
        "  exit 0",
        "fi",
        "kill -INT $$",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync(process.execPath, [CLI, "alpha", "logs", "--follow"], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      env: { ...process.env, HOME: home, PATH: `${localBin}:${process.env.PATH || ""}` },
    });

    expect(result.status).toBe(130);
  });

  it(
    "keeps registry entries when status hits a gateway-level transport error",
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-gateway-error-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(
        path.join(registryDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
              policies: [],
            },
          },
          defaultSandbox: "alpha",
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
          "  echo 'Error: transport error: handshake verification failed' >&2",
          "  exit 1",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const r = runWithEnv(
        "alpha status",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
        execTimeout(),
      );

      expect(r.code).toBe(1);
      expect(r.out.includes("Could not verify sandbox 'alpha'")).toBeTruthy();
      expect(r.out.includes("gateway identity drift after restart")).toBeTruthy();
      const saved = JSON.parse(fs.readFileSync(path.join(registryDir, "sandboxes.json"), "utf8"));
      expect(saved.sandboxes.alpha).toBeTruthy();
    },
    testTimeout(10_000),
  );

  it(
    "keeps status bounded when a live sandbox probe leaves child pipes open",
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-status-timeout-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(
        path.join(registryDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
              policies: [],
            },
          },
          defaultSandbox: "alpha",
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
          `  ${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)" &`,
          "  wait",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const started = Date.now();
      const r = runWithEnv(
        "alpha status",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
          NEMOCLAW_STATUS_PROBE_TIMEOUT_MS: "100",
        },
        10000,
      );

      expect(Date.now() - started).toBeLessThan(7000);
      expect(r.code).toBe(1);
      expect(r.out).toContain("Model:    test-model");
      expect(r.out).toContain("Live sandbox status probe timed out");
    },
    testTimeout(10_000),
  );

  it("recovers status after gateway runtime is reattached", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-recover-status-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const stateFile = path.join(home, "sandbox-get-count");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `state_file=${JSON.stringify(stateFile)}`,
        'count=$(cat "$state_file" 2>/dev/null || echo 0)',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  count=$((count + 1))",
        '  echo "$count" > "$state_file"',
        '  if [ "$count" -eq 1 ]; then',
        "    echo 'Error: transport error: Connection refused' >&2",
        "    exit 1",
        "  fi",
        "  echo 'Sandbox: alpha'",
        "  exit 0",
        "fi",
        'if [ "$1" = "status" ]; then',
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  echo '  Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ] && [ "$3" = "-g" ] && [ "$4" = "nemoclaw" ]; then',
        "  echo 'Gateway Info'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha status", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out.includes("Recovered NemoClaw gateway runtime")).toBeTruthy();
    expect(r.out.includes("Sandbox: alpha")).toBeTruthy();
  });

  it("shows a clear local inference warning when Ollama is down", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-local-inference-down-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "llama3.2:1b",
            provider: "ollama-local",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox: alpha'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "ssh-config" ] && [ "$3" = "alpha" ]; then',
        "  exit 1",
        "fi",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  echo 'Gateway inference:'",
        "  echo",
        "  echo '  Provider: ollama-local'",
        "  echo '  Model: llama3.2:1b'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "curl"),
      [
        "#!/usr/bin/env bash",
        'out=""',
        'url=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    -o) out="$2"; shift 2 ;;',
        "    -w|--connect-timeout|--max-time) shift 2 ;;",
        "    -s|-S|-sS|-f) shift ;;",
        '    http://*|https://*) url="$1"; shift ;;',
        "    *) shift ;;",
        "  esac",
        "done",
        'if [ -n "$out" ]; then : > "$out"; fi',
        'if echo "$url" | grep -q "11434/api/tags"; then',
        '  printf "000"',
        "  exit 7",
        "fi",
        'printf "000"',
        "exit 7",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha status", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Inference:");
    expect(r.out).toContain("unreachable");
    expect(r.out).toContain("Start Ollama and retry");
    expect(r.out).toContain("http://127.0.0.1:11434/api/tags");
  });

  it("prints healthy inference only after the sandbox and gateway are verified", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-status-healthy-"));
    const localBin = path.join(home, "bin");
    const markerFile = path.join(home, "openshell-calls");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, {
      model: "configured-model",
      provider: "nvidia-prod",
      gpuEnabled: true,
      policies: ["pypi"],
    });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >> ${JSON.stringify(markerFile)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  echo 'Gateway inference:'",
        "  echo",
        "  echo '  Provider: nvidia-prod'",
        "  echo '  Model: live-model'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ] && [ "$3" = "--name" ] && [ "$4" = "alpha" ]; then',
        "  echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'",
        "  echo 'RUNNING'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "curl"),
      [
        "#!/usr/bin/env bash",
        'out=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    -o) out="$2"; shift 2 ;;',
        "    -w|--connect-timeout|--max-time) shift 2 ;;",
        "    *) shift ;;",
        "  esac",
        "done",
        'if [ -n "$out" ]; then printf "{}" > "$out"; fi',
        'printf "200"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha status", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Sandbox: alpha");
    expect(r.out).toContain("Model:    live-model");
    expect(r.out).toContain("Provider: nvidia-prod");
    expect(r.out).toContain("Inference:");
    expect(r.out).toContain("healthy");
    expect(r.out).not.toContain("not verified");
    const calls = fs.readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
    const sandboxGetIdx = calls.indexOf("sandbox get alpha");
    const inferenceGetIdx = calls.indexOf("inference get");
    expect(sandboxGetIdx).toBeGreaterThanOrEqual(0);
    expect(inferenceGetIdx).toBeGreaterThan(sandboxGetIdx);
  });

  it(
    "does not treat a different connected gateway as a healthy nemoclaw gateway",
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-mixed-gateway-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(
        path.join(registryDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
              policies: [],
            },
          },
          defaultSandbox: "alpha",
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
          "  echo 'Error: transport error: Connection refused' >&2",
          "  exit 1",
          "fi",
          'if [ "$1" = "status" ]; then',
          "  echo 'Server Status'",
          "  echo",
          "  echo '  Gateway: openshell'",
          "  echo '  Status: Connected'",
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "info" ] && [ "$3" = "-g" ] && [ "$4" = "nemoclaw" ]; then',
          "  echo 'Gateway Info'",
          "  echo",
          "  echo '  Gateway: nemoclaw'",
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "select" ] && [ "$3" = "nemoclaw" ]; then',
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "start" ] && [ "$3" = "--name" ] && [ "$4" = "nemoclaw" ]; then',
          "  exit 0",
          "fi",
          'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
          "  exit 0",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const r = runWithEnv(
        "alpha status",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
        execTimeout(),
      );

      expect(r.code).toBe(1);
      expect(r.out.includes("Recovered NemoClaw gateway runtime")).toBeFalsy();
      expect(r.out.includes("Could not verify sandbox 'alpha'")).toBeTruthy();
      expect(r.out.includes("verify the active gateway")).toBeTruthy();
    },
    testTimeout(10_000),
  );

  it(
    "matches ANSI-decorated gateway transport errors when printing lifecycle hints",
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-ansi-transport-hint-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(
        path.join(registryDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
              policies: [],
            },
          },
          defaultSandbox: "alpha",
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
          "  printf '\\033[31mError: trans\\033[0mport error: Connec\\033[33mtion refused\\033[0m\\n' >&2",
          "  exit 1",
          "fi",
          'if [ "$1" = "status" ]; then',
          "  echo 'Server Status'",
          "  echo",
          "  echo '  Gateway: openshell'",
          "  echo '  Status: Disconnected'",
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "info" ] && [ "$3" = "-g" ] && [ "$4" = "nemoclaw" ]; then',
          "  printf 'Gateway Info\\n\\n  Gateway: openshell\\n'",
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "select" ] && [ "$3" = "nemoclaw" ]; then',
          "  exit 0",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const r = runWithEnv(
        "alpha status",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
        execTimeout(),
      );

      expect(r.code).toBe(1);
      expect(r.out.includes("current gateway/runtime is not reachable")).toBeTruthy();
    },
    testTimeout(10_000),
  );

  it(
    "matches ANSI-decorated gateway auth errors when printing lifecycle hints",
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-ansi-auth-hint-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(
        path.join(registryDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
              policies: [],
            },
          },
          defaultSandbox: "alpha",
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
          "  printf '\\033[31mMissing gateway auth\\033[0m token\\n' >&2",
          "  exit 1",
          "fi",
          'if [ "$1" = "status" ]; then',
          "  echo 'Server Status'",
          "  echo",
          "  echo '  Gateway: openshell'",
          "  echo '  Status: Disconnected'",
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "info" ] && [ "$3" = "-g" ] && [ "$4" = "nemoclaw" ]; then',
          "  printf 'Gateway Info\\n\\n  Gateway: openshell\\n'",
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "select" ] && [ "$3" = "nemoclaw" ]; then',
          "  exit 0",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const r = runWithEnv(
        "alpha status",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
        execTimeout(),
      );

      expect(r.code).toBe(1);
      expect(
        r.out.includes("Verify the active gateway and retry after re-establishing the runtime."),
      ).toBeTruthy();
    },
    testTimeout(10_000),
  );

  it("explains unrecoverable gateway trust rotation after restart", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-identity-drift-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Error: transport error: handshake verification failed' >&2",
        "  exit 1",
        "fi",
        'if [ "$1" = "status" ]; then',
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  echo '  Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ] && [ "$3" = "-g" ] && [ "$4" = "nemoclaw" ]; then',
        "  echo 'Gateway Info'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const statusResult = runWithEnv(
      "alpha status",
      {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      },
      execTimeout(),
    );
    expect(statusResult.code).toBe(1);
    expect(statusResult.out.includes("gateway trust material rotated after restart")).toBeTruthy();
    expect(statusResult.out.includes("cannot be reattached safely")).toBeTruthy();

    const connectResult = runWithEnv("alpha connect", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });
    expect(connectResult.code).toBe(1);
    // After the auto-recovery attempt (clear stale host keys + retry), the
    // fake openshell still returns the handshake error, so recovery fails.
    expect(connectResult.out.includes("Could not reconnect")).toBeTruthy();
    expect(connectResult.out.includes("Recreate this sandbox")).toBeTruthy();
  });

  it(
    "explains when gateway metadata exists but the restarted API is still refusing connections",
    { timeout: 30000 },
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-gateway-unreachable-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      const markerFile = path.join(home, "openshell-calls");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(
        path.join(registryDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
              policies: [],
            },
          },
          defaultSandbox: "alpha",
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          `printf '%s\\n' "$*" >> ${JSON.stringify(markerFile)}`,
          'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
          "  echo 'Error: transport error: Connection refused' >&2",
          "  exit 1",
          "fi",
          'if [ "$1" = "status" ]; then',
          "  echo 'Server Status'",
          "  echo",
          "  echo '  Gateway: nemoclaw'",
          "  echo '  Server: https://127.0.0.1:8080'",
          "  echo 'Error: client error (Connect)' >&2",
          "  echo 'Connection refused (os error 111)' >&2",
          "  exit 1",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "info" ] && [ "$3" = "-g" ] && [ "$4" = "nemoclaw" ]; then',
          "  echo 'Gateway Info'",
          "  echo",
          "  echo '  Gateway: nemoclaw'",
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "select" ] && [ "$3" = "nemoclaw" ]; then',
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "start" ] && [ "$3" = "--name" ] && [ "$4" = "nemoclaw" ]; then',
          "  exit 0",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(localBin, "curl"),
        [
          "#!/usr/bin/env bash",
          'out=""',
          'while [ "$#" -gt 0 ]; do',
          '  case "$1" in',
          '    -o) out="$2"; shift 2 ;;',
          "    -w|--connect-timeout|--max-time) shift 2 ;;",
          "    *) shift ;;",
          "  esac",
          "done",
          'if [ -n "$out" ]; then printf "{}" > "$out"; fi',
          'printf "200"',
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const statusResult = runWithEnv(
        "alpha status",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
        execTimeout(),
      );
      expect(statusResult.code).toBe(1);
      expect(statusResult.out).not.toContain("Inference: healthy");
      expect(statusResult.out).toContain(
        "Inference: not verified (gateway/sandbox state not verified)",
      );
      expect(fs.readFileSync(markerFile, "utf8")).not.toContain("inference get");
      expect(
        statusResult.out.includes("gateway is still refusing connections after restart"),
      ).toBeTruthy();
      expect(
        statusResult.out.includes("Retry `openshell gateway start --name nemoclaw`"),
      ).toBeTruthy();

      const connectResult = runWithEnv("alpha connect", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });
      expect(connectResult.code).toBe(1);
      expect(
        connectResult.out.includes("gateway is still refusing connections after restart"),
      ).toBeTruthy();
      expect(connectResult.out.includes("If the gateway never becomes healthy")).toBeTruthy();
    },
  );

  it(
    "explains when the named gateway is no longer configured after restart or rebuild",
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-gateway-missing-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(
        path.join(registryDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
              policies: [],
            },
          },
          defaultSandbox: "alpha",
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
          "  echo 'Error: transport error: Connection refused' >&2",
          "  exit 1",
          "fi",
          'if [ "$1" = "status" ]; then',
          "  echo 'Gateway Status'",
          "  echo",
          "  echo '  Status: No gateway configured.'",
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "info" ] && [ "$3" = "-g" ] && [ "$4" = "nemoclaw" ]; then',
          "  exit 1",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "select" ] && [ "$3" = "nemoclaw" ]; then',
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "start" ] && [ "$3" = "--name" ] && [ "$4" = "nemoclaw" ]; then',
          "  exit 1",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const statusResult = runWithEnv(
        "alpha status",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
        execTimeout(),
      );
      expect(statusResult.code).toBe(1);
      expect(
        statusResult.out.includes("gateway is no longer configured after restart/rebuild"),
      ).toBeTruthy();
      expect(statusResult.out.includes("Start the gateway again")).toBeTruthy();
    },
    testTimeout(10_000),
  );

  it("auto-cleans an orphan registry entry on status when the named gateway is healthy", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-status-orphan-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Error: status: NotFound, message: \"sandbox not found\"' >&2",
        "  exit 1",
        "fi",
        'if [ "$1" = "status" ]; then',
        "  printf 'Server Status\\n\\n  Gateway: nemoclaw\\n  Status: Connected\\n'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  printf 'Gateway: nemoclaw\\n'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const statusResult = runWithEnv(
      "alpha status",
      {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      },
      execTimeout(),
    );

    expect(statusResult.code).toBe(1);
    expect(statusResult.out).not.toContain("Inference: healthy");
    expect(statusResult.out).toContain("is not present in the live OpenShell gateway");
    expect(statusResult.out).toContain("Removed stale local registry entry");

    const saved = JSON.parse(fs.readFileSync(path.join(registryDir, "sandboxes.json"), "utf8"));
    expect(saved.sandboxes.alpha).toBeUndefined();
    expect(saved.defaultSandbox).toBeNull();
  });
});

describe("list shows live gateway inference", () => {
  it("shows live gateway inference for the default sandbox (#2369)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-list-live-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          test: {
            name: "test",
            model: "configured-model",
            provider: "configured-provider",
            gpuEnabled: true,
            policies: ["pypi", "npm"],
          },
        },
        defaultSandbox: "test",
      }),
      { mode: 0o600 },
    );
    // Stub openshell: inference get returns a different live provider/model
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  echo 'Gateway inference:'",
        "  echo '  Provider: nvidia-prod'",
        "  echo '  Model: nvidia/nemotron-3-super-120b-a12b'",
        "  echo '  Version: 1'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("list", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    // Live gateway values render on the default sandbox's main row.
    expect(r.out).toContain(
      "agent: openclaw  model: nvidia/nemotron-3-super-120b-a12b  provider: nvidia-prod  GPU  policies: pypi, npm",
    );
    // The stale (stored) row must not appear.
    expect(r.out).not.toContain(
      "agent: openclaw  model: configured-model  provider: configured-provider  GPU  policies: pypi, npm",
    );
    // Onboarded values appear in the drift annotation.
    expect(r.out).toContain("(onboarded: model=configured-model, provider=configured-provider)");
  });

  it("falls back to registry values when openshell inference get fails", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-list-fallback-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          test: {
            name: "test",
            model: "llama3.2:1b",
            provider: "ollama-local",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "test",
      }),
      { mode: 0o600 },
    );
    // Stub openshell: inference get fails
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  exit 1",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("list", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("llama3.2:1b");
    expect(r.out).toContain("ollama-local");
  });

  it("lists registered sandboxes when runtime inference probing is degraded", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-list-runtime-degraded-"));
    const localBin = path.join(home, "bin");
    const markerFile = path.join(home, "openshell-calls");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, {
      model: "configured-model",
      provider: "nvidia-prod",
      gpuEnabled: false,
      policies: ["pypi"],
    });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >> ${JSON.stringify(markerFile)}`,
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  echo 'Error: client error (Connect)' >&2",
        "  exit 1",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("list", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Sandboxes:");
    expect(r.out).toContain("alpha *");
    expect(r.out).toContain("model: configured-model");
    expect(r.out).toContain("provider: nvidia-prod");
    expect(fs.readFileSync(markerFile, "utf8")).toContain("inference get");
  });

  // ── Issue #1904: sandbox not upgraded after NemoClaw upgrade ───
  // Original report: user upgrades NemoClaw from v0.0.11→v0.0.15 via
  // curl|bash. Existing sandbox still runs old OpenClaw (2026.3.11)
  // because Docker cached the stale :latest image. upgrade-sandboxes
  // --check should detect the version mismatch and report it.

  it(
    "upgrade-sandboxes --check detects a stale sandbox after NemoClaw upgrade (#1904)",
    testTimeoutOptions(),
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-upgrade-sandboxes-"));
      const localBin = path.join(home, "bin");
      const nemoclawDir = path.join(home, ".nemoclaw");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(nemoclawDir, { recursive: true });

      // Registry with a sandbox that has an old agentVersion (the pre-upgrade state)
      fs.writeFileSync(
        path.join(nemoclawDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            "my-agent": {
              name: "my-agent",
              model: "nvidia/nemotron-3-super-120b-a12b",
              provider: "nvidia-prod",
              gpuEnabled: false,
              policies: [],
              agentVersion: "2026.3.11",
            },
          },
          defaultSandbox: "my-agent",
        }),
        { mode: 0o600 },
      );

      // Fake openshell that reports the sandbox as running
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
          '  echo "my-agent   Running   openclaw"',
          "  exit 0",
          "fi",
          'if [ "$1" = "--version" ]; then',
          '  echo "openshell 0.0.24"',
          "  exit 0",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const r = runWithEnv("upgrade-sandboxes --check 2>&1", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });

      expect(r.code).toBe(0);
      // Should report the stale sandbox with version info
      expect(r.out).toContain("my-agent");
      expect(r.out).toContain("2026.3.11");
      expect(r.out).toMatch(/stale|need upgrading/i);
    },
  );

  it(
    "upgrade-sandboxes --check reports all-current when no sandboxes are stale (#1904)",
    testTimeoutOptions(),
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-upgrade-current-"));
      const localBin = path.join(home, "bin");
      const nemoclawDir = path.join(home, ".nemoclaw");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(nemoclawDir, { recursive: true });

      // Registry with a sandbox at the current version — should NOT be stale
      fs.writeFileSync(
        path.join(nemoclawDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            "my-agent": {
              name: "my-agent",
              model: "nvidia/nemotron-3-super-120b-a12b",
              provider: "nvidia-prod",
              gpuEnabled: false,
              policies: [],
              agentVersion: "9999.12.31",
            },
          },
          defaultSandbox: "my-agent",
        }),
        { mode: 0o600 },
      );

      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
          '  echo "my-agent   Running   openclaw"',
          "  exit 0",
          "fi",
          'if [ "$1" = "--version" ]; then',
          '  echo "openshell 0.0.24"',
          "  exit 0",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const r = runWithEnv("upgrade-sandboxes --check 2>&1", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });

      expect(r.code).toBe(0);
      expect(r.out).toContain("up to date");
    },
  );

  it("share with no subcommand prints usage help", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-share-"));
    writeSandboxRegistry(home);

    const r = runWithEnv("alpha share", { HOME: home });

    expect(r.code).toBe(1);
    expect(r.out).toContain("Usage: nemoclaw <name> share");
    expect(r.out).toContain("mount");
    expect(r.out).toContain("unmount");
    expect(r.out).toContain("status");
  });

  it("share help keeps public sandbox-scoped usage", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-share-help-"));
    writeSandboxRegistry(home);

    const parent = runWithEnv("alpha share --help", { HOME: home });
    expect(parent.code).toBe(0);
    expect(parent.out).toContain("Usage: nemoclaw <name> share <mount|unmount|status>");
    expect(parent.out).not.toContain("sandbox:share");

    for (const [subcommand, usage] of [
      ["mount", "share mount [sandbox-path] [local-mount-point]"],
      ["unmount", "share unmount [local-mount-point]"],
      ["status", "share status [local-mount-point]"],
    ]) {
      const result = runWithEnv(`alpha share ${subcommand} --help`, { HOME: home });
      expect(result.code).toBe(0);
      expect(result.out).toContain(`$ nemoclaw <name> ${usage}`);
      expect(result.out).not.toContain("sandbox:share");
    }
  });

  it("share is recognized as a valid sandbox action (not 'Unknown action')", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-share-action-"));
    writeSandboxRegistry(home);

    const r = runWithEnv("alpha share mount", { HOME: home });

    // Will fail because sshfs/sandbox isn't running, but should NOT say "Unknown action"
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain("Unknown action");
  });

  it("unknown share subcommands fail before action dispatch", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-share-unknown-"));
    writeSandboxRegistry(home);

    const r = runWithEnv("alpha share bogus 2>&1", { HOME: home });

    expect(r.code).not.toBe(0);
    expect(r.out).toContain("Unexpected argument: bogus");
  });
});
