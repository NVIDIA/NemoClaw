// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { trustedSandboxShellScript, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import { ubuntuRepoDocker } from "../scenarios/matrix.ts";

// Migrated from test/e2e/test-issue-4434-tui-unreachable-inference.sh.
// This remains a privileged opt-in live repro: it onboards a real cloud
// OpenClaw sandbox, installs temporary DOCKER-USER DROP rules for the NVIDIA
// endpoint IPs, drives `openclaw tui` through `openshell sandbox exec --tty`,
// and requires a visible inference error plus an error status instead of the
// broken spinner+connected signature from #4434. The legacy bash lane remains
// wired until Phase 11 shell retirement; this file adds the equivalent Vitest
// coverage without introducing shared framework or registry helpers.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const DOCKERFILE_BASE = path.join(REPO_ROOT, "Dockerfile.base");
const ENVIRONMENT = ubuntuRepoDocker("cloud-openclaw");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-issue-4434-tui-unreachable";
validateSandboxName(SANDBOX_NAME);

const INFERENCE_MODELS_URL = "https://inference-api.nvidia.com/v1/models";
const BLOCKED_IPS = ["75.2.113.119", "99.83.136.103"];
const DEFAULT_TUI_TIMEOUT_SEC = 180;
const MAX_TUI_TIMEOUT_SEC = 3600;
const rawTuiTimeoutSec = Number.parseInt(
  process.env.NEMOCLAW_ISSUE_4434_TUI_TIMEOUT_SEC ?? String(DEFAULT_TUI_TIMEOUT_SEC),
  10,
);
const TUI_TIMEOUT_SEC =
  Number.isFinite(rawTuiTimeoutSec) && rawTuiTimeoutSec > 0
    ? Math.min(rawTuiTimeoutSec, MAX_TUI_TIMEOUT_SEC)
    : DEFAULT_TUI_TIMEOUT_SEC;

const VISIBLE_ERROR_RE =
  /\b(error|failed|timeout|timed out|unavailable|fetch failed|ETIMEDOUT|ECONN|upstream|connection|refused|no route to host)\b/i;
const CONNECTED_SPINNER_RE =
  /(?:flibbertigibbeting|thinking|waiting|processing).*?\|\s*connected|[0-9]+m\s+[0-9]+s\s*\|\s*connected/i;
const STATUS_LINE_RE =
  /(connecting|gateway connected|connected|sending|running|flibbertigibbeting).*\|\s*(connected|error)/i;
const ERROR_STATUS_RE = /\|\s*error\b/i;

const runIssue4434LiveTest =
  shouldRunLiveE2EScenarios() && process.env.NEMOCLAW_ISSUE_4434_LIVE === "1" ? test : test.skip;

type CommandResultText = { stdout: string; stderr: string };

function resultText(result: CommandResultText): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function readBundledOpenClawVersion(): string {
  const dockerfile = fs.readFileSync(DOCKERFILE_BASE, "utf8");
  const match = dockerfile.match(/^ARG OPENCLAW_VERSION=(\S+)\s*$/m);
  if (!match?.[1]) {
    throw new Error("could not parse OPENCLAW_VERSION from Dockerfile.base");
  }
  return match[1];
}

function stripTerminalControl(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n");
}

function analyzeIssue4434TuiCapture(capture: string) {
  const plain = stripTerminalControl(capture);
  const statusLines = plain
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => STATUS_LINE_RE.test(line));
  const lastStatusLine = statusLines.at(-1) ?? "";
  return {
    plain,
    visibleError: VISIBLE_ERROR_RE.test(plain),
    connectedSpinner: CONNECTED_SPINNER_RE.test(plain),
    issue4434Signature: CONNECTED_SPINNER_RE.test(plain) && !VISIBLE_ERROR_RE.test(plain),
    lastStatusLine,
    finalStatusIsError: ERROR_STATUS_RE.test(lastStatusLine),
    finalStatusIsConnectedSpinner: CONNECTED_SPINNER_RE.test(lastStatusLine),
  };
}

