// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CLI,
  FAKE_OPENCLAW_LOG_LINE,
  FAKE_OPENSHELL_LOG_LINE,
  createLogsTestSetup,
  isChildRunning,
  runWithEnv,
  testTimeout,
  testTimeoutOptions,
  waitForChildExit,
  writeHealthyDockerStub,
  writeSandboxRegistry,
} from "./helpers";

describe("CLI dispatch", () => {
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
    expect(r.out).toContain("$ nemoclaw sandbox logs <name>");
    expect(r.out).toContain("--follow");
    expect(r.out).toContain("--tail");
    expect(r.out).toContain("--since");
    expect(setup.readCalls()).toEqual([]);
  });

  it("rejects unknown logs flags before calling OpenShell", () => {
    const setup = createLogsTestSetup("nemoclaw-cli-logs-unknown-");
    const r = setup.runLogs("alpha logs --bogus 2>&1");

    expect(r.code).not.toBe(0);
    expect(r.out).toContain("Nonexistent flag: --bogus");
    expect(setup.readCalls()).toEqual([]);
  });

  it("continues to OpenShell logs when the OpenClaw gateway log probe times out", () => {
    const setup = createLogsTestSetup("nemoclaw-cli-logs-openclaw-timeout-", [
      'if [ "$1" = "sandbox" ]; then',
      "  while true; do :; done",
      "fi",
    ]);

    const r = setup.runLogs("alpha logs 2>&1", { NEMOCLAW_LOGS_PROBE_TIMEOUT_MS: "50" });

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
    const gatewayStartedMarker = "gateway-started";
    const auditCompleteMarker = "audit-enabled";
    const setup = createLogsTestSetup(
      "nemoclaw-cli-logs-follow-audit-slow-",
      [
        'if [ "$1" = "settings" ]; then',
        "  sleep 0.05",
        `  printf '%s\\n' ${JSON.stringify(auditCompleteMarker)} >> "$marker_file"`,
        "  exit 0",
        "fi",
      ],
      { gatewayStartedMarker },
    );

    const start = Date.now();
    const r = setup.runLogs("alpha logs --follow", { NEMOCLAW_LOGS_PROBE_TIMEOUT_MS: "2000" });
    const calls = setup.readCalls();

    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
    expect(r.code).toBe(0);
    // All three calls must happen: OpenClaw log stream, audit enable, OpenShell log stream.
    expect(calls).toContain("sandbox exec -n alpha -- tail -n 200 -f /tmp/gateway.log");
    expect(calls).toContain("settings set alpha --key ocsf_json_enabled --value true");
    expect(calls).toContain("logs alpha -n 200 --source all --tail");
    expect(calls).toContain(gatewayStartedMarker);
    expect(calls).toContain(auditCompleteMarker);
    const gatewayStartedIdx = calls.indexOf(gatewayStartedMarker);
    const auditIdx = calls.indexOf("settings set alpha --key ocsf_json_enabled --value true");
    const auditCompleteIdx = calls.indexOf(auditCompleteMarker);
    const openshellIdx = calls.indexOf("logs alpha -n 200 --source all --tail");
    expect(gatewayStartedIdx).toBeLessThan(auditCompleteIdx);
    expect(auditIdx).toBeLessThan(openshellIdx);
    expect(r.out).toContain(FAKE_OPENCLAW_LOG_LINE);
    expect(r.out).toContain(FAKE_OPENSHELL_LOG_LINE);
  });

  it(
    "keeps logs --follow running when one log source exits",
    testTimeoutOptions(10_000),
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-logs-follow-source-exit-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      const markerFile = path.join(home, "logs-follow-source-exit-args");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      writeHealthyDockerStub(localBin);
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
        const testBudgetMs = testTimeout(10_000);
        const pollTimeoutMs = Math.min(testBudgetMs, Math.max(1_000, testBudgetMs - 5_000));
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
    },
  );

  it(
    "waits for logs --follow children to stop after SIGTERM",
    testTimeoutOptions(10_000),
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-logs-follow-sigterm-wait-"));
      const localBin = path.join(home, "bin");
      const markerFile = path.join(home, "logs-follow-sigterm-wait-args");
      const releaseFile = path.join(home, "release-log-children");
      fs.mkdirSync(localBin, { recursive: true });
      writeSandboxRegistry(home);
      writeHealthyDockerStub(localBin);
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
          '  trap \'printf "%s term-start\\n" "$*" >> "$marker_file"; while [ ! -f "$release_file" ]; do sleep 0.05; done; printf "%s term-end\\n" "$*" >> "$marker_file"; exit 0\' TERM INT',
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
        const testBudgetMs = testTimeout(10_000);
        const pollTimeoutMs = Math.min(testBudgetMs, Math.max(1_000, testBudgetMs - 5_000));
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
        const termTimeoutMs = Math.min(testBudgetMs, Math.max(1_000, testBudgetMs - 5_000));
        const termDeadline = Date.now() + termTimeoutMs;
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
    },
  );

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
        // Return a healthy named-gateway status so the new gateway-health
        // probe (#3386) does not flip the exit code to 1.
        'if [ "$1" = "status" ]; then',
        "  echo 'Gateway: nemoclaw'",
        "  echo 'Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway: nemoclaw'",
        "  exit 0",
        "fi",
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
    // Healthy Docker so the #4428 logs preflight does not short-circuit before
    // the SIGINT path under test.
    writeHealthyDockerStub(localBin);

    const result = spawnSync(process.execPath, [CLI, "alpha", "logs", "--follow"], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      env: { ...process.env, HOME: home, PATH: `${localBin}:${process.env.PATH || ""}` },
    });

    expect(result.status).toBe(130);
  });
});
