// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

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
import { isTransientProviderValidationFailure } from "./network-policy-transient-provider.ts";

export const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-brave-search";
validateSandboxName(SANDBOX_NAME);
const INSTALL_ATTEMPTS = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true" ? 3 : 1;
const PLACEHOLDER_PATTERN = /^openshell:resolve:env:([A-Za-z0-9_]+_)?BRAVE_API_KEY$/;

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

function parsePlaceholder(configText: string): string | undefined {
  const parsed = JSON.parse(configText) as {
    tools?: { web?: { search?: { apiKey?: unknown } } };
  };
  const value = parsed.tools?.web?.search?.apiKey;
  return typeof value === "string" && value ? value : undefined;
}

function firstJsonObject(output: string): unknown {
  for (let start = output.indexOf("{"); start >= 0; start = output.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < output.length; index += 1) {
      const char = output[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(output.slice(start, index + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return undefined;
}

function collectAssistantText(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(collectAssistantText);
  const record = value as Record<string, unknown>;
  const texts: string[] = [];
  for (const key of [
    "result",
    "payloads",
    "messages",
    "choices",
    "message",
    "delta",
    "content",
    "text",
  ]) {
    if (key in record) texts.push(...collectAssistantText(record[key]));
  }
  return texts;
}

export function extractOpenClawAgentText(output: string): string {
  return collectAssistantText(firstJsonObject(output))[0] ?? "";
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
        timeoutMs: 20 * 60_000,
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

export interface SecretFingerprint {
  byteLength: number;
  sha256: string;
}

export function fingerprintSecret(secret: string): SecretFingerprint {
  return {
    byteLength: Buffer.byteLength(secret, "utf8"),
    sha256: createHash("sha256").update(secret, "utf8").digest("hex"),
  };
}

export async function assertRawConfigHasNoSecret(
  sandbox: SandboxClient,
  fingerprint: SecretFingerprint,
): Promise<void> {
  const rawLeakCheck = await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript(
      `python3 - <<'PY'
import hashlib
from pathlib import Path

body = Path('/sandbox/.openclaw/openclaw.json').read_bytes()
needle_length = ${fingerprint.byteLength}
needle_sha256 = '${fingerprint.sha256}'
found = any(
    hashlib.sha256(body[offset : offset + needle_length]).hexdigest() == needle_sha256
    for offset in range(max(0, len(body) - needle_length + 1))
)
raise SystemExit(1 if found else 0)
PY`,
    ),
    {
      artifactName: "phase-3-openclaw-config-raw-secret-leak-check",
      env: commandEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(rawLeakCheck.exitCode, "raw BRAVE_API_KEY must not appear anywhere in openclaw.json").toBe(
    0,
  );
}

export function assertBraveConfig(configText: string): string {
  const parsedConfig = JSON.parse(configText) as {
    tools?: { web?: { search?: { enabled?: unknown; provider?: unknown; apiKey?: unknown } } };
  };
  const searchConfig = parsedConfig.tools?.web?.search;
  expect(searchConfig?.enabled, configText).toBe(true);
  expect(searchConfig?.provider, configText).toBe("brave");
  const placeholder = parsePlaceholder(configText);
  expect(placeholder, configText).toMatch(PLACEHOLDER_PATTERN);
  return placeholder ?? "";
}

export function assertOptionalBraveEnv(value: string, braveKey: string): void {
  expect(value).not.toContain(braveKey);
  value.trim() && expect(value.trim()).toMatch(PLACEHOLDER_PATTERN);
}

/**
 * Runs the same OpenClaw turn used to prove Brave Search works while checking
 * the live agent process environment against a one-way fingerprint. The check
 * runs before the process exits and returns only an exit status; the raw key is
 * never copied into the sandbox as test material.
 */
export async function runBraveAgentWithSecretBoundaryCheck(
  sandbox: SandboxClient,
  fingerprint: SecretFingerprint,
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
    python3 - "/proc/$agent_pid/environ" ${fingerprint.byteLength} ${fingerprint.sha256} <<'PY' || probe_rc=$?
import hashlib
from pathlib import Path
import sys

try:
    body = Path(sys.argv[1]).read_bytes()
except OSError:
    raise SystemExit(97)
needle_length = int(sys.argv[2])
needle_sha256 = sys.argv[3]
found = any(
    hashlib.sha256(body[offset : offset + needle_length]).hexdigest() == needle_sha256
    for offset in range(max(0, len(body) - needle_length + 1))
)
raise SystemExit(98 if found else 0)
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
 * while it is alive. This follow-up scan checks two additional surfaces:
 *   1. a fresh login-style shell environment, widened to every variable name;
 *   2. the OpenClaw config/state tree the agent can `cat`.
 *
 * The scan compares fixed-length windows to a one-way SHA-256 fingerprint and
 * returns only an exit code. The raw key is never copied into the sandbox as
 * test material, so the test itself does not create an agent-readable secret
 * channel. Exit 0 means the key is absent from the tested surfaces; exit 1 means
 * it is present and could be disclosed. The
 * `openshell:resolve:env:BRAVE_API_KEY` placeholder is a reference, not the
 * secret, so it never trips the scan.
 */
export async function assertBraveKeyAbsentFromAgentSurfaces(
  sandbox: SandboxClient,
  fingerprint: SecretFingerprint,
  redactionValues: string[],
): Promise<void> {
  const probe = await sandboxShell(
    sandbox,
    `python3 - ${fingerprint.byteLength} ${fingerprint.sha256} <<'PY'
import hashlib
import os
from pathlib import Path
import sys

needle_length = int(sys.argv[1])
needle_sha256 = sys.argv[2]

def contains_secret(body):
    return any(
        hashlib.sha256(body[offset : offset + needle_length]).hexdigest() == needle_sha256
        for offset in range(max(0, len(body) - needle_length + 1))
    )

shell_environment = b'\\0'.join(key + b'=' + value for key, value in os.environb.items())
if contains_secret(shell_environment):
    raise SystemExit(1)

for candidate in Path('/sandbox/.openclaw').rglob('*'):
    if not candidate.is_file():
        continue
    try:
        body = candidate.read_bytes()
    except OSError:
        raise SystemExit(97)
    if contains_secret(body):
        raise SystemExit(1)
PY`,
    { artifactName: "phase-4c-agent-readable-key-scan", timeoutMs: 60_000, redactionValues },
  );
  expect(
    probe.exitCode,
    "the real Brave key is present in the sandbox shell environment or OpenClaw config/state tree",
  ).toBe(0);
}

export function assertBraveResponse(body: string): void {
  const status = body.match(/HTTP_STATUS:(\d{3})/)?.[1];
  expect(status, body).toBe("200");
  const json = body.replace(/\n?HTTP_STATUS:\d{3}\s*$/u, "");
  const braveResponse = JSON.parse(json) as { web?: { results?: unknown[] } };
  expect(braveResponse.web?.results?.length ?? 0, json.slice(0, 500)).toBeGreaterThan(0);
}
