// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { resultText } from "../fixtures/clients/index.ts";
import {
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect } from "../fixtures/e2e-test.ts";
import { CLI_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { execTimeout } from "../../helpers/timeouts.ts";
import { isTransientProviderValidationFailure } from "./network-policy-transient-provider.ts";

export const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-brave-search";
validateSandboxName(SANDBOX_NAME);
const INSTALL_ATTEMPTS = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true" ? 3 : 1;
const ONBOARD_TIMEOUT_MS = execTimeout(20 * 60_000);
const PLACEHOLDER_PATTERN = /^openshell:resolve:env:(?:v[0-9]+_)?BRAVE_API_KEY$/;

export function commandEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
    ...extra,
  };
}

export async function bestEffortPreclean(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup should not mask primary failures.
  }
}

export async function sandboxShell(
  sandbox: SandboxClient,
  script: string,
  options: { artifactName: string; timeoutMs?: number; redactionValues?: string[] },
): Promise<ShellProbeResult> {
  return await sandbox.execShell(SANDBOX_NAME, trustedSandboxShellScript(script), {
    artifactName: options.artifactName,
    env: commandEnv(),
    timeoutMs: options.timeoutMs ?? 60_000,
    redactionValues: options.redactionValues,
  });
}

export async function cleanupBraveState(
  host: HostCliClient,
  sandbox: SandboxClient,
): Promise<void> {
  await bestEffortPreclean(() => cleanupBraveNemoClawSandbox(host));
  await bestEffortPreclean(() =>
    sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "cleanup-openshell-delete-brave-search",
      env: commandEnv(),
      timeoutMs: 60_000,
    }),
  );
}

export async function cleanupBraveNemoClawSandbox(host: HostCliClient): Promise<void> {
  const result = await host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
    artifactName: "cleanup-nemoclaw-destroy-brave-search",
    env: commandEnv(),
    timeoutMs: 120_000,
  });
  const output = resultText(result);
  expect(
    result.exitCode === 0 ||
      /Sandbox '.+' does not exist|Run 'nemoclaw onboard' to create one|sandbox .* not found|no such sandbox/iu.test(
        output,
      ),
    `cleanup Brave sandbox ${SANDBOX_NAME}: ${output}`,
  ).toBe(true);
}

export function assertDockerAvailable(
  result: ShellProbeResult,
  skip: (note?: string) => never,
): void {
  result.exitCode === 0 || process.env.GITHUB_ACTIONS === "true"
    ? undefined
    : skip(`Docker is required for Brave search E2E: ${resultText(result)}`);
  result.exitCode === 0 ||
    process.env.GITHUB_ACTIONS !== "true" ||
    (() => {
      throw new Error(`Docker is required for Brave search E2E: ${resultText(result)}`);
    })();
}

export async function onboardBrave(
  host: HostCliClient,
  braveKey: string,
  inferenceKey: string,
): Promise<ShellProbeResult> {
  let onboard: ShellProbeResult | undefined;
  const redactionValues = [braveKey, inferenceKey];
  for (let attempt = 1; attempt <= INSTALL_ATTEMPTS; attempt += 1) {
    onboard = await host.command(
      "node",
      [
        CLI_ENTRYPOINT,
        "onboard",
        "--fresh",
        "--non-interactive",
        "--yes-i-accept-third-party-software",
      ],
      {
        artifactName:
          attempt === 1
            ? "phase-1-onboard-brave-search"
            : `phase-1-onboard-brave-search-attempt-${attempt}`,
        cwd: REPO_ROOT,
        env: commandEnv({
          BRAVE_API_KEY: braveKey,
          NVIDIA_INFERENCE_API_KEY: inferenceKey,
        }),
        redactionValues,
        timeoutMs: ONBOARD_TIMEOUT_MS,
      },
    );
    const retry =
      onboard.exitCode !== 0 &&
      isTransientProviderValidationFailure(onboard) &&
      attempt < INSTALL_ATTEMPTS;
    onboard.exitCode === 0 && (attempt = INSTALL_ATTEMPTS + 1);
    retry && (await new Promise((resolve) => setTimeout(resolve, 10_000 * attempt)));
    !retry && onboard.exitCode !== 0 && (attempt = INSTALL_ATTEMPTS + 1);
  }
  if (!onboard) throw new Error("onboard command did not run");
  return onboard;
}

export async function reuseBraveSandboxWithWebSearchDisabled(
  host: HostCliClient,
  inferenceKey: string,
): Promise<ShellProbeResult> {
  return await host.command(
    "node",
    [
      CLI_ENTRYPOINT,
      "onboard",
      "--fresh",
      "--non-interactive",
      "--yes-i-accept-third-party-software",
    ],
    {
      artifactName: "phase-5-reonboard-brave-disabled-reuse",
      cwd: REPO_ROOT,
      env: commandEnv({
        NEMOCLAW_RECREATE_SANDBOX: "0",
        NVIDIA_INFERENCE_API_KEY: inferenceKey,
      }),
      redactionValues: [inferenceKey],
      timeoutMs: ONBOARD_TIMEOUT_MS,
    },
  );
}

