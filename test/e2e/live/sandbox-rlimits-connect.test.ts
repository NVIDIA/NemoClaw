// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "test-490817";
const LIVE_TIMEOUT_MS = 45 * 60_000;
const runConnectRlimitTest = process.env.NEMOCLAW_E2E_CONNECT_RLIMITS === "1" ? test : test.skip;

validateSandboxName(SANDBOX_NAME);

function numericProbe(text: string, key: string): number {
  const match = text.match(new RegExp(`${key}=(\\d+)`));
  expect(match, `Missing ${key} in connect output:\n${text}`).not.toBeNull();
  return Number(match?.[1] ?? "NaN");
}

function expectNoRlimitStartupDiagnostics(text: string): void {
  expect(text, "connect shell startup must not print rlimit security diagnostics").not.toMatch(
    /\[SECURITY\].*(?:Effective|Could not set).*(?:nproc|nofile).*limit/iu,
  );
}

function connectAcceptanceScript(cliPath: string, sandboxName: string): string {
  const cli = JSON.stringify(cliPath);
  const sandbox = JSON.stringify(sandboxName);
  return [
    "set -euo pipefail",
    `cat <<'NEMOCLAW_CONNECT_RLIMITS' | ${cli} ${sandbox} connect`,
    "set -euo pipefail",
    'printf "__NEMOCLAW_RLIMIT_CONNECT_BEGIN__\\n"',
    'bash -lc \'printf "login_nproc=%s\\nlogin_nofile=%s\\n" "$(ulimit -u)" "$(ulimit -n)"; ulimit -a\'',
    'bash -ic \'printf "interactive_nproc=%s\\ninteractive_nofile=%s\\n" "$(ulimit -u)" "$(ulimit -n)"\' 2>&1',
    'fork_log="$(mktemp)"',
    "pids=()",
    'for i in $(seq 1 5000); do sleep 60 & pids+=("$!"); done 2>"$fork_log" || true',
    'tail -5 "$fork_log"',
    'for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done',
    'rm -f "$fork_log"',
    'printf "__NEMOCLAW_RLIMIT_CONNECT_END__\\n"',
    "exit",
    "NEMOCLAW_CONNECT_RLIMITS",
  ].join("\n");
}

runConnectRlimitTest(
  "connect shell enforces sandbox rlimits through rebuilt OpenClaw runtime (#2173)",
  { timeout: LIVE_TIMEOUT_MS },
  async ({ artifacts, cleanup, host, secrets }) => {
    const apiKey = secrets.required("NVIDIA_API_KEY");
    const redactionValues = secrets.redactionValues([apiKey]);
    await artifacts.target.declare({
      id: "sandbox-rlimits-connect",
      issue: 2173,
      optIn: "NEMOCLAW_RUN_LIVE_E2E=1 NEMOCLAW_E2E_CONNECT_RLIMITS=1",
      sandboxName: SANDBOX_NAME,
      acceptancePath: [
        "nemoclaw onboard --non-interactive --yes-i-accept-third-party-software",
        `nemoclaw ${SANDBOX_NAME} connect`,
        "bash -lc 'ulimit -u; ulimit -n'",
        "bash -ic 'ulimit -u; ulimit -n'",
        "ulimit -a",
        "shell startup does not emit [SECURITY] rlimit diagnostics before user commands",
        "for i in $(seq 1 5000); do sleep 60 & done 2>&1 | tail -5",
      ],
      hermesCoverage:
        "Hermes copies scripts/lib/sandbox-rlimits.sh and installs the same /etc/profile.d plus /etc/bash.bashrc shims; test/sandbox-rlimit-hooks.test.ts covers Hermes stale-base replay.",
    });

    const docker = await host.command("docker", ["info"], {
      artifactName: "phase-0-docker-info",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    expect(docker.exitCode, resultText(docker)).toBe(0);

    cleanup.add("remove rlimit acceptance sandbox", () =>
      host.bestEffortCleanupSandbox(SANDBOX_NAME, {
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 15 * 60_000,
      }),
    );
    await host.bestEffortCleanupSandbox(SANDBOX_NAME, {
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 15 * 60_000,
    });

    const onboard = await host.nemoclaw(
      ["onboard", "--non-interactive", "--yes", "--yes-i-accept-third-party-software"],
      {
        artifactName: "phase-1-onboard",
        env: {
          ...buildAvailabilityProbeEnv(),
          NVIDIA_API_KEY: apiKey,
          NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
          NEMOCLAW_AGENT: "openclaw",
          NEMOCLAW_POLICY_MODE: "suggested",
          NEMOCLAW_PROVIDER: "build",
          NEMOCLAW_RECREATE_SANDBOX: "1",
          NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
        },
        redactionValues,
        timeoutMs: 25 * 60_000,
      },
    );
    expect(onboard.exitCode, resultText(onboard)).toBe(0);

    const connect = await host.command(
      "bash",
      ["-lc", connectAcceptanceScript(host.commandPath, SANDBOX_NAME)],
      {
        artifactName: "phase-2-connect-rlimits",
        env: buildAvailabilityProbeEnv(),
        redactionValues,
        timeoutMs: 10 * 60_000,
      },
    );
    const output = resultText(connect);
    await artifacts.writeText("connect-rlimits-output.txt", output);
    expect(connect.exitCode, output).toBe(0);
    expect(output).toContain("__NEMOCLAW_RLIMIT_CONNECT_BEGIN__");
    expect(output).toContain("__NEMOCLAW_RLIMIT_CONNECT_END__");
    expectNoRlimitStartupDiagnostics(output);

    expect(numericProbe(output, "login_nproc")).toBeLessThanOrEqual(4096);
    expect(numericProbe(output, "login_nofile")).toBeLessThanOrEqual(65536);
    expect(numericProbe(output, "interactive_nproc")).toBeLessThanOrEqual(4096);
    expect(numericProbe(output, "interactive_nofile")).toBeLessThanOrEqual(65536);
    expect(output).toMatch(/Resource temporarily unavailable|fork: retry|fork/i);
  },
);
