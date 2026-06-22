// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Live Vitest replacement for test/e2e/test-telegram-injection.sh. */

import path from "node:path";

import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import {
  base64,
  bestEffort,
  CLI,
  COMMAND_TIMEOUT_MS,
  cleanupSandbox,
  dockerInfo,
  expectExitZero,
  expectSandboxReady,
  installSandboxOrSkipOnRateLimit,
  phase6Env,
  REPO_ROOT,
  redactionValues,
  resultText,
  sandboxSh,
  shellQuote,
} from "./phase6-messaging-helpers.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-telegram-injection";
const LIVE_TIMEOUT_MS = 35 * 60_000;

function openshellStdinCommand(payload: string, remoteShell: string): string {
  return [
    "set -euo pipefail",
    `printf %s ${shellQuote(base64(payload))} | base64 -d | openshell sandbox exec --name ${shellQuote(SANDBOX_NAME)} -- sh -lc ${shellQuote(remoteShell)}`,
  ].join("; ");
}

function openshellSshStdinCommand(payload: string, remoteShell: string): string {
  return [
    "set -euo pipefail",
    'ssh_config="$(mktemp)"',
    `trap 'rm -f "$ssh_config"' EXIT`,
    `openshell sandbox ssh-config ${shellQuote(SANDBOX_NAME)} > "$ssh_config"`,
    [
      `printf %s ${shellQuote(base64(payload))} | base64 -d`,
      "| timeout 30s ssh",
      '-F "$ssh_config"',
      "-o StrictHostKeyChecking=no",
      "-o UserKnownHostsFile=/dev/null",
      "-o ConnectTimeout=10",
      "-o LogLevel=ERROR",
      shellQuote(`openshell-${SANDBOX_NAME}`),
      shellQuote(remoteShell),
    ].join(" "),
  ].join("; ");
}

