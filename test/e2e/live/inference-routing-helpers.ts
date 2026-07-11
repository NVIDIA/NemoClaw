// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect } from "../fixtures/e2e-test.ts";
import { CLI_DIST_ENTRYPOINT, CLI_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";
import { redactString } from "../fixtures/redaction.ts";

// live conversion: direct CLI/onboard subprocesses plus OpenShell sandbox
// probes, with local helpers only where raw in-memory output is required to
// prove credential non-exposure before redacted artifacts are written.

const DIST_ENTRYPOINT = CLI_DIST_ENTRYPOINT;
const NEMOCLAW_STATE_DIR = path.join(os.homedir(), ".nemoclaw");
const ONBOARD_SESSION_FILE = path.join(NEMOCLAW_STATE_DIR, "onboard-session.json");
const ONBOARD_LOCK_FILE = path.join(NEMOCLAW_STATE_DIR, "onboard.lock");
const ONBOARD_ARGS = [
  "onboard",
  "--non-interactive",
  "--yes",
  "--yes-i-accept-third-party-software",
];
const STACK_TRACE_PATTERNS = [
  /^\s+at (Object\.|Module\.|node:internal|process\.)/m,
  /\bat node:internal/m,
];
const CREDENTIAL_CLASSIFICATION_PATTERN =
  /authorization|credential|invalid|401|unauthorized|api[._-]?key/i;
const TRANSPORT_CLASSIFICATION_PATTERN =
  /unreachable|timeout|connect|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|No route to host|transport|network|endpoint|dns/i;

function shouldRunProviderSmoke(provider: "openai" | "anthropic"): boolean {
  // The former shell script auto-ran these smokes when provider secrets were
  // present. This live migration requires an explicit opt-in so PR-safe jobs
  // cannot spend third-party quota accidentally; any future secret-backed lane
  // must set NEMOCLAW_INFERENCE_ROUTING_PROVIDER_SMOKE=all or a provider name.
  const requested = process.env.NEMOCLAW_INFERENCE_ROUTING_PROVIDER_SMOKE?.trim().toLowerCase();
  return requested === "1" || requested === "true" || requested === "all" || requested === provider;
}

type SkipFn = (note?: string) => void;

function skipLive(skip: SkipFn, note: string): never {
  skip(note);
  throw new Error(note);
}

interface RawRunResult {
  readonly command: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly redactedStdout: string;
  readonly redactedStderr: string;
}

interface RawRunOptions {
  readonly artifactName: string;
  readonly artifacts: ArtifactSink;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly redactionValues?: readonly string[];
  readonly timeoutMs?: number;
}

function redactedResultText(
  result: Pick<RawRunResult, "redactedStdout" | "redactedStderr">,
): string {
  return [result.redactedStdout, result.redactedStderr].filter(Boolean).join("\n");
}

function hasRawNodeStackTrace(text: string): boolean {
  return STACK_TRACE_PATTERNS.some((pattern) => pattern.test(text));
}

function inferenceSandboxName(prefix: string): string {
  const name = `${prefix}-${process.pid}`;
  validateSandboxName(name);
  return name;
}

function onboardEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    ...extra,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
  };
}

function clearOnboardState(): void {
  fs.rmSync(ONBOARD_LOCK_FILE, { force: true });
  fs.rmSync(ONBOARD_SESSION_FILE, { force: true });
}

