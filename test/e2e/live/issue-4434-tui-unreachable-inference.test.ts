// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { isGatewayManagedCompatibleInference } from "../fixtures/ci-compatible-inference.ts";
import { resultText } from "../fixtures/clients/command.ts";
import { trustedSandboxShellScript, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import { ubuntuRepoDocker } from "../registry/matrix.ts";
import {
  classifyIssue4434AcceptanceFields,
  extractFinalIssue4434ErrorBlock,
  hasFullIssue4434Diagnostics,
  stripTerminalControl,
} from "../support/issue-4434-tui-capture.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";

// This remains a privileged opt-in live repro: it onboards a real cloud
// OpenClaw sandbox, installs temporary DOCKER-USER DROP rules for the NVIDIA
// endpoint IPs, proves the managed route through a test endpoint and then stops
// that endpoint, drives `openclaw tui` through `openshell sandbox exec --tty`,
// and requires a visible inference error, full #4434 diagnostic fields, and an
// error status instead of the broken spinner+connected signature from #4434.
// This stays local to the live target rather than introducing shared framework
// helpers. Keep the route provider/model assertion and direct `inference.local`
// pre-block probe so a status result of "not probed" cannot weaken the precondition.

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
const HOSTED_INFERENCE_IS_GATEWAY_MANAGED = isGatewayManagedCompatibleInference();

const runIssue4434LiveTest =
  process.env.NEMOCLAW_ISSUE_4434_LIVE === "1"
    ? test.skipIf(HOSTED_INFERENCE_IS_GATEWAY_MANAGED)
    : test.skip;

type CommandResultText = { stdout: string; stderr: string };

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function chatCompletionPayload(model: string, content: string): string {
  return JSON.stringify({
    model,
    messages: [{ role: "user", content }],
    max_tokens: 8,
  });
}

function readBundledOpenClawVersion(): string {
  const dockerfile = fs.readFileSync(DOCKERFILE_BASE, "utf8");
  const match = dockerfile.match(/^ARG OPENCLAW_VERSION=(\S+)\s*$/m);
  if (!match?.[1]) {
    throw new Error("could not parse OPENCLAW_VERSION from Dockerfile.base");
  }
  return match[1];
}

function analyzeIssue4434TuiCapture(capture: string) {
  const plain = stripTerminalControl(capture);
  const statusLines = plain
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => STATUS_LINE_RE.test(line));
  const lastStatusLine = statusLines.at(-1) ?? "";
  const finalErrorBlock = extractFinalIssue4434ErrorBlock(plain);
  return {
    plain,
    finalErrorBlock,
    visibleError: VISIBLE_ERROR_RE.test(plain),
    connectedSpinner: CONNECTED_SPINNER_RE.test(plain),
    issue4434Signature: CONNECTED_SPINNER_RE.test(plain) && !VISIBLE_ERROR_RE.test(plain),
    lastStatusLine,
    finalStatusIsError: ERROR_STATUS_RE.test(lastStatusLine),
    finalStatusIsConnectedSpinner: CONNECTED_SPINNER_RE.test(lastStatusLine),
    diagnosticFields: classifyIssue4434AcceptanceFields(finalErrorBlock),
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
    // Hosted compatible inference is gateway-managed; this repro only blocks
    // sandbox egress, so runIssue4434LiveTest skips that mode before setup.
    if (process.platform !== "linux") {
      skip("Linux host required for DOCKER-USER iptables repro");
    }

    const hosted = requireHostedInferenceConfig(secrets);
    const apiKey = hosted.apiKey;

    await artifacts.target.declare({
      id: "issue-4434-tui-unreachable-inference",
      boundary: [
        "real cloud OpenClaw sandbox",
        "host DOCKER-USER iptables DROP rules",
        "managed inference route through a stopped fake OpenAI-compatible endpoint",
        "openshell sandbox exec --tty",
        "openclaw tui",
      ],
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
    expect(resultText(status)).toMatch(/managed_inference|inference\.local/i);
    expect(resultText(status)).toMatch(/Docker health:\s*healthy/i);
    const route = await host.command(
      "bash",
      ["-lc", "openshell inference get -g nemoclaw 2>&1 || openshell inference get 2>&1"],
      {
        artifactName: "issue4434-openshell-inference-before-block",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(route.exitCode, resultText(route)).toBe(0);
    const routePlain = stripTerminalControl(resultText(route));
    expect(routePlain).toContain(`Provider: ${hosted.providerName}`);
    expect(routePlain).toContain(`Model: ${hosted.model}`);
    const originalRouteTimeout = routePlain.match(/Timeout:\s*(\d+)s/i)?.[1] ?? "0";
    expect(originalRouteTimeout, `could not parse inference timeout\n${routePlain}`).not.toBe("0");

    const preBlockPayload = chatCompletionPayload(hosted.model, "Reply before the fault.");
    const preBlockProbe = await sandbox.execShell(
      instance.sandboxName,
      trustedSandboxShellScript(
        `command -v curl >/dev/null && curl -fsS --max-time 60 https://inference.local/v1/chat/completions -H 'Content-Type: application/json' -d ${shellSingleQuote(preBlockPayload)} >/dev/null`,
      ),
      {
        artifactName: "issue4434-inference-local-before-block",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 90_000,
      },
    );
    expect(
      preBlockProbe.exitCode,
      `inference.local was not reachable before the firewall block\n${resultText(preBlockProbe)}`,
    ).toBe(0);

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

    const fake = await startFakeOpenAiCompatibleServer({
      host: "0.0.0.0",
      model: hosted.model,
      publicHost: "host.openshell.internal",
    });
    let fakeClosePromise: Promise<void> | undefined;
    const closeFake = (): Promise<void> => {
      fakeClosePromise ??= (async () => {
        await artifacts.writeJson("issue4434-fake-openai-requests-cleanup.json", fake.requests());
        await fake.close();
      })();
      return fakeClosePromise;
    };
    cleanup.add("close issue #4434 fake OpenAI-compatible endpoint", closeFake);
    await artifacts.writeJson("issue4434-fake-openai-endpoint.json", { baseUrl: fake.baseUrl });

    const fakeProviderName = `issue-4434-fake-${new URL(fake.baseUrl).port}`;
    const failedRoutePayload = chatCompletionPayload(
      hosted.model,
      `This must fail after ${fakeProviderName} stops.`,
    );
    const createProvider = await host.command(
      "openshell",
      [
        "provider",
        "create",
        "-g",
        "nemoclaw",
        "--name",
        fakeProviderName,
        "--type",
        "openai",
        "--credential",
        "COMPATIBLE_API_KEY",
        "--config",
        `OPENAI_BASE_URL=${fake.baseUrl}`,
      ],
      {
        artifactName: "issue4434-create-fake-provider",
        env: {
          ...buildAvailabilityProbeEnv(),
          COMPATIBLE_API_KEY: "issue-4434-test-only",
        },
        timeoutMs: 30_000,
      },
    );
    expect(createProvider.exitCode, resultText(createProvider)).toBe(0);

    cleanup.add("delete issue #4434 fake inference provider", async () => {
      const removeProvider = await host.command(
        "openshell",
        ["provider", "delete", "-g", "nemoclaw", fakeProviderName],
        {
          artifactName: "cleanup-issue4434-delete-fake-provider",
          env: buildAvailabilityProbeEnv(),
          timeoutMs: 30_000,
        },
      );
      expect(
        removeProvider.exitCode,
        `failed to delete fake inference provider\n${resultText(removeProvider)}`,
      ).toBe(0);
    });
    cleanup.add("restore issue #4434 hosted inference route", async () => {
      const restoreRoute = await host.command(
        "openshell",
        [
          "inference",
          "set",
          "-g",
          "nemoclaw",
          "--no-verify",
          "--provider",
          hosted.providerName,
          "--model",
          hosted.model,
          "--timeout",
          originalRouteTimeout,
        ],
        {
          artifactName: "cleanup-issue4434-restore-inference-route",
          env: buildAvailabilityProbeEnv(),
          timeoutMs: 30_000,
        },
      );
      expect(
        restoreRoute.exitCode,
        `failed to restore hosted inference route\n${resultText(restoreRoute)}`,
      ).toBe(0);
    });

    const updateRoute = await host.command(
      "openshell",
      [
        "inference",
        "set",
        "-g",
        "nemoclaw",
        "--no-verify",
        "--provider",
        fakeProviderName,
        "--model",
        hosted.model,
        "--timeout",
        "15",
      ],
      {
        artifactName: "issue4434-route-to-fake-endpoint",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(updateRoute.exitCode, resultText(updateRoute)).toBe(0);

    let fakeRouteProbeAttempt = 0;
    let fakeRouteProbeExitCode: number | null | undefined;
    let fakeRouteProbeText = "";
    await expect
      .poll(
        async () => {
          fakeRouteProbeAttempt += 1;
          const fakeRoutePayload = chatCompletionPayload(
            hosted.model,
            `Reply through ${fakeProviderName}, attempt ${fakeRouteProbeAttempt}.`,
          );
          const probe = await sandbox.execShell(
            instance.sandboxName,
            trustedSandboxShellScript(
              `command -v curl >/dev/null && curl -fsS --max-time 30 https://inference.local/v1/chat/completions -H 'Content-Type: application/json' -d ${shellSingleQuote(fakeRoutePayload)} >/dev/null`,
            ),
            {
              artifactName: `issue4434-inference-local-through-fake-endpoint-${fakeRouteProbeAttempt}`,
              env: buildAvailabilityProbeEnv(),
              timeoutMs: 45_000,
            },
          );
          fakeRouteProbeExitCode = probe.exitCode;
          fakeRouteProbeText = resultText(probe);
          return fake
            .requests()
            .some(
              (request) =>
                request.method === "POST" &&
                ["/chat/completions", "/v1/chat/completions"].includes(request.path),
            );
        },
        {
          interval: 1_000,
          message: "managed inference route did not refresh to the fake provider",
          timeout: 45_000,
        },
      )
      .toBe(true);
    expect(
      fakeRouteProbeExitCode,
      `inference.local reached the fake provider with a failed response\n${fakeRouteProbeText}`,
    ).toBe(0);
    const fakeRequests = fake.requests();
    await artifacts.writeJson("issue4434-fake-openai-requests.json", fakeRequests);

    await closeFake();

    const failedManagedRouteProbe = await sandbox.execShell(
      instance.sandboxName,
      trustedSandboxShellScript(
        `command -v curl >/dev/null && curl -fsS --connect-timeout 5 --max-time 30 https://inference.local/v1/chat/completions -H 'Content-Type: application/json' -d ${shellSingleQuote(failedRoutePayload)} >/dev/null`,
      ),
      {
        artifactName: "issue4434-inference-local-after-fake-endpoint-stopped",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 45_000,
      },
    );
    expect(
      failedManagedRouteProbe.exitCode,
      `inference.local remained healthy after its configured provider stopped\n${resultText(failedManagedRouteProbe)}`,
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
    await artifacts.target.complete({
      id: "issue-4434-tui-unreachable-inference",
      expectExitCode: tui.exitCode,
      visibleError: analysis.visibleError,
      connectedSpinner: analysis.connectedSpinner,
      issue4434Signature: analysis.issue4434Signature,
      lastStatusLine: analysis.lastStatusLine,
      finalStatusIsError: analysis.finalStatusIsError,
      finalStatusIsConnectedSpinner: analysis.finalStatusIsConnectedSpinner,
      finalErrorBlock: analysis.finalErrorBlock,
      diagnosticFields: analysis.diagnosticFields,
    });

    const failureContext = [
      `expect exit=${tui.exitCode}`,
      `capture=${captureFile}`,
      `lastStatusLine=${analysis.lastStatusLine}`,
      `finalErrorBlock=${analysis.finalErrorBlock}`,
      `diagnosticFields=${JSON.stringify(analysis.diagnosticFields)}`,
      "plain capture:",
      analysis.plain,
    ].join("\n");

    expect(
      hasFullIssue4434Diagnostics(analysis.diagnosticFields),
      "OpenClaw TUI output must include full #4434 diagnostic fields: HTTP/cause, gateway/upstream layer, and recovery hint",
    ).toBe(true);
    expect(analysis.visibleError, failureContext).toBe(true);
    expect(tui.exitCode, failureContext).toBe(0);
    expect(analysis.issue4434Signature, failureContext).toBe(false);
    expect(analysis.lastStatusLine, failureContext).not.toBe("");
    expect(analysis.finalStatusIsConnectedSpinner, failureContext).toBe(false);
    expect(analysis.finalStatusIsError, failureContext).toBe(true);
  },
);