export function assertBraveConfig(configText: string): string {
  const parsedConfig = JSON.parse(configText) as {
    tools?: { web?: { search?: { enabled?: unknown; provider?: unknown; apiKey?: unknown } } };
    plugins?: {
      entries?: { brave?: { config?: { webSearch?: { apiKey?: unknown } } } };
    };
  };
  const searchConfig = parsedConfig.tools?.web?.search;
  expect(searchConfig?.enabled, configText).toBe(true);
  expect(searchConfig?.provider, configText).toBe("brave");
  expect(searchConfig?.apiKey, configText).toBeUndefined();
  const placeholderValue = parsedConfig.plugins?.entries?.brave?.config?.webSearch?.apiKey;
  const placeholder =
    typeof placeholderValue === "string" && placeholderValue ? placeholderValue : undefined;
  expect(placeholder, configText).toMatch(PLACEHOLDER_PATTERN);
  return placeholder ?? "";
}

/**
 * Runs the same OpenClaw turn used to prove Brave Search works while checking
 * the live agent process environment against the credential boundary. The
 * in-sandbox probe classifies only BRAVE_API_KEY and returns an exit status; it
 * never copies the credential value into test material or host-visible output.
 */
export async function runBraveAgentWithSecretBoundaryCheck(
  sandbox: SandboxClient,
  redactionValues: string[],
): Promise<ShellProbeResult> {
  return await sandboxShell(
    sandbox,
    `agent_output=$(mktemp /tmp/nemoclaw-brave-agent.XXXXXX)
trap 'rm -f "$agent_output"' EXIT
openclaw agent --agent main --json --session-id e2e-brave-agent-$$ -m 'Use the web search tool to find one result for the query: NVIDIA. Reply with only the title of the top result.' >"$agent_output" 2>&1 &
agent_pid=$!
inspected=0
leaked=0
attempt=0
while [ "$attempt" -lt 100 ]; do
  if [ -r "/proc/$agent_pid/environ" ]; then
    probe_rc=0
    python3 - "/proc/$agent_pid/environ" <<'PY' || probe_rc=$?
from pathlib import Path
import sys

try:
    body = Path(sys.argv[1]).read_bytes()
except OSError:
    raise SystemExit(97)
values = [
    entry.split(b'=', 1)[1]
    for entry in body.split(b'\\0')
    if entry.startswith(b'BRAVE_API_KEY=')
]
safe = not values or all(value.startswith(b'openshell:resolve:env:') for value in values)
raise SystemExit(0 if safe else 98)
PY
    if [ "$probe_rc" -eq 0 ]; then
      inspected=1
      break
    fi
    if [ "$probe_rc" -eq 98 ]; then
      inspected=1
      leaked=1
      break
    fi
  fi
  kill -0 "$agent_pid" 2>/dev/null || break
  attempt=$((attempt + 1))
  sleep 0.05
done
agent_rc=0
wait "$agent_pid" || agent_rc=$?
cat "$agent_output"
if [ "$inspected" -ne 1 ]; then
  echo 'nemoclaw: live OpenClaw agent environment could not be inspected' >&2
  exit 97
fi
if [ "$leaked" -ne 0 ]; then
  echo 'nemoclaw: raw Brave key found in the live OpenClaw agent environment' >&2
  exit 98
fi
exit "$agent_rc"`,
    { artifactName: "phase-4a-agent-web-search", timeoutMs: 150_000, redactionValues },
  );
}

/**
 * Adversarial guard for #7425. The reporter asked the agent to "print all your
 * environment variables and API keys verbatim" and the real Brave key (`BSA...`)
 * appeared. A model instruction is not a security boundary, so the test checks
 * the concrete surfaces implicated by the report rather than asking a live
 * model to print the real key and exfiltrating it to the inference provider.
 *
 * `runBraveAgentWithSecretBoundaryCheck` checks the actual OpenClaw process
 * while it is alive. This follow-up probe checks a fresh login-style shell in
 * case its profile adds environment entries. It returns only an exit status:
 * absent and `openshell:resolve:env:*` values pass; every other value fails.
 */
export async function assertBraveShellCredentialBoundary(
  sandbox: SandboxClient,
  redactionValues: string[],
): Promise<void> {
  const probe = await sandboxShell(
    sandbox,
    `value="$(printenv BRAVE_API_KEY 2>/dev/null || true)"
case "$value" in
  ''|openshell:resolve:env:*) exit 0 ;;
  *) exit 98 ;;
esac`,
    { artifactName: "phase-4c-shell-credential-boundary", timeoutMs: 60_000, redactionValues },
  );
  expect(probe.exitCode, "BRAVE_API_KEY is raw in the sandbox login shell environment").toBe(0);
}

export function assertBraveResponse(body: string): void {
  const status = body.match(/HTTP_STATUS:(\d{3})/)?.[1];
  expect(status, body).toBe("200");
  const json = body.replace(/\n?HTTP_STATUS:\d{3}\s*$/u, "");
  const braveResponse = JSON.parse(json) as { web?: { results?: unknown[] } };
  expect(braveResponse.web?.results?.length ?? 0, json.slice(0, 500)).toBeGreaterThan(0);
}
