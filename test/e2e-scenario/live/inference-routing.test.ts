// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { trustedSandboxShellScript, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import { redactString } from "../fixtures/redaction.ts";

// Migrated from test/e2e/test-inference-routing.sh. This stays a simple live
// Vitest conversion: direct CLI/onboard subprocesses plus OpenShell sandbox
// probes, with local helpers only where raw in-memory output is required to
// prove credential non-exposure before redacted artifacts are written.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const DIST_ENTRYPOINT = path.join(REPO_ROOT, "dist", "nemoclaw.js");
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
const liveTest = shouldRunLiveE2EScenarios() ? test : test.skip;

function shouldRunProviderSmoke(provider: "openai" | "anthropic" | "compatible"): boolean {
  // The legacy shell script auto-ran these smokes when provider secrets were
  // present. This Vitest migration requires an explicit opt-in so PR-safe jobs
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

function resultText(result: { stdout: string; stderr: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
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
    "run `npm run build:cli` before live inference-routing scenarios",
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
  return /does not exist|run 'nemoclaw onboard'|no active gateway|not found|no such file|enoent/i.test(
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

liveTest(
  "TC-INF-06 invalid API key fails with credential classification and cleanup",
  { timeout: 5 * 60_000 },
  async ({ artifacts, cleanup, host, sandbox, skip }) => {
    await requireLivePrerequisites(host, skip);
    const sandboxName = inferenceSandboxName("e2e-invalid-key");
    cleanup.add(`remove inference-routing invalid-key residue for ${sandboxName}`, () =>
      cleanupSandbox(host, sandbox, sandboxName),
    );
    await cleanupSandbox(host, sandbox, sandboxName);

    await artifacts.writeJson("scenario.json", {
      id: "inference-routing-invalid-api-key",
      runner: "vitest",
      migratedFrom: "test/e2e/test-inference-routing.sh",
      contract: [
        "invalid NVIDIA key exits non-zero",
        "output contains credential classification",
        "output does not expose raw stack trace or submitted key",
        "failed onboard leaves no active sandbox",
      ],
    });

    const invalidKey = ["nvapi", "INTENTIONALLY", "INVALID", "KEY", "FOR", "E2E", "TEST"].join("-");
    const result = await onboardSandbox(
      artifacts,
      sandboxName,
      { NVIDIA_INFERENCE_API_KEY: invalidKey },
      [invalidKey],
      "tc-inf-06-onboard-invalid-api-key",
      120_000,
    );
    const raw = resultText(result);
    const redacted = redactedResultText(result);

    expectOnboardFailure(result, "TC-INF-06 invalid-key onboard");
    expect(CREDENTIAL_CLASSIFICATION_PATTERN.test(raw), redacted).toBe(true);
    expect(hasRawNodeStackTrace(raw), redacted).toBe(false);
    expect(raw.includes("INTENTIONALLY-INVALID-KEY-FOR-E2E-TEST"), redacted).toBe(false);
    await expectNoActiveSandbox(host, sandboxName);
  },
);

liveTest(
  "TC-INF-07 unreachable endpoint fails with transport classification and cleanup",
  { timeout: 5 * 60_000 },
  async ({ artifacts, cleanup, host, sandbox, skip }) => {
    await requireLivePrerequisites(host, skip);
    const sandboxName = inferenceSandboxName("e2e-unreachable");
    cleanup.add(`remove inference-routing unreachable residue for ${sandboxName}`, () =>
      cleanupSandbox(host, sandbox, sandboxName),
    );
    await cleanupSandbox(host, sandbox, sandboxName);

    await artifacts.writeJson("scenario.json", {
      id: "inference-routing-unreachable-endpoint",
      runner: "vitest",
      migratedFrom: "test/e2e/test-inference-routing.sh",
      contract: [
        "unreachable custom endpoint exits non-zero",
        "output contains transport classification",
        "output does not expose raw stack trace",
        "failed onboard leaves no active sandbox",
      ],
    });

    const nvidiaKey = ["nvapi", "valid", "format", "but", "fake", "key", "1234567890"].join("-");
    const compatibleKey = "fake-key-for-unreachable-test";
    const result = await onboardSandbox(
      artifacts,
      sandboxName,
      {
        COMPATIBLE_API_KEY: compatibleKey,
        NEMOCLAW_ENDPOINT_URL: "https://nemoclaw-e2e.invalid/v1",
        NEMOCLAW_MODEL: "test-model",
        NEMOCLAW_PROVIDER: "custom",
        NVIDIA_INFERENCE_API_KEY: nvidiaKey,
      },
      [nvidiaKey, compatibleKey],
      "tc-inf-07-onboard-unreachable-endpoint",
      120_000,
    );
    const raw = resultText(result);
    const redacted = redactedResultText(result);

    expectOnboardFailure(result, "TC-INF-07 unreachable-endpoint onboard");
    expect(TRANSPORT_CLASSIFICATION_PATTERN.test(raw), redacted).toBe(true);
    expect(hasRawNodeStackTrace(raw), redacted).toBe(false);
    await expectNoActiveSandbox(host, sandboxName);
  },
);

liveTest(
  "TC-INF-05 real NVIDIA key is isolated from sandbox env, process list, and filesystem",
  { timeout: 15 * 60_000 },
  async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
    const apiKey =
      secrets.optional("NVIDIA_INFERENCE_API_KEY") ??
      skipLive(skip, "NVIDIA_INFERENCE_API_KEY not set — cannot test credential isolation");
    await requireLivePrerequisites(host, skip);
    const sandboxName = inferenceSandboxName("e2e-inf-cred");
    cleanup.add(
      `best-effort inference-routing credential-isolation cleanup for ${sandboxName}`,
      () => cleanupSandbox(host, sandbox, sandboxName),
    );
    await cleanupSandbox(host, sandbox, sandboxName);

    await artifacts.writeJson("scenario.json", {
      id: "inference-routing-credential-isolation",
      runner: "vitest",
      migratedFrom: "test/e2e/test-inference-routing.sh",
      contract: [
        "real NVIDIA_INFERENCE_API_KEY does not appear in sandbox environment",
        "real NVIDIA_INFERENCE_API_KEY does not appear in sandbox process list when ps is available",
        "real NVIDIA_INFERENCE_API_KEY does not appear in sampled sandbox filesystem",
        "sandbox NVIDIA_INFERENCE_API_KEY, when present, is a placeholder rather than the real key",
      ],
    });

    const onboard = await onboardSandbox(
      artifacts,
      sandboxName,
      { NVIDIA_INFERENCE_API_KEY: apiKey },
      [apiKey],
      "tc-inf-05-onboard-credential-isolation",
    );
    expectOnboardSuccess(onboard, "TC-INF-05 credential-isolation onboard");
    cleanup.add(`strict inference-routing credential-isolation cleanup for ${sandboxName}`, () =>
      cleanupSandbox(host, sandbox, sandboxName, { strict: true }),
    );

    const sandboxEnv = await runOpenShell(["sandbox", "exec", "-n", sandboxName, "--", "env"], {
      artifactName: "tc-inf-05-sandbox-env",
      artifacts,
      env: buildAvailabilityProbeEnv(),
      redactionValues: [apiKey],
      timeoutMs: 60_000,
    });
    expect(sandboxEnv.exitCode, redactedResultText(sandboxEnv)).toBe(0);
    expect(sandboxEnv.stdout.includes(apiKey), redactedResultText(sandboxEnv)).toBe(false);

    const processList = await runOpenShell(
      [
        "sandbox",
        "exec",
        "-n",
        sandboxName,
        "--",
        "sh",
        "-lc",
        "ps aux 2>/dev/null || ps -ef 2>/dev/null",
      ],
      {
        artifactName: "tc-inf-05-sandbox-process-list",
        artifacts,
        env: buildAvailabilityProbeEnv(),
        redactionValues: [apiKey],
        timeoutMs: 60_000,
      },
    );
    if (processList.exitCode === 0 && processList.stdout.trim()) {
      expect(processList.stdout.includes(apiKey), redactedResultText(processList)).toBe(false);
    } else {
      await artifacts.writeJson("tc-inf-05-process-list-skipped.json", {
        reason: "ps not available in hardened sandbox",
        exitCode: processList.exitCode,
      });
    }

    const scanScript = [
      "const crypto=require('crypto')",
      "const fs=require('fs')",
      "const {execFileSync}=require('child_process')",
      "const len=Number(process.env.KEY_LEN||'0')",
      "const salt=process.env.SCAN_SALT||''",
      "const target=process.env.TARGET_HASH||''",
      "const digest=(value)=>crypto.createHash('sha256').update(salt).update(value).digest('hex')",
      "if(!len||!salt||!target){console.log('SCAN_CONFIG_MISSING');process.exit(0)}",
      "let out=''",
      "try{out=execFileSync('sh',['-lc','find /sandbox /home /tmp -type f -size -1M 2>/dev/null | head -200'],{encoding:'utf8'})}catch{console.log('SCAN_ERROR');process.exit(0)}",
      "for(const file of out.trim().split(/\\n/).filter(Boolean)){try{const content=fs.readFileSync(file,'utf8');for(let i=0;i<=content.length-len;i++){if(digest(content.slice(i,i+len))===target){console.log('FOUND:'+file);break}}}catch{}}",
      "console.log('SCAN_DONE')",
    ].join(";");
    const leakCanary = `nemoclaw-fs-scan-canary-${crypto.randomUUID()}`;
    const canaryPath = "/tmp/nemoclaw-fs-scan-canary.txt";
    const plantCanary = await sandbox.execShell(
      sandboxName,
      trustedSandboxShellScript(`printf '%s' '${leakCanary}' > ${canaryPath}`),
      {
        artifactName: "tc-inf-05-sandbox-filesystem-canary-plant",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(plantCanary.exitCode, resultText(plantCanary)).toBe(0);
    const canarySalt = crypto.randomUUID();
    const canaryScan = await runOpenShell(
      ["sandbox", "exec", "-n", sandboxName, "--", "node", "-e", scanScript],
      {
        artifactName: "tc-inf-05-sandbox-filesystem-canary-scan",
        artifacts,
        env: rawOpenShellEnv({
          KEY_LEN: String(leakCanary.length),
          SCAN_SALT: canarySalt,
          TARGET_HASH: crypto
            .createHash("sha256")
            .update(canarySalt)
            .update(leakCanary)
            .digest("hex"),
        }),
        timeoutMs: 90_000,
      },
    );
    expect(canaryScan.stdout, redactedResultText(canaryScan)).toContain(`FOUND:${canaryPath}`);

    const removeCanary = await sandbox.execShell(
      sandboxName,
      trustedSandboxShellScript(`rm -f ${canaryPath}`),
      {
        artifactName: "tc-inf-05-sandbox-filesystem-canary-remove",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(removeCanary.exitCode, resultText(removeCanary)).toBe(0);

    const secretScanSalt = crypto.randomUUID();
    const filesystemScan = await runOpenShell(
      ["sandbox", "exec", "-n", sandboxName, "--", "node", "-e", scanScript],
      {
        artifactName: "tc-inf-05-sandbox-filesystem-scan",
        artifacts,
        env: rawOpenShellEnv({
          KEY_LEN: String(apiKey.length),
          SCAN_SALT: secretScanSalt,
          TARGET_HASH: crypto
            .createHash("sha256")
            .update(secretScanSalt)
            .update(apiKey)
            .digest("hex"),
        }),
        redactionValues: [apiKey],
        timeoutMs: 90_000,
      },
    );
    expect(filesystemScan.stdout).not.toContain("SCAN_CONFIG_MISSING");
    expect(filesystemScan.stdout).not.toContain("FOUND:");
    expect(filesystemScan.stdout, redactedResultText(filesystemScan)).toContain("SCAN_DONE");

    const placeholder = await sandbox.execShell(
      sandboxName,
      trustedSandboxShellScript("printenv NVIDIA_INFERENCE_API_KEY 2>/dev/null || true"),
      {
        artifactName: "tc-inf-05-sandbox-placeholder",
        env: buildAvailabilityProbeEnv(),
        redactionValues: [apiKey],
        timeoutMs: 30_000,
      },
    );
    const placeholderValue = placeholder.stdout.trim();
    if (!placeholderValue) {
      await artifacts.writeJson("tc-inf-05-placeholder-skipped.json", {
        reason:
          "NVIDIA_INFERENCE_API_KEY not set in sandbox; placeholder injection may not be active",
      });
    } else {
      expect(placeholderValue, "sandbox has the real key, not a placeholder").not.toBe(apiKey);
    }
  },
);

liveTest(
  "TC-INF-02 OpenAI provider responds through inference.local",
  { timeout: 15 * 60_000 },
  async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
    if (!shouldRunProviderSmoke("openai")) {
      skipLive(
        skip,
        "set NEMOCLAW_INFERENCE_ROUTING_PROVIDER_SMOKE=openai or all to run OpenAI smoke",
      );
    }
    const apiKey = secrets.optional("OPENAI_API_KEY") ?? skipLive(skip, "OPENAI_API_KEY not set");
    await requireLivePrerequisites(host, skip);
    const sandboxName = inferenceSandboxName("e2e-openai");
    const model = process.env.NEMOCLAW_OPENAI_MODEL || "gpt-4o-mini";
    cleanup.add(`best-effort inference-routing OpenAI cleanup for ${sandboxName}`, () =>
      cleanupSandbox(host, sandbox, sandboxName),
    );
    await cleanupSandbox(host, sandbox, sandboxName);

    await artifacts.writeJson("scenario.json", {
      id: "inference-routing-openai",
      runner: "vitest",
      migratedFrom: "test/e2e/test-inference-routing.sh",
      contract: ["OpenAI provider onboards", "sandbox inference.local routes chat to OpenAI"],
      model,
    });

    const onboard = await onboardSandbox(
      artifacts,
      sandboxName,
      { NEMOCLAW_MODEL: model, NEMOCLAW_PROVIDER: "openai", OPENAI_API_KEY: apiKey },
      [apiKey],
      "tc-inf-02-onboard-openai",
    );
    expectOnboardSuccess(onboard, "TC-INF-02 OpenAI onboard");
    cleanup.add(`strict inference-routing OpenAI cleanup for ${sandboxName}`, () =>
      cleanupSandbox(host, sandbox, sandboxName, { strict: true }),
    );
    await expectOpenAiChatThroughSandbox(
      sandbox,
      sandboxName,
      model,
      [apiKey],
      "openai-inference-local-chat",
    );
  },
);

liveTest(
  "TC-INF-03 Anthropic provider responds through inference.local",
  { timeout: 15 * 60_000 },
  async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
    if (!shouldRunProviderSmoke("anthropic")) {
      skipLive(
        skip,
        "set NEMOCLAW_INFERENCE_ROUTING_PROVIDER_SMOKE=anthropic or all to run Anthropic smoke",
      );
    }
    const apiKey =
      secrets.optional("ANTHROPIC_API_KEY") ?? skipLive(skip, "ANTHROPIC_API_KEY not set");
    await requireLivePrerequisites(host, skip);
    const sandboxName = inferenceSandboxName("e2e-anthropic");
    const model = process.env.NEMOCLAW_ANTHROPIC_MODEL || "claude-sonnet-4-6";
    cleanup.add(`best-effort inference-routing Anthropic cleanup for ${sandboxName}`, () =>
      cleanupSandbox(host, sandbox, sandboxName),
    );
    await cleanupSandbox(host, sandbox, sandboxName);

    await artifacts.writeJson("scenario.json", {
      id: "inference-routing-anthropic",
      runner: "vitest",
      migratedFrom: "test/e2e/test-inference-routing.sh",
      contract: [
        "Anthropic provider onboards",
        "sandbox inference.local routes Messages API to Anthropic",
      ],
      model,
    });

    const onboard = await onboardSandbox(
      artifacts,
      sandboxName,
      { ANTHROPIC_API_KEY: apiKey, NEMOCLAW_MODEL: model, NEMOCLAW_PROVIDER: "anthropic" },
      [apiKey],
      "tc-inf-03-onboard-anthropic",
    );
    expectOnboardSuccess(onboard, "TC-INF-03 Anthropic onboard");
    cleanup.add(`strict inference-routing Anthropic cleanup for ${sandboxName}`, () =>
      cleanupSandbox(host, sandbox, sandboxName, { strict: true }),
    );
    await expectAnthropicMessageThroughSandbox(sandbox, sandboxName, model, [apiKey]);
  },
);

liveTest(
  "TC-INF-09 custom OpenAI-compatible endpoint responds through inference.local",
  { timeout: 15 * 60_000 },
  async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
    if (!shouldRunProviderSmoke("compatible")) {
      skipLive(
        skip,
        "set NEMOCLAW_INFERENCE_ROUTING_PROVIDER_SMOKE=compatible or all to run compatible endpoint smoke",
      );
    }
    const endpointUrl =
      process.env.NEMOCLAW_ENDPOINT_URL ??
      skipLive(skip, "Missing NEMOCLAW_ENDPOINT_URL, NEMOCLAW_COMPAT_MODEL, or COMPATIBLE_API_KEY");
    const model =
      process.env.NEMOCLAW_COMPAT_MODEL ||
      process.env.NEMOCLAW_MODEL ||
      skipLive(skip, "Missing NEMOCLAW_ENDPOINT_URL, NEMOCLAW_COMPAT_MODEL, or COMPATIBLE_API_KEY");
    const apiKey =
      secrets.optional("COMPATIBLE_API_KEY") ??
      skipLive(skip, "Missing NEMOCLAW_ENDPOINT_URL, NEMOCLAW_COMPAT_MODEL, or COMPATIBLE_API_KEY");
    await requireLivePrerequisites(host, skip);
    const sandboxName = inferenceSandboxName("e2e-compat-ep");
    cleanup.add(
      `best-effort inference-routing compatible-endpoint cleanup for ${sandboxName}`,
      () => cleanupSandbox(host, sandbox, sandboxName),
    );
    await cleanupSandbox(host, sandbox, sandboxName);

    await artifacts.writeJson("scenario.json", {
      id: "inference-routing-compatible-endpoint",
      runner: "vitest",
      migratedFrom: "test/e2e/test-inference-routing.sh",
      contract: [
        "custom OpenAI-compatible endpoint onboards",
        "sandbox inference.local routes chat to compatible endpoint",
      ],
      endpointUrl: redactString(endpointUrl, [apiKey]),
      model,
    });

    const onboard = await onboardSandbox(
      artifacts,
      sandboxName,
      {
        COMPATIBLE_API_KEY: apiKey,
        NEMOCLAW_ENDPOINT_URL: endpointUrl,
        NEMOCLAW_MODEL: model,
        NEMOCLAW_PROVIDER: "custom",
      },
      [apiKey],
      "tc-inf-09-onboard-compatible-endpoint",
    );
    expectOnboardSuccess(onboard, "TC-INF-09 compatible-endpoint onboard");
    cleanup.add(`strict inference-routing compatible-endpoint cleanup for ${sandboxName}`, () =>
      cleanupSandbox(host, sandbox, sandboxName, { strict: true }),
    );
    await expectOpenAiChatThroughSandbox(
      sandbox,
      sandboxName,
      model,
      [apiKey],
      "compatible-endpoint-inference-local-chat",
    );
  },
);
