// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
import { CLI_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";

export { REPO_ROOT };

export const CLI = CLI_ENTRYPOINT;
export const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-kimi-compat";
validateSandboxName(SANDBOX_NAME);
export const KIMI_MODEL = process.env.NEMOCLAW_KIMI_MODEL ?? "moonshotai/kimi-k2.6";

export type KimiInferenceMode = "mock" | "public-nvidia";

export interface KimiEnvOptions {
  mode?: KimiInferenceMode;
  apiKey?: string;
  includeSecret?: boolean;
}

// Source-of-truth boundary for the Kimi public/mock split: trusted CI sets the
// canonical NEMOCLAW_E2E_INFERENCE_MODE selector, local runs default to mock only
// when the selector is absent, and unknown explicit values fail closed so a typo
// cannot downgrade public-NVIDIA validation into hermetic mock coverage.
export function resolveKimiInferenceMode(env: NodeJS.ProcessEnv = process.env): KimiInferenceMode {
  if (env.NEMOCLAW_E2E_INFERENCE_MODE !== undefined) {
    const explicitMode = env.NEMOCLAW_E2E_INFERENCE_MODE.trim().toLowerCase();
    if (explicitMode === "public-nvidia" || explicitMode === "mock") return explicitMode;
    throw new Error(
      `NEMOCLAW_E2E_INFERENCE_MODE must be one of: mock, public-nvidia; got ${env.NEMOCLAW_E2E_INFERENCE_MODE}`,
    );
  }
  return "mock";
}

export function requirePublicNvidiaApiKey(value: string): string {
  if (!value.startsWith("nvapi-"))
    throw new Error("NVIDIA_API_KEY must be a public NVIDIA Endpoints nvapi-* key");
  return value;
}

export interface KimiRequest {
  path: string;
  model?: string;
  hasTools: boolean;
  hasToolResult: boolean;
  authOk: boolean;
}

export interface KimiMock {
  baseUrl: string;
  requests: KimiRequest[];
  close(): Promise<void>;
}

export function env(
  extra: NodeJS.ProcessEnv = {},
  options: KimiEnvOptions = {},
): NodeJS.ProcessEnv {
  const mode = options.mode ?? resolveKimiInferenceMode();
  const common: NodeJS.ProcessEnv = {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_MODEL: KIMI_MODEL,
    NEMOCLAW_NON_INTERACTIVE: "1",
    // The former shell runs the Kimi split-exec fixture with policy prompts
    // skipped so the noninteractive test can focus on model/tool-call shaping.
    NEMOCLAW_POLICY_MODE: "skip",
    NEMOCLAW_POLICY_TIER: "restricted",
    NEMOCLAW_PREFERRED_API: "openai-completions",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    NEMOCLAW_YES: "1",
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
  };
  if (mode === "public-nvidia") {
    return {
      ...common,
      NEMOCLAW_E2E_INFERENCE_MODE: "public-nvidia",
      NEMOCLAW_PROVIDER: "cloud",
      ...(options.includeSecret && options.apiKey ? { NVIDIA_API_KEY: options.apiKey } : {}),
      ...extra,
    };
  }
  return {
    ...common,
    COMPATIBLE_API_KEY: "test-kimi-key",
    NEMOCLAW_E2E_INFERENCE_MODE: "mock",
    NEMOCLAW_PROVIDER: "custom",
    ...extra,
  };
}

export async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {}
}