function deleteFirewallRulesScript(ips: readonly string[]): string {
  return [
    "set -euo pipefail",
    ...ips.map(
      (ip) =>
        `sudo iptables -D DOCKER-USER -d ${shellSingleQuote(ip)} -j DROP >/dev/null 2>&1 || true`,
    ),
  ].join("\n");
}

function buildExpectScript(): string {
  return `set timeout $env(NEMOCLAW_ISSUE_4434_TUI_TIMEOUT)
set sandbox $env(NEMOCLAW_ISSUE_4434_SANDBOX)
set capture $env(NEMOCLAW_ISSUE_4434_CAPTURE)
log_file -a $capture
spawn openshell sandbox exec --name $sandbox --tty -- sh -lc {export TERM=xterm-256color; cd /sandbox; openclaw tui}
sleep 10
send -- "hello\\r"
expect {
  -nocase -re {(error|failed|timeout|timed out|unavailable|fetch failed|ETIMEDOUT|ECONN|upstream)} {
    sleep 5
    send "\\003"
    sleep 1
    send "\\003"
    exit 0
  }
  timeout {
    send "\\003"
    sleep 1
    send "\\003"
    exit 20
  }
  eof { exit 21 }
}
`;
}

runIssue4434LiveTest(
  "issue-4434: openclaw tui surfaces unreachable-inference errors and stops the connected spinner",
  { timeout: 120 * 60_000 },
  async ({ artifacts, cleanup, environment, host, onboard, sandbox, secrets, skip }) => {
    if (process.platform !== "linux") {
      skip("Linux host required for DOCKER-USER iptables repro");
    }

    const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
    expect(apiKey.startsWith("nvapi-"), "NVIDIA_INFERENCE_API_KEY must start with nvapi-").toBe(
      true,
    );

    await artifacts.writeJson("scenario.json", {
      id: "issue-4434-tui-unreachable-inference",
      runner: "vitest",
      boundary: [
        "real cloud OpenClaw sandbox",
        "host DOCKER-USER iptables DROP rules",
        "openshell sandbox exec --tty",
        "openclaw tui",
      ],
      migratedFrom: "test/e2e/test-issue-4434-tui-unreachable-inference.sh",
      issue: "#4434",
    });

    const prereq = await host.command(
      "bash",
      [
        "-lc",
        [
          "set -euo pipefail",
          'for command in docker sudo expect curl; do command -v "$command" >/dev/null; done',
          "docker info >/dev/null",
          "sudo -n true >/dev/null",
          "sudo -n iptables --version >/dev/null",
        ].join("\n"),
      ],
      {
        artifactName: "issue4434-prerequisites",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(prereq.exitCode, resultText(prereq)).toBe(0);

    const ready = await environment.assertReady(ENVIRONMENT);
    const instance = await onboard.from(ready, {
      sandboxName: SANDBOX_NAME,
      timeoutMs: 20 * 60_000,
    });

    const insertedIps: string[] = [];
    cleanup.add("remove issue #4434 DOCKER-USER DROP rules", async () => {
      if (insertedIps.length === 0) return;
      const cleanupResult = await host.command(
        "bash",
        ["-lc", deleteFirewallRulesScript(insertedIps)],
        {
          artifactName: "cleanup-issue4434-firewall-rules",
          env: buildAvailabilityProbeEnv(),
          timeoutMs: 30_000,
        },
      );
      if (cleanupResult.exitCode !== 0) {
        throw new Error(
          `failed to cleanup issue #4434 firewall rules\n${resultText(cleanupResult)}`,
        );
      }
    });

    const expectedOpenClawVersion = readBundledOpenClawVersion();
    const version = await sandbox.exec(instance.sandboxName, ["openclaw", "--version"], {
      artifactName: "issue4434-openclaw-version",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    expect(version.exitCode, resultText(version)).toBe(0);
    expect(
      version.stdout,
      `expected sandbox OpenClaw ${expectedOpenClawVersion}; actual stdout: ${version.stdout}`,
    ).toContain(expectedOpenClawVersion);

    const status = await host.nemoclaw([instance.sandboxName, "status"], {
      artifactName: "issue4434-status-before-block",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    });
    expect(status.exitCode, resultText(status)).toBe(0);
    expect(resultText(status)).toMatch(/inference.*healthy|healthy.*inference/i);

    const connectProbe = await host.nemoclaw([instance.sandboxName, "connect", "--probe-only"], {
      artifactName: "issue4434-connect-probe-before-block",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    });
    expect(connectProbe.exitCode, resultText(connectProbe)).toBe(0);

    for (const ip of BLOCKED_IPS) {
      const insert = await host.command(
        "sudo",
        ["iptables", "-I", "DOCKER-USER", "-d", ip, "-j", "DROP"],
        {
          artifactName: `issue4434-firewall-drop-${ip.replaceAll(".", "-")}`,
          env: buildAvailabilityProbeEnv(),
          timeoutMs: 30_000,
        },
      );
      expect(insert.exitCode, resultText(insert)).toBe(0);
      insertedIps.push(ip);
    }

    const blockedEndpointProbe = await sandbox.execShell(
      instance.sandboxName,
      trustedSandboxShellScript(
        `command -v curl >/dev/null && curl -sk --connect-timeout 5 --max-time 12 ${shellSingleQuote(INFERENCE_MODELS_URL)} >/tmp/issue4434-models.blocked.out 2>&1`,
      ),
      {
        artifactName: "issue4434-endpoint-probe-after-block",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(
      blockedEndpointProbe.exitCode,
      `inference-api.nvidia.com remained reachable from inside the sandbox after firewall block\n${resultText(blockedEndpointProbe)}`,
    ).not.toBe(0);

    const captureFile = artifacts.pathFor("openclaw-tui-capture.log");
    const expectLog = artifacts.pathFor("expect.log");
    const expectScript = artifacts.pathFor("issue4434-openclaw-tui.expect");
    fs.writeFileSync(expectScript, buildExpectScript(), { mode: 0o700 });

    const tui = await host.command("expect", [expectScript], {
      artifactName: "issue4434-openclaw-tui-expect",
      env: {
        ...buildAvailabilityProbeEnv(),
        NEMOCLAW_ISSUE_4434_SANDBOX: instance.sandboxName,
        NEMOCLAW_ISSUE_4434_CAPTURE: captureFile,
        NEMOCLAW_ISSUE_4434_TUI_TIMEOUT: String(TUI_TIMEOUT_SEC),
      },
      redactionValues: [apiKey],
      timeoutMs: (TUI_TIMEOUT_SEC + 30) * 1000,
    });
    fs.writeFileSync(expectLog, resultText(tui), "utf8");

    let rawCapture = "";
    try {
      rawCapture = fs.readFileSync(captureFile, "utf8");
    } catch (error) {
      const fileError = error as NodeJS.ErrnoException;
      if (fileError.code !== "ENOENT") {
        throw error;
      }
    }
    const redactedRawCapture = secrets.redact(rawCapture, [apiKey]);
    fs.writeFileSync(captureFile, redactedRawCapture, "utf8");
    const analysis = analyzeIssue4434TuiCapture(redactedRawCapture);
    await artifacts.writeText("openclaw-tui-capture.plain.log", analysis.plain);
    await artifacts.writeJson("scenario-result.json", {
      id: "issue-4434-tui-unreachable-inference",
      expectExitCode: tui.exitCode,
      visibleError: analysis.visibleError,
      connectedSpinner: analysis.connectedSpinner,
      issue4434Signature: analysis.issue4434Signature,
      lastStatusLine: analysis.lastStatusLine,
      finalStatusIsError: analysis.finalStatusIsError,
      finalStatusIsConnectedSpinner: analysis.finalStatusIsConnectedSpinner,
    });

    const failureContext = [
      `expect exit=${tui.exitCode}`,
      `capture=${captureFile}`,
      `lastStatusLine=${analysis.lastStatusLine}`,
      "plain capture:",
      analysis.plain,
    ].join("\n");

    expect(analysis.visibleError, failureContext).toBe(true);
    expect(tui.exitCode, failureContext).toBe(0);
    expect(analysis.issue4434Signature, failureContext).toBe(false);
    expect(analysis.lastStatusLine, failureContext).not.toBe("");
    expect(analysis.finalStatusIsConnectedSpinner, failureContext).toBe(false);
    expect(analysis.finalStatusIsError, failureContext).toBe(true);
  },
);
