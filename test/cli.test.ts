// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { execSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dirname, "..", "bin", "nemoclaw.js");

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

function run(args: string): CliRunResult {
  return runWithEnv(args);
}

function runWithEnv(
  args: string,
  env: Record<string, string | undefined> = {},
  timeout: number = Number(process.env.NEMOCLAW_EXEC_TIMEOUT || 10000),
): CliRunResult {
  try {
    const out = execSync(`node "${CLI}" ${args}`, {
      encoding: "utf-8",
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

function writeSandboxRegistry(home: string): void {
  const registryDir = path.join(home, ".nemoclaw");
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

describe("CLI dispatch", () => {
  it("config get validates flags and values before dispatch", () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "nemoclaw.ts"), "utf-8");
    const configGet = src.match(/case "get": \{([\s\S]*?)sandboxConfig\.configGet\(cmd, configOpts\);/);
    expect(configGet).toBeTruthy();
    expect(configGet![1]).toContain("--key requires a value");
    expect(configGet![1]).toContain("--format requires a value");
    expect(configGet![1]).toContain("Unknown format");
    expect(configGet![1]).toContain("Unknown flag");
    expect(configGet![1]).toContain('format !== "json" && format !== "yaml"');
  });

  it("help exits 0 and shows sections", () => {
    const r = run("help");
    expect(r.code).toBe(0);
    expect(r.out.includes("Getting Started")).toBeTruthy();
    expect(r.out.includes("Sandbox Management")).toBeTruthy();
    expect(r.out.includes("Policy Presets")).toBeTruthy();
    expect(r.out.includes("Compatibility Commands")).toBeTruthy();
  });

  it("--help exits 0", () => {
    expect(run("--help").code).toBe(0);
  });

  it("-h exits 0", () => {
    expect(run("-h").code).toBe(0);
  });

  it("no args exits 0 (shows help)", () => {
    const r = run("");
    expect(r.code).toBe(0);
    expect(r.out.includes("nemoclaw")).toBeTruthy();
  });

  it("bare unknown name surfaces sandbox-not-found (#2164)", { timeout: 35000 }, () => {
    // Longer timeout: when openshell is installed but the gateway is down,
    // the CLI probes the gateway before reporting "not found" and the
    // default 10s is not enough for the connection to time out.
    const r = runWithEnv("boguscmd", {}, 30000);
    expect(r.code).toBe(1);
    expect(r.out.includes("Sandbox 'boguscmd' does not exist")).toBeTruthy();
  });

  it("unknown command with non-sandbox action exits 1", () => {
    const r = run("boguscmd boguscmd2");
    expect(r.code).toBe(1);
    expect(r.out.includes("Unknown command")).toBeTruthy();
  });

  it("list exits 0", () => {
    const r = run("list");
    expect(r.code).toBe(0);
    // With empty HOME, should say no sandboxes
    expect(r.out.includes("No sandboxes")).toBeTruthy();
  });

  it("shows skill install help when --help follows install", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-skill-help-"));
    writeSandboxRegistry(home);

    const r = runWithEnv("alpha skill install --help", { HOME: home });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage: nemoclaw <sandbox> skill install <path>");
    expect(r.out).toContain("Deploy a skill directory");
    expect(r.out).not.toContain("--help");
    expect(r.out).not.toContain("No SKILL.md found");
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
    { timeout: 35000 },
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

      const r = runWithEnv("start", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
        NVIDIA_API_KEY: "",
        TELEGRAM_BOT_TOKEN: "",
      });

      expect(r.code).toBe(0);
      expect(r.out).not.toContain("NVIDIA API Key required");
      // Services module now runs in-process (no bash shelling)
      expect(r.out).toContain("NemoClaw Services");
    },
  );

  it("onboard --help exits 0 and shows usage", () => {
    const r = run("onboard --help");
    expect(r.code).toBe(0);
    expect(r.out.includes("Usage: nemoclaw onboard")).toBeTruthy();
    expect(r.out.includes("--from <Dockerfile>")).toBeTruthy();
  });

  it("unknown onboard option exits 1", () => {
    const r = run("onboard --non-interactiv");
    expect(r.code).toBe(1);
    expect(r.out.includes("Unknown onboard option")).toBeTruthy();
  });

  it("accepts onboard --resume in CLI parsing", () => {
    const r = run("onboard --resume --non-interactiv");
    expect(r.code).toBe(1);
    expect(r.out.includes("Unknown onboard option(s): --non-interactiv")).toBeTruthy();
  });

  it("accepts the third-party software flag in onboard CLI parsing", () => {
    const r = run("onboard --yes-i-accept-third-party-software --non-interactiv");
    expect(r.code).toBe(1);
    expect(r.out.includes("Unknown onboard option(s): --non-interactiv")).toBeTruthy();
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
    expect(r.code).toBe(1);
    expect(r.out.includes("deprecated")).toBeTruthy();
    expect(r.out.includes("Unknown onboard option(s): --non-interactiv")).toBeTruthy();
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

  it("debug --help exits 0 and shows usage", () => {
    const r = run("debug --help");
    expect(r.code).toBe(0);
    expect(r.out.includes("Collect NemoClaw diagnostic information")).toBeTruthy();
    expect(r.out.includes("--quick")).toBeTruthy();
    expect(r.out.includes("--output")).toBeTruthy();
  });

  it("debug --quick exits 0 and produces diagnostic output", { timeout: 15000 }, () => {
    const r = run("debug --quick");
    expect(r.code).toBe(0);
    expect(r.out.includes("Collecting diagnostics")).toBeTruthy();
    expect(r.out.includes("System")).toBeTruthy();
    expect(r.out.includes("Onboard Session")).toBeTruthy();
    expect(r.out.includes("Done")).toBeTruthy();
  });

  it("debug exits 1 on unknown option", () => {
    const r = run("debug --quik");
    expect(r.code).toBe(1);
    expect(r.out.includes("Unknown option")).toBeTruthy();
  });

  it("help mentions debug command", () => {
    const r = run("help");
    expect(r.code).toBe(0);
    expect(r.out.includes("Troubleshooting")).toBeTruthy();
    expect(r.out.includes("nemoclaw debug")).toBeTruthy();
  });

  it("debug --sandbox NAME targets the specified sandbox", { timeout: 15000 }, () => {
    const r = run("debug --quick --sandbox mybox");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Collecting diagnostics for sandbox 'mybox'");
  });

  it("debug --sandbox without a name exits 1", () => {
    const r = run("debug --sandbox");
    expect(r.code).not.toBe(0);
  });

  it("debug warns when default sandbox is stale", { timeout: 15000 }, () => {
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

  it("debug --sandbox skips stale default warning", { timeout: 15000 }, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-stale-"));
    fs.mkdirSync(path.join(home, ".nemoclaw"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".nemoclaw", "sandboxes.json"),
      JSON.stringify({ sandboxes: {}, defaultSandbox: "ghost" }),
      { mode: 0o600 },
    );
    const r = runWithEnv("debug --quick --sandbox mybox 2>&1", { HOME: home });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("Warning");
    expect(r.out).toContain("Collecting diagnostics for sandbox 'mybox'");
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

  it("keeps logs --follow running when one log source exits", { timeout: 15000 }, async () => {
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
    const exitPromise = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
    });
    const readCalls = () =>
      fs.existsSync(markerFile) ? fs.readFileSync(markerFile, "utf8").trim().split(/\n/) : [];

    try {
      let calls: string[] = [];
      const configuredTimeout = Number(process.env.NEMOCLAW_TEST_TIMEOUT || 10000);
      const pollTimeoutMs = Math.min(
        Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 10000,
        10000,
      );
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
      expect(child.exitCode).toBeNull();
      expect(calls).toContain("logs alpha -n 200 --source all --tail");
      expect(calls).toContain("sandbox exec -n alpha -- tail -n 200 -f /tmp/gateway.log");
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }
      expect(await exitPromise).toBe(143);
    }
  });

  it("waits for logs --follow children to stop after SIGTERM", { timeout: 15000 }, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-logs-follow-sigterm-wait-"));
    const localBin = path.join(home, "bin");
    const markerFile = path.join(home, "logs-follow-sigterm-wait-args");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home);
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `marker_file=${JSON.stringify(markerFile)}`,
        'printf \'%s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "settings" ]; then',
        "  exit 0",
        "fi",
        'if [ "$1" = "logs" ] || [ "$1" = "sandbox" ]; then',
        "  trap 'sleep 0.3; exit 0' TERM INT",
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
    const exitPromise = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
    });
    const readCalls = () =>
      fs.existsSync(markerFile) ? fs.readFileSync(markerFile, "utf8").trim().split(/\n/) : [];

    try {
      let calls: string[] = [];
      const deadline = Date.now() + 10000;
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
      child.kill("SIGTERM");
      const exitedEarly = await Promise.race([
        exitPromise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
      ]);
      expect(exitedEarly).toBe(false);
      expect(await exitPromise).toBe(143);
    } finally {
      if (child.exitCode === null) {
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

    const r = runWithEnv("alpha destroy --yes", {
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
      30000,
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
        Number(process.env.NEMOCLAW_EXEC_TIMEOUT || 10000),
      );

      expect(r.code).toBe(0);
      expect(r.out.includes("Could not verify sandbox 'alpha'")).toBeTruthy();
      expect(r.out.includes("gateway identity drift after restart")).toBeTruthy();
      const saved = JSON.parse(fs.readFileSync(path.join(registryDir, "sandboxes.json"), "utf8"));
      expect(saved.sandboxes.alpha).toBeTruthy();
    },
    Number(process.env.NEMOCLAW_TEST_TIMEOUT || 10000),
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
        Number(process.env.NEMOCLAW_EXEC_TIMEOUT || 10000),
      );

      expect(r.code).toBe(0);
      expect(r.out.includes("Recovered NemoClaw gateway runtime")).toBeFalsy();
      expect(r.out.includes("Could not verify sandbox 'alpha'")).toBeTruthy();
      expect(r.out.includes("verify the active gateway")).toBeTruthy();
    },
    Number(process.env.NEMOCLAW_TEST_TIMEOUT || 10000),
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
        Number(process.env.NEMOCLAW_EXEC_TIMEOUT || 10000),
      );

      expect(r.code).toBe(0);
      expect(r.out.includes("current gateway/runtime is not reachable")).toBeTruthy();
    },
    Number(process.env.NEMOCLAW_TEST_TIMEOUT || 10000),
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
        Number(process.env.NEMOCLAW_EXEC_TIMEOUT || 10000),
      );

      expect(r.code).toBe(0);
      expect(
        r.out.includes("Verify the active gateway and retry after re-establishing the runtime."),
      ).toBeTruthy();
    },
    Number(process.env.NEMOCLAW_TEST_TIMEOUT || 10000),
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
      Number(process.env.NEMOCLAW_EXEC_TIMEOUT || 10000),
    );
    expect(statusResult.code).toBe(0);
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
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-gateway-unreachable-"));
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

      const statusResult = runWithEnv(
        "alpha status",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
        Number(process.env.NEMOCLAW_EXEC_TIMEOUT || 10000),
      );
      expect(statusResult.code).toBe(0);
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
    Number(process.env.NEMOCLAW_TEST_TIMEOUT || 10000),
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
        Number(process.env.NEMOCLAW_EXEC_TIMEOUT || 10000),
      );
      expect(statusResult.code).toBe(0);
      expect(
        statusResult.out.includes("gateway is no longer configured after restart/rebuild"),
      ).toBeTruthy();
      expect(statusResult.out.includes("Start the gateway again")).toBeTruthy();
    },
    Number(process.env.NEMOCLAW_TEST_TIMEOUT || 10000),
  );
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
      "model: nvidia/nemotron-3-super-120b-a12b  provider: nvidia-prod  GPU  policies: pypi, npm",
    );
    // The stale (stored) row must not appear.
    expect(r.out).not.toContain(
      "model: configured-model  provider: configured-provider  GPU  policies: pypi, npm",
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

  // ── Issue #1904: sandbox not upgraded after NemoClaw upgrade ───
  // Original report: user upgrades NemoClaw from v0.0.11→v0.0.15 via
  // curl|bash. Existing sandbox still runs old OpenClaw (2026.3.11)
  // because Docker cached the stale :latest image. upgrade-sandboxes
  // --check should detect the version mismatch and report it.

  it(
    "upgrade-sandboxes --check detects a stale sandbox after NemoClaw upgrade (#1904)",
    { timeout: 15000 },
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
    { timeout: 15000 },
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
});
