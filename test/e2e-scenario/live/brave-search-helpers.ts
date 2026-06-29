// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { resultText } from "../fixtures/clients/index.ts";
import {
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect } from "../fixtures/e2e-test.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { isTransientProviderValidationFailure } from "./network-policy-transient-provider.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
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

export async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup should not mask primary failures.
  }
}

function singleLineShell(script: string): string {
  const encoded = Buffer.from(script, "utf8").toString("base64");
  return `tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT; printf %s '${encoded}' | base64 -d > "$tmp"; sh "$tmp"`;
}

export async function sandboxShell(
  sandbox: SandboxClient,
  script: string,
  options: { artifactName: string; timeoutMs?: number; redactionValues?: string[] },
): Promise<ShellProbeResult> {
  return await sandbox.execShell(SANDBOX_NAME, trustedSandboxShellScript(singleLineShell(script)), {
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
  await bestEffort(() =>
    host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "cleanup-nemoclaw-destroy-brave-search",
      env: commandEnv(),
      timeoutMs: 120_000,
    }),
  );
  await bestEffort(() =>
    sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "cleanup-openshell-delete-brave-search",
      env: commandEnv(),
      timeoutMs: 60_000,
    }),
  );
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

export async function uploadSecretForLeakCheck(
  sandbox: SandboxClient,
  cleanup: { add(name: string, run: () => Promise<void> | void): void },
  braveKey: string,
  redactionValues: string[],
): Promise<string> {
  const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-brave-secret-"));
  const secretFile = path.join(secretDir, "brave-key");
  fs.writeFileSync(secretFile, braveKey, { mode: 0o600 });
  const remoteSecretFile = "/tmp/nemoclaw-brave-key-leak-check";
  cleanup.add("remove temporary Brave leak-check secret", async () => {
    fs.rmSync(secretDir, { recursive: true, force: true });
    await bestEffort(() =>
      sandbox.execShell(SANDBOX_NAME, trustedSandboxShellScript(`rm -f ${remoteSecretFile}`), {
        artifactName: "cleanup-brave-leak-secret",
        env: commandEnv(),
        timeoutMs: 30_000,
      }),
    );
  });
  const uploadSecret = await sandbox.upload(SANDBOX_NAME, secretFile, remoteSecretFile, {
    artifactName: "phase-3-upload-brave-leak-secret",
    env: commandEnv(),
    redactionValues,
    timeoutMs: 30_000,
  });
  expect(uploadSecret.exitCode, resultText(uploadSecret)).toBe(0);
  return remoteSecretFile;
}

export async function assertRawConfigHasNoSecret(
  sandbox: SandboxClient,
  remoteSecretFile: string,
): Promise<void> {
  const rawLeakCheck = await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript(
      `python3 - <<'PY'
from pathlib import Path
needle = Path('${remoteSecretFile}').read_text(encoding='utf-8')
body = Path('/sandbox/.openclaw/openclaw.json').read_text(encoding='utf-8')
raise SystemExit(1 if needle in body else 0)
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

export function assertBraveResponse(body: string): void {
  const status = body.match(/HTTP_STATUS:(\d{3})/)?.[1];
  expect(status, body).toBe("200");
  const json = body.replace(/\n?HTTP_STATUS:\d{3}\s*$/u, "");
  const braveResponse = JSON.parse(json) as { web?: { results?: unknown[] } };
  expect(braveResponse.web?.results?.length ?? 0, json.slice(0, 500)).toBeGreaterThan(0);
}