async function sendPayloadViaSandboxStdin(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  payload: string,
  remoteShell: string,
  env: NodeJS.ProcessEnv,
  artifactName: string,
  redactions: string[],
) {
  return host.command("bash", ["-lc", openshellStdinCommand(payload, remoteShell)], {
    artifactName,
    env,
    redactionValues: redactions,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
}

async function sendPayloadViaOpenShellSshStdin(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  payload: string,
  remoteShell: string,
  env: NodeJS.ProcessEnv,
  artifactName: string,
  redactions: string[],
) {
  return host.command("bash", ["-lc", openshellSshStdinCommand(payload, remoteShell)], {
    artifactName,
    env,
    redactionValues: redactions,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
}

async function assertParameterPayloadStaysLiteral(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  env: NodeJS.ProcessEnv,
  redactions: string[],
): Promise<void> {
  const payload = "${NVIDIA_INFERENCE_API_KEY}";
  const command = [
    "set -euo pipefail",
    'prefix="${NVIDIA_INFERENCE_API_KEY:0:15}"',
    `out="$(printf %s "\${PAYLOAD_B64}" | base64 -d | openshell sandbox exec --name ${shellQuote(SANDBOX_NAME)} -- sh -lc 'MSG=$(cat) && echo "$MSG"' 2>&1)"`,
    'if printf %s "$out" | grep -Fq "$prefix"; then echo SECRET_LEAK; exit 20; fi',
    'printf "%s\\n" "$out"',
  ].join("; ");
  const result = await host.command("bash", ["-lc", command], {
    artifactName: "parameter-expansion-payload",
    env: { ...env, PAYLOAD_B64: base64(payload), SANDBOX_NAME },
    redactionValues: redactions,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  expect(result.exitCode, resultText(result)).toBe(0);
  expect(resultText(result)).not.toContain("SECRET_LEAK");
  expect(resultText(result)).toContain(payload);
}

async function assertSshParameterPayloadStaysLiteral(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  env: NodeJS.ProcessEnv,
  redactions: string[],
): Promise<void> {
  const payload = "${NVIDIA_INFERENCE_API_KEY}";
  const command = [
    "set -euo pipefail",
    'prefix="${NVIDIA_INFERENCE_API_KEY:0:15}"',
    'ssh_config="$(mktemp)"',
    'out_file="$(mktemp)"',
    `trap 'rm -f "$ssh_config" "$out_file"' EXIT`,
    `openshell sandbox ssh-config ${shellQuote(SANDBOX_NAME)} > "$ssh_config"`,
    [
      `printf %s ${shellQuote(base64(payload))} | base64 -d`,
      "| timeout 30s ssh",
      '-F "$ssh_config"',
      "-o StrictHostKeyChecking=no",
      "-o UserKnownHostsFile=/dev/null",
      "-o ConnectTimeout=10",
      "-o LogLevel=ERROR",
      shellQuote(`openshell-${SANDBOX_NAME}`),
      shellQuote('MSG=$(cat) && echo "$MSG"'),
      '> "$out_file" 2>&1',
    ].join(" "),
    'if grep -Fq "$prefix" "$out_file"; then echo SECRET_LEAK; exit 23; fi',
    'cat "$out_file"',
  ].join("; ");
  const result = await host.command("bash", ["-lc", command], {
    artifactName: "ssh-parameter-expansion-payload",
    env,
    redactionValues: redactions,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  expect(result.exitCode, resultText(result)).toBe(0);
  expect(resultText(result)).not.toContain("SECRET_LEAK");
  expect(resultText(result)).toContain(payload);
}

async function assertHostProcessTableDoesNotExposeSecret(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  env: NodeJS.ProcessEnv,
  redactions: string[],
): Promise<void> {
  const command = [
    "set -euo pipefail",
    'prefix="${NVIDIA_INFERENCE_API_KEY:0:15}"',
    'matches="$(ps aux 2>/dev/null | grep -F "$prefix" | grep -v grep || true)"',
    'if [ -n "$matches" ]; then echo SECRET_LEAK; exit 21; fi',
    "echo SECRET_ABSENT",
  ].join("; ");
  const result = await host.command("bash", ["-lc", command], {
    artifactName: "host-process-table-telegram-injection",
    env,
    redactionValues: redactions,
    timeoutMs: 30_000,
  });
  expect(result.exitCode, resultText(result)).toBe(0);
  expect(result.stdout.trim(), resultText(result)).toBe("SECRET_ABSENT");
}

async function assertSandboxProcessTableDoesNotExposeSecret(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  env: NodeJS.ProcessEnv,
  redactions: string[],
): Promise<void> {
  const command = [
    "set -euo pipefail",
    'prefix="${NVIDIA_INFERENCE_API_KEY:0:15}"',
    `out="$(openshell sandbox exec --name ${shellQuote(SANDBOX_NAME)} -- sh -lc 'ps aux' 2>&1)"`,
    'if printf %s "$out" | grep -Fq "$prefix"; then echo SECRET_LEAK; exit 22; fi',
    "echo SECRET_ABSENT",
  ].join("; ");
  const result = await host.command("bash", ["-lc", command], {
    artifactName: "sandbox-process-table-telegram-injection",
    env: { ...env, SANDBOX_NAME },
    redactionValues: redactions,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  expect(result.exitCode, resultText(result)).toBe(0);
  expect(result.stdout.trim(), resultText(result)).toBe("SECRET_ABSENT");
}

test.skipIf(!shouldRunLiveE2EScenarios())(
  "Telegram bridge-style message handling treats shell metacharacters as data",
  { timeout: LIVE_TIMEOUT_MS },
  async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
    const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
    const env = phase6Env({
      sandboxName: SANDBOX_NAME,
      agent: "openclaw",
      apiKey,
    });
    const redactions = redactionValues(apiKey);

    await artifacts.writeJson("scenario.json", {
      id: "telegram-injection",
      legacySource: "test/e2e/test-telegram-injection.sh",
      boundary:
        "install.sh OpenClaw sandbox + OpenShell sandbox exec and ssh-config stdin paths + process table and validateName probes",
      sandboxName: SANDBOX_NAME,
      contracts: [
        "command substitution payloads are literal input through exec and ssh-config paths and do not create files",
        "parameter expansion does not leak NVIDIA_INFERENCE_API_KEY",
        "host and sandbox process tables do not expose the API key after setup",
        "invalid sandbox names with shell metacharacters are rejected by validateName",
        "normal messages and benign special characters still pass through",
      ],
    });

    cleanup.add(`destroy telegram injection sandbox ${SANDBOX_NAME}`, () =>
      cleanupSandbox(host, SANDBOX_NAME, env, redactions, "cleanup-telegram-injection"),
    );
    await cleanupSandbox(host, SANDBOX_NAME, env, redactions, "preclean-telegram-injection");

    const docker = await dockerInfo(host, env);
    expect(docker.exitCode, resultText(docker)).toBe(0);

    const install = await installSandboxOrSkipOnRateLimit(
      host,
      env,
      redactions,
      "install-telegram-injection",
      skip,
      "NVIDIA endpoint validation was rate-limited before Telegram injection assertions ran",
    );
    expectExitZero(install, "install.sh --non-interactive");
    await expectSandboxReady(
      host,
      SANDBOX_NAME,
      env,
      redactions,
      "sandbox-list-telegram-injection",
    );

    for (const [label, marker, payload] of [
      [
        "command-substitution",
        "/tmp/injection-proof-t1",
        "$(touch /tmp/injection-proof-t1 && echo INJECTED)",
      ],
      ["backtick-substitution", "/tmp/injection-proof-t2", "`touch /tmp/injection-proof-t2`"],
      [
        "single-quote-breakout",
        "/tmp/injection-proof-t3",
        "'; touch /tmp/injection-proof-t3; echo '",
      ],
    ] as const) {
      await sandboxSh(sandbox, SANDBOX_NAME, `rm -f ${shellQuote(marker)}`, {
        artifactName: `remove-${label}-marker`,
        redactionValues: redactions,
      });
      const send = await sendPayloadViaSandboxStdin(
        host,
        payload,
        'MSG=$(cat) && echo "Received: $MSG"',
        env,
        `send-${label}-payload`,
        redactions,
      );
      expect(send.exitCode, resultText(send)).toBe(0);
      const markerCheck = await sandboxSh(
        sandbox,
        SANDBOX_NAME,
        `test -f ${shellQuote(marker)} && echo EXPLOITED || echo SAFE`,
        { artifactName: `check-${label}-marker`, redactionValues: redactions },
      );
      expectExitZero(markerCheck, `check ${label} marker`);
      expect(markerCheck.stdout.trim(), resultText(markerCheck)).toBe("SAFE");

      const sshMarker = marker.replace("/tmp/injection-proof-", "/tmp/injection-proof-ssh-");
      await sandboxSh(sandbox, SANDBOX_NAME, `rm -f ${shellQuote(sshMarker)}`, {
        artifactName: `remove-${label}-ssh-marker`,
        redactionValues: redactions,
      });
      const sshPayload = payload.replace(marker, sshMarker);
      const sshSend = await sendPayloadViaOpenShellSshStdin(
        host,
        sshPayload,
        'MSG=$(cat) && echo "Received: $MSG"',
        env,
        `send-${label}-ssh-payload`,
        redactions,
      );
      expect(sshSend.exitCode, resultText(sshSend)).toBe(0);
      const sshMarkerCheck = await sandboxSh(
        sandbox,
        SANDBOX_NAME,
        `test -f ${shellQuote(sshMarker)} && echo EXPLOITED || echo SAFE`,
        {
          artifactName: `check-${label}-ssh-marker`,
          redactionValues: redactions,
        },
      );
      expectExitZero(sshMarkerCheck, `check ${label} ssh marker`);
      expect(sshMarkerCheck.stdout.trim(), resultText(sshMarkerCheck)).toBe("SAFE");
    }

    await assertParameterPayloadStaysLiteral(host, env, redactions);
    await assertSshParameterPayloadStaysLiteral(host, env, redactions);
    await assertHostProcessTableDoesNotExposeSecret(host, env, redactions);
    await assertSandboxProcessTableDoesNotExposeSecret(host, env, redactions);

    const invalidNames = [
      "foo;rm -rf /",
      "--help",
      "$(whoami)",
      "`id`",
      "foo bar",
      "../etc/passwd",
      "UPPERCASE",
    ];
    for (const invalidName of invalidNames) {
      const validation = await host.command(
        "node",
        [
          "-e",
          `const { validateName } = require(${JSON.stringify(path.join(REPO_ROOT, "dist/lib/runner"))});\ntry { validateName(process.argv[1], "SANDBOX_NAME"); console.log("ACCEPTED"); } catch (error) { console.log("REJECTED:" + error.message); }`,
          "--",
          invalidName,
        ],
        {
          artifactName: `validate-name-${invalidName.replace(/[^a-z0-9]+/gi, "-")}`,
          env,
          redactionValues: redactions,
          timeoutMs: 30_000,
        },
      );
      expectExitZero(validation, `validateName ${invalidName}`);
      expect(validation.stdout, invalidName).toContain("REJECTED");
    }

    const normal = await sendPayloadViaSandboxStdin(
      host,
      "Hello, what is two plus two?",
      'MSG=$(cat) && echo "Received: $MSG"',
      env,
      "normal-message-passthrough",
      redactions,
    );
    expect(normal.exitCode, resultText(normal)).toBe(0);
    expect(resultText(normal)).toContain("Hello, what is two plus two?");

    const special = await sendPayloadViaSandboxStdin(
      host,
      "What's the meaning of life? It costs $5 & is 100% free!",
      'MSG=$(cat) && echo "$MSG"',
      env,
      "special-message-passthrough",
      redactions,
    );
    expect(special.exitCode, resultText(special)).toBe(0);
    expect(resultText(special).trim()).not.toBe("");

    await bestEffort(() =>
      host.command("node", [CLI, SANDBOX_NAME, "status"], {
        artifactName: "post-assert-status-telegram-injection",
        env,
        redactionValues: redactions,
        timeoutMs: 60_000,
      }),
    );
  },
);