export async function startKimiMock(): Promise<KimiMock> {
  const requests: KimiRequest[] = [];
  const server = http.createServer((req, res) => {
    handleKimiRequest(req, res, requests);
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const address = server.address() as AddressInfo;
  const advertisedHost = process.env.NEMOCLAW_KIMI_MOCK_HOST ?? "host.openshell.internal";
  return {
    baseUrl: `http://${advertisedHost}:${address.port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export function kimiBoundary(mode: KimiInferenceMode): string {
  return mode === "public-nvidia"
    ? "source CLI onboard + public NVIDIA Kimi endpoint + OpenClaw config/plugin/inference route"
    : "source CLI onboard + fake OpenAI-compatible Kimi endpoint + OpenClaw config/plugin/inference route";
}

export async function startKimiUpstream(mode: KimiInferenceMode): Promise<KimiMock | undefined> {
  return mode === "mock" ? startKimiMock() : undefined;
}

export function maybeRegisterKimiMockCleanup(
  cleanup: { add(name: string, fn: () => Promise<void>): void },
  fake: KimiMock | undefined,
): void {
  if (fake) cleanup.add("close fake Kimi endpoint", () => fake.close());
}

export function kimiOnboardEnv(
  fake: KimiMock | undefined,
  mode: KimiInferenceMode,
  apiKey: string | undefined,
): NodeJS.ProcessEnv {
  return env(fake ? { NEMOCLAW_ENDPOINT_URL: fake.baseUrl } : {}, {
    mode,
    apiKey,
    includeSecret: true,
  });
}

export function kimiAgentEnv(mode: KimiInferenceMode): NodeJS.ProcessEnv {
  // Onboard owns the only raw public NVIDIA key handoff. After that, the sandbox
  // agent must use the configured nvidia-prod route rather than inheriting the
  // repository secret in its process environment.
  return env({}, { mode });
}

export async function assertKimiUpstreamTraffic(options: {
  fake: KimiMock | undefined;
  host: HostCliClient;
  mode: KimiInferenceMode;
  apiKey: string | undefined;
}): Promise<void> {
  if (options.fake) {
    expect(
      options.fake.requests.some(
        (request) =>
          request.authOk &&
          request.path.includes("/chat/completions") &&
          request.model === KIMI_MODEL &&
          request.hasTools,
      ),
    ).toBe(true);
    expect(options.fake.requests.some((request) => request.authOk && request.hasToolResult)).toBe(
      true,
    );
    return;
  }

  const route = await options.host.command("openshell", ["inference", "get", "-g", "nemoclaw"], {
    artifactName: "public-nvidia-kimi-route",
    env: env({}, { mode: options.mode, apiKey: options.apiKey }),
    redactionValues: [options.apiKey ?? ""],
    timeoutMs: 60_000,
  });
  expect(route.exitCode, resultText(route)).toBe(0);
  expect(resultText(route)).toContain("nvidia-prod");
  expect(resultText(route)).toContain(KIMI_MODEL);
}

function handleKimiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requests: KimiRequest[],
): void {
  const authOk = req.headers.authorization === "Bearer test-kimi-key";
  const modelsRoute = req.method === "GET" && req.url === "/v1/models";
  if (modelsRoute) return sendModels(res, requests, req.url ?? "", authOk);
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404).end();
    return;
  }
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => handleKimiChatBody(raw, req, res, requests, authOk));
}

function sendModels(
  res: http.ServerResponse,
  requests: KimiRequest[],
  pathName: string,
  authOk: boolean,
): void {
  if (!authOk) return sendJson(res, 401, { error: { message: "missing bearer credential" } });
  requests.push({
    path: pathName,
    model: KIMI_MODEL,
    hasTools: false,
    hasToolResult: false,
    authOk: true,
  });
  sendJson(res, 200, { object: "list", data: [{ id: KIMI_MODEL, object: "model" }] });
}

function handleKimiChatBody(
  raw: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requests: KimiRequest[],
  authOk: boolean,
): void {
  let body: {
    model?: string;
    stream?: boolean;
    tools?: unknown[];
    messages?: Array<{ role?: string; content?: string }>;
  };
  try {
    body = JSON.parse(raw || "{}") as typeof body;
  } catch {
    sendJson(res, 400, { error: { message: "invalid json" } });
    return;
  }
  if (!authOk) return sendJson(res, 401, { error: { message: "missing bearer credential" } });
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const hasToolResult = body.messages?.some((message) => message.role === "tool") ?? false;
  requests.push({ path: req.url ?? "", model: body.model, hasTools, hasToolResult, authOk });
  sendKimiCompletion(res, body, hasTools, hasToolResult);
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sendSse(res: http.ServerResponse, chunks: unknown[]): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end("data: [DONE]\n\n");
}

function sendKimiCompletion(
  res: http.ServerResponse,
  body: {
    model?: string;
    stream?: boolean;
    tools?: unknown[];
    messages?: Array<{ role?: string; content?: string }>;
  },
  hasTools: boolean,
  hasToolResult: boolean,
): void {
  const id = `chatcmpl-kimi-${Date.now()}`;
  const requestText = JSON.stringify(body);
  if (requestText.includes("Reply with exactly: OK"))
    return sendJson(res, 200, completion(id, "OK"));
  if (hasTools && !hasToolResult) return sendToolCall(res, id, Boolean(body.stream));
  const finalText = "hostname, date, and uptime completed successfully.";
  return body.stream
    ? sendSse(res, streamTextChunks(id, finalText))
    : sendJson(res, 200, completion(id, finalText));
}

function completion(id: string, content: string): unknown {
  return {
    id,
    object: "chat.completion",
    model: KIMI_MODEL,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  };
}

function sendToolCall(res: http.ServerResponse, id: string, stream: boolean): void {
  const toolCalls = ["hostname", "date", "uptime"].map((command) => ({
    id: `call_kimi_exec_${command}`,
    type: "function",
    function: { name: "exec", arguments: JSON.stringify({ command }) },
  }));
  if (stream) {
    sendSse(res, [
      {
        id,
        object: "chat.completion.chunk",
        model: KIMI_MODEL,
        choices: [{ index: 0, delta: { role: "assistant" } }],
      },
      {
        id,
        object: "chat.completion.chunk",
        model: KIMI_MODEL,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: toolCalls.map((toolCall, index) => ({ index, ...toolCall })),
            },
          },
        ],
      },
      {
        id,
        object: "chat.completion.chunk",
        model: KIMI_MODEL,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
    ]);
    return;
  }
  sendJson(res, 200, {
    id,
    object: "chat.completion",
    model: KIMI_MODEL,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: null, tool_calls: toolCalls },
        finish_reason: "tool_calls",
      },
    ],
  });
}

function streamTextChunks(id: string, content: string): unknown[] {
  return [
    {
      id,
      object: "chat.completion.chunk",
      model: KIMI_MODEL,
      choices: [{ index: 0, delta: { role: "assistant" } }],
    },
    {
      id,
      object: "chat.completion.chunk",
      model: KIMI_MODEL,
      choices: [{ index: 0, delta: { content } }],
    },
    {
      id,
      object: "chat.completion.chunk",
      model: KIMI_MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ];
}

export async function cleanupKimi(host: HostCliClient, sandbox: SandboxClient): Promise<void> {
  await bestEffort(() =>
    host.command("node", [CLI, SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "cleanup-destroy-kimi",
      env: env(),
      timeoutMs: 120_000,
    }),
  );
  await bestEffort(() =>
    sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "cleanup-delete-kimi",
      env: env(),
      timeoutMs: 60_000,
    }),
  );
}

export function parseConfig(raw: string): {
  providers?: Record<
    string,
    {
      baseUrl?: string;
      api?: string;
      models?: Array<{ id?: string; compat?: Record<string, unknown> }>;
    }
  >;
  primary?: string;
  pluginEnabled?: unknown;
  toolSearch?: unknown;
} {
  const cfg = JSON.parse(raw) as {
    models?: {
      providers?: Record<
        string,
        {
          baseUrl?: string;
          api?: string;
          models?: Array<{ id?: string; compat?: Record<string, unknown> }>;
        }
      >;
    };
    agents?: { defaults?: { model?: { primary?: string } } };
    plugins?: { entries?: Record<string, { enabled?: unknown }> };
    tools?: { toolSearch?: unknown };
  };
  return {
    providers: cfg.models?.providers,
    primary: cfg.agents?.defaults?.model?.primary,
    pluginEnabled: cfg.plugins?.entries?.["nemoclaw-kimi-inference-compat"]?.enabled,
    toolSearch: cfg.tools?.toolSearch,
  };
}

export interface KimiTrajectorySummary {
  errors: string[];
  finalStatus?: unknown;
  finalTextCount: number;
  roles: unknown[];
  sourceCommands: unknown[];
  strictMockExpectations: boolean;
  toolMetaCommandSet: string[];
  toolMetaInvalidValues: unknown[];
  toolMetasCount: number;
}

export function buildKimiTrajectoryCheckScript(strictMockExpectations: boolean): string {
  return String.raw`import json, pathlib, re, sys
strict_mock = __STRICT_MOCK__
root=pathlib.Path('/sandbox/.openclaw')
base=pathlib.Path('/sandbox/.openclaw/agents/main/sessions')
session=base/'e2e-kimi-tools.jsonl'
trajectory=base/'e2e-kimi-tools.trajectory.jsonl'
if not session.exists() or not trajectory.exists():
    print(json.dumps({'errors':['missing session/trajectory'],'files':[str(p) for p in root.rglob('*e2e-kimi-tools*.jsonl')]}))
    sys.exit(1)
session_items=[json.loads(line) for line in session.read_text().splitlines() if line.strip()]
trajectory_items=[json.loads(line) for line in trajectory.read_text().splitlines() if line.strip()]
errors=[]
artifacts=[item for item in trajectory_items if item.get('type')=='trace.artifacts']
if len(artifacts)!=1: errors.append(f'trace.artifacts count={len(artifacts)}')
data=(artifacts[-1].get('data') if artifacts else {}) or {}
metas=data.get('toolMetas') or []
meta_commands=[m.get('meta') for m in metas]
meta_commands_str=[command for command in meta_commands if isinstance(command, str)]
invalid_meta_commands=[command for command in meta_commands if not isinstance(command, str)]
expected_round=['hostname','date','uptime']
expected_command_set=sorted(expected_round)
if data.get('finalStatus')!='success': errors.append(f'finalStatus={data.get("finalStatus")!r}')
min_metas = 3 if strict_mock else 1
if len(metas) < min_metas: errors.append(f'toolMetas count={len(metas)} expected_at_least={min_metas}')
if any(m.get('toolName') != 'exec' for m in metas): errors.append('tool names mismatch')
messages=[item.get('message',{}) for item in session_items if item.get('type')=='message']
assistant_tool_messages=[m for m in messages if m.get('role')=='assistant' and any(b.get('type')=='toolCall' for b in m.get('content',[]))]
source=[]
for m in assistant_tool_messages:
    source.extend(b.get('arguments',{}).get('command') for b in m.get('content',[]) if b.get('type')=='toolCall')
if not source: errors.append('source assistant did not record any exec commands')
invalid_source_commands=[c for c in source if not isinstance(c,str)]
if invalid_source_commands: errors.append(f'source commands are not all strings: {invalid_source_commands!r}')
if strict_mock:
    if invalid_meta_commands:
        errors.append(f'toolMeta meta values are not all strings: {invalid_meta_commands!r}')
    elif sorted(set(meta_commands_str)) != expected_command_set:
        errors.append(f'tool command set={sorted(set(meta_commands_str))!r}')
    if len(source) < len(expected_round) or len(source) % len(expected_round) != 0:
        errors.append(f'source commands={source!r}')
    else:
        for offset in range(0, len(source), len(expected_round)):
            if source[offset:offset + len(expected_round)] != expected_round:
                errors.append(f'source commands={source!r}')
                break
safe_source_commands=[c for c in source if isinstance(c,str) and c in expected_round]
unsafe_source_commands=[c for c in source if isinstance(c,str) and c not in expected_round]
if unsafe_source_commands: errors.append(f'unsafe source command remains: {unsafe_source_commands!r}')
raw=session.read_text()+trajectory.read_text()
for token in ['abandoned','want me to continue']:
    if token in raw.lower(): errors.append(f'contains {token}')
if data.get('promptErrorSource') is not None: errors.append('promptErrorSource set')
for field in ['aborted','externalAbort','timedOut','idleTimedOut','timedOutDuringCompaction']:
    if data.get(field): errors.append(f'{field}={data.get(field)!r}')
def normalize_final_text(value):
    return value.strip().removesuffix('.') if isinstance(value, str) else value
final_texts=data.get('assistantTexts') or []
expected_final_text='hostname, date, and uptime completed successfully'
if strict_mock and (not final_texts or expected_final_text not in normalize_final_text(final_texts[-1])):
    errors.append('final text mismatch')
elif not final_texts:
    errors.append('missing final assistant text')
roles=[m.get('role') for m in messages]
if not ('toolResult' in roles and roles[-1]=='assistant'): errors.append('final assistant not after tool result')
summary={
    'errors': errors,
    'finalStatus': data.get('finalStatus'),
    'finalTextCount': len(final_texts),
    'roles': roles,
    'sourceCommands': source,
    'strictMockExpectations': strict_mock,
    'toolMetaCommandSet': sorted(set(meta_commands_str)),
    'toolMetaInvalidValues': invalid_meta_commands,
    'toolMetasCount': len(metas),
}
print(json.dumps(summary, indent=2))
sys.exit(1 if errors else 0)`.replace("__STRICT_MOCK__", strictMockExpectations ? "True" : "False");
}

export function assertKimiTrajectorySummary(summary: KimiTrajectorySummary): void {
  expect(summary.errors).toEqual([]);
  expect(summary.finalStatus).toBe("success");
  expect(summary.finalTextCount).toBeGreaterThan(0);
  expect(summary.roles).toContain("toolResult");
  expect(summary.roles.at(-1)).toBe("assistant");
  expect(summary.sourceCommands.length).toBeGreaterThan(0);
  expect(summary.sourceCommands.every((command) => typeof command === "string")).toBe(true);
  const safeSourceCommands = new Set(["hostname", "date", "uptime"]);
  expect(summary.sourceCommands.every((command) => safeSourceCommands.has(command as string))).toBe(
    true,
  );
  expect(summary.toolMetasCount).toBeGreaterThanOrEqual(summary.strictMockExpectations ? 3 : 1);
  if (summary.strictMockExpectations) {
    const expectedRound = ["hostname", "date", "uptime"];
    expect(summary.toolMetaInvalidValues).toEqual([]);
    expect(summary.toolMetaCommandSet).toEqual(["date", "hostname", "uptime"]);
    expect(summary.sourceCommands.length % expectedRound.length).toBe(0);
    for (let index = 0; index < summary.sourceCommands.length; index += expectedRound.length) {
      expect(summary.sourceCommands.slice(index, index + expectedRound.length)).toEqual(
        expectedRound,
      );
    }
  }
}

export async function assertTrajectory(
  sandbox: SandboxClient,
  mode: KimiInferenceMode,
): Promise<void> {
  const checkScript = buildKimiTrajectoryCheckScript(mode === "mock");
  const encoded = Buffer.from(checkScript, "utf8").toString("base64");
  const trajectory = await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript(`python3 -c "$(printf %s '${encoded}' | base64 -d)"`),
    {
      artifactName: "kimi-trajectory-tool-splitting-check",
      env: env({}, { mode }),
      timeoutMs: 60_000,
    },
  );
  expect(trajectory.exitCode, resultText(trajectory)).toBe(0);
}