function writeFakeOpenShellForBlueprintFailClosed(binDir: string): string {
  const commandLogPath = path.join(binDir, "openshell-commands.jsonl");
  const scriptPath = path.join(binDir, "openshell");
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(commandLogPath)}, JSON.stringify({ args: process.argv.slice(2) }) + "\\n");
process.exit(0);
`,
    { mode: 0o755 },
  );
  return commandLogPath;
}

function redactedCommand(command: readonly string[], values: readonly string[]): string[] {
  return command.map((part) => redactString(part, values));
}

async function runRawCommand(
  command: string,
  args: readonly string[],
  options: RawRunOptions,
): Promise<RawRunResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const redactionValues = [...(options.redactionValues ?? [])];
  const child = spawn(command, [...args], {
    cwd: options.cwd ?? REPO_ROOT,
    detached: true,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const fullCommand = [command, ...args];
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let spawnError: Error | undefined;

  const killProcessGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  };

  const timeout = setTimeout(() => {
    timedOut = true;
    killProcessGroup("SIGTERM");
    setTimeout(() => killProcessGroup("SIGKILL"), 1_000).unref();
  }, timeoutMs);
  timeout.unref();

  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.on("error", (error) => {
    spawnError = error;
  });

  const { exitCode, signal } = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.on("close", (code, closeSignal) => resolve({ exitCode: code, signal: closeSignal }));
  });
  clearTimeout(timeout);

  if (spawnError) {
    const message = redactString(spawnError.message, redactionValues);
    throw new Error(`failed to spawn ${redactString(command, redactionValues)}: ${message}`);
  }

  const redactedStdout = redactString(stdout, redactionValues);
  const redactedStderr = redactString(stderr, redactionValues);
  await options.artifacts.writeText(`raw-shell/${options.artifactName}.stdout.txt`, redactedStdout);
  await options.artifacts.writeText(`raw-shell/${options.artifactName}.stderr.txt`, redactedStderr);
  await options.artifacts.writeJson(`raw-shell/${options.artifactName}.result.json`, {
    command: redactedCommand(fullCommand, redactionValues),
    exitCode,
    signal,
    timedOut,
    stdout: redactedStdout,
    stderr: redactedStderr,
  });

  return {
    command: fullCommand,
    exitCode,
    signal,
    timedOut,
    stdout,
    stderr,
    redactedStdout,
    redactedStderr,
  };
}

async function runNemoclawCli(
  args: readonly string[],
  options: RawRunOptions,
): Promise<RawRunResult> {
  return runRawCommand(process.execPath, [CLI_ENTRYPOINT, ...args], options);
}

function rawOpenShellEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
    ...extra,
  };
}

async function runOpenShell(
  args: readonly string[],
  options: RawRunOptions,
): Promise<RawRunResult> {
  return runRawCommand("openshell", args, {
    ...options,
    env: rawOpenShellEnv(options.env),
  });
}

async function requireLivePrerequisites(host: HostCliClient, skip: SkipFn): Promise<void> {
  expect(
    fs.existsSync(DIST_ENTRYPOINT),
    "run `npm run build:cli` before live inference-routing targets",
  ).toBe(true);

  const docker = await host.command("docker", ["info"], {
    artifactName: "prereq-docker-info-inference-routing",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  if (docker.exitCode !== 0) {
    const message = `Docker is required for live inference-routing coverage: ${resultText(docker)}`;
    if (process.env.GITHUB_ACTIONS === "true") throw new Error(message);
    skipLive(skip, message);
  }

  try {
    const openshell = await host.command("openshell", ["--version"], {
      artifactName: "prereq-openshell-version-inference-routing",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    if (openshell.exitCode !== 0) {
      // A fresh GitHub runner may not have OpenShell before the first onboard;
      // `nemoclaw onboard` installs it. Record the prereq probe without blocking.
      return;
    }
  } catch {
    // Same as non-zero: fresh runner may not have openshell until onboard.
    return;
  }
}

interface CleanupSandboxOptions {
  readonly strict?: boolean;
}

function isExpectedPreOnboardCleanupMiss(text: string): boolean {
  return /does not exist|run 'nemoclaw onboard'|no active gateway|connection refused|not found|no such file|enoent/i.test(
    text,
  );
}

async function optionalCleanupStep(
  label: string,
  run: () => Promise<{ exitCode: number | null; stdout: string; stderr: string }>,
): Promise<void> {
  try {
    const result = await run();
    if (result.exitCode === 0) return;
    const text = resultText(result);
    if (isExpectedPreOnboardCleanupMiss(text)) return;
    throw new Error(`${label} failed unexpectedly during pre-onboard cleanup: ${text}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isExpectedPreOnboardCleanupMiss(message)) return;
    throw error;
  }
}

function probeSummary(
  label: string,
  result: { exitCode: number | null; stdout: string; stderr: string },
): string {
  const text = resultText(result).trim();
  return `${label} exit=${result.exitCode}${text ? `: ${text.slice(0, 500)}` : ""}`;
}

async function cleanupSandbox(
  host: HostCliClient,
  sandbox: SandboxClient,
  sandboxName: string,
  options: CleanupSandboxOptions = {},
): Promise<void> {
  if (!options.strict) {
    await optionalCleanupStep("nemoclaw destroy", () =>
      host.command(process.execPath, [CLI_ENTRYPOINT, sandboxName, "destroy", "--yes"], {
        artifactName: `cleanup-nemoclaw-destroy-${sandboxName}`,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 120_000,
      }),
    );
    await optionalCleanupStep("openshell sandbox delete", () =>
      sandbox.openshell(["sandbox", "delete", sandboxName], {
        artifactName: `cleanup-openshell-sandbox-delete-${sandboxName}`,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 60_000,
      }),
    );
    clearOnboardState();
    return;
  }

  const cleanupEvidence: string[] = [];
  try {
    const destroy = await host.command(
      process.execPath,
      [CLI_ENTRYPOINT, sandboxName, "destroy", "--yes"],
      {
        artifactName: `cleanup-nemoclaw-destroy-${sandboxName}`,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 120_000,
      },
    );
    cleanupEvidence.push(probeSummary("nemoclaw destroy", destroy));
  } catch (error) {
    cleanupEvidence.push(
      `nemoclaw destroy threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const deletion = await sandbox.openshell(["sandbox", "delete", sandboxName], {
      artifactName: `cleanup-openshell-sandbox-delete-${sandboxName}`,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    });
    cleanupEvidence.push(probeSummary("openshell sandbox delete", deletion));
  } catch (error) {
    cleanupEvidence.push(
      `openshell sandbox delete threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  clearOnboardState();

  const status = await sandbox.status(sandboxName, {
    artifactName: `cleanup-openshell-sandbox-status-${sandboxName}`,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  cleanupEvidence.push(probeSummary("openshell sandbox status", status));
  if (status.exitCode === 0) {
    throw new Error(
      `sandbox '${sandboxName}' still exists after strict cleanup\n${cleanupEvidence.join("\n")}`,
    );
  }
}

async function expectNoActiveSandbox(host: HostCliClient, sandboxName: string): Promise<void> {
  const status = await host.command(process.execPath, [CLI_ENTRYPOINT, sandboxName, "status"], {
    artifactName: `post-failure-status-${sandboxName}`,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  const text = resultText(status);
  expect(
    /running|ready/i.test(text),
    `sandbox '${sandboxName}' is still active after failed onboard: ${text}`,
  ).toBe(false);
}

async function onboardSandbox(
  artifacts: ArtifactSink,
  sandboxName: string,
  extraEnv: NodeJS.ProcessEnv,
  redactionValues: readonly string[],
  artifactName: string,
  timeoutMs = 10 * 60_000,
): Promise<RawRunResult> {
  clearOnboardState();
  return runNemoclawCli(ONBOARD_ARGS, {
    artifactName,
    artifacts,
    env: onboardEnv({
      NEMOCLAW_POLICY_TIER: "open",
      NEMOCLAW_SANDBOX_NAME: sandboxName,
      ...extraEnv,
    }),
    redactionValues,
    timeoutMs,
  });
}

function expectOnboardSuccess(result: RawRunResult, label: string): void {
  const redacted = redactedResultText(result);
  expect(result.timedOut, `${label} timed out\n${redacted}`).toBe(false);
  expect(result.exitCode, `${label} failed\n${redacted}`).toBe(0);
}

function expectOnboardFailure(result: RawRunResult, label: string): void {
  const redacted = redactedResultText(result);
  expect(result.timedOut, `${label} timed out\n${redacted}`).toBe(false);
  expect(result.exitCode, `${label} unexpectedly succeeded\n${redacted}`).not.toBe(0);
}

function parseJsonBody(body: string, label: string): unknown {
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(
      `${label} response was not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function openAiContent(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return "";
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    const message = (choice as { message?: unknown }).message;
    if (message && typeof message === "object") {
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string" && content.trim()) return content;
    }
    const text = (choice as { text?: unknown }).text;
    if (typeof text === "string" && text.trim()) return text;
  }
  return "";
}

function anthropicContent(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const content = (json as { content?: unknown }).content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (
          part &&
          typeof part === "object" &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("")
      .trim();
  }
  return openAiContent(json);
}

async function expectOpenAiChatThroughSandbox(
  sandbox: SandboxClient,
  sandboxName: string,
  model: string,
  redactionValues: readonly string[],
  artifactName: string,
): Promise<void> {
  const payload = JSON.stringify({
    model,
    messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
    max_tokens: 50,
  });
  const response = await sandbox.exec(
    sandboxName,
    [
      "curl",
      "-sS",
      "--max-time",
      "60",
      "https://inference.local/v1/chat/completions",
      "-H",
      "Content-Type: application/json",
      "--data-raw",
      payload,
    ],
    {
      artifactName,
      env: buildAvailabilityProbeEnv(),
      redactionValues: [...redactionValues],
      timeoutMs: 90_000,
    },
  );
  expect(response.exitCode, resultText(response)).toBe(0);
  const content = openAiContent(parseJsonBody(response.stdout, artifactName));
  expect(content, `no chat content in response: ${response.stdout.slice(0, 500)}`).not.toBe("");
}

async function expectAnthropicMessageThroughSandbox(
  sandbox: SandboxClient,
  sandboxName: string,
  model: string,
  redactionValues: readonly string[],
): Promise<void> {
  const payload = JSON.stringify({
    model,
    messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
    max_tokens: 50,
  });
  const response = await sandbox.exec(
    sandboxName,
    [
      "curl",
      "-sS",
      "--max-time",
      "60",
      "https://inference.local/v1/messages",
      "-H",
      "Content-Type: application/json",
      "--data-raw",
      payload,
    ],
    {
      artifactName: "anthropic-inference-local-message",
      env: buildAvailabilityProbeEnv(),
      redactionValues: [...redactionValues],
      timeoutMs: 90_000,
    },
  );
  expect(response.exitCode, resultText(response)).toBe(0);
  const content = anthropicContent(parseJsonBody(response.stdout, "anthropic inference.local"));
  expect(content, `no Anthropic content in response: ${response.stdout.slice(0, 500)}`).not.toBe(
    "",
  );
}

export function requireProviderSmokeSelected(provider: "openai" | "anthropic", skip: SkipFn): void {
  if (!shouldRunProviderSmoke(provider)) {
    const label = provider === "openai" ? "OpenAI" : "Anthropic";
    skipLive(
      skip,
      `set NEMOCLAW_INFERENCE_ROUTING_PROVIDER_SMOKE=${provider} or all to run ${label} smoke`,
    );
  }
}

export async function verifyProcessListCredentialIsolation(
  artifacts: ArtifactSink,
  processList: RawRunResult,
  apiKey: string,
): Promise<void> {
  if (processList.exitCode === 0 && processList.stdout.trim()) {
    expect(processList.stdout.includes(apiKey), redactedResultText(processList)).toBe(false);
  } else {
    await artifacts.writeJson("tc-inf-05-process-list-skipped.json", {
      reason: "ps not available in hardened sandbox",
      exitCode: processList.exitCode,
    });
  }
}

export async function verifyCredentialPlaceholder(
  artifacts: ArtifactSink,
  placeholderValue: string,
  apiKey: string,
): Promise<void> {
  if (!placeholderValue) {
    await artifacts.writeJson("tc-inf-05-placeholder-skipped.json", {
      reason:
        "NVIDIA_INFERENCE_API_KEY not set in sandbox; placeholder injection may not be active",
    });
  } else {
    expect(placeholderValue, "sandbox has the real key, not a placeholder").not.toBe(apiKey);
  }
}

export {
  CREDENTIAL_CLASSIFICATION_PATTERN,
  cleanupSandbox,
  expectAnthropicMessageThroughSandbox,
  expectNoActiveSandbox,
  expectOnboardFailure,
  expectOnboardSuccess,
  expectOpenAiChatThroughSandbox,
  hasRawNodeStackTrace,
  inferenceSandboxName,
  onboardSandbox,
  rawOpenShellEnv,
  redactedResultText,
  requireLivePrerequisites,
  runNemoclawCli,
  runOpenShell,
  runRawCommand,
  skipLive,
  TRANSPORT_CLASSIFICATION_PATTERN,
  writeFakeOpenShellForBlueprintFailClosed,
};
