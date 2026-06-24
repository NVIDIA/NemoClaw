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

export const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
export const CLI = path.join(REPO_ROOT, "bin", "nemoclaw.js");
export const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-kimi-compat";
validateSandboxName(SANDBOX_NAME);
export const KIMI_MODEL = process.env.NEMOCLAW_KIMI_MODEL ?? "moonshotai/kimi-k2.6";

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

export function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    COMPATIBLE_API_KEY: "test-kimi-key",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_MODEL: KIMI_MODEL,
    NEMOCLAW_NON_INTERACTIVE: "1",
    // The legacy shell runs the Kimi split-exec fixture with policy prompts
    // skipped so the noninteractive test can focus on model/tool-call shaping.
    NEMOCLAW_POLICY_MODE: "skip",
    NEMOCLAW_POLICY_TIER: "restricted",
    NEMOCLAW_PREFERRED_API: "openai-completions",
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    NEMOCLAW_YES: "1",
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
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
  const toolCall = {
    id: "call_kimi_exec",
    type: "function",
    function: { name: "exec", arguments: JSON.stringify({ command: "hostname; date; uptime" }) },
  };
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
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...toolCall }] } }],
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
        message: { role: "assistant", content: null, tool_calls: [toolCall] },
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

export async function assertTrajectory(sandbox: SandboxClient): Promise<void> {
  const trajectory = await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript(String.raw`python3 - <<'PY'
import json, pathlib, sys
root=pathlib.Path('/sandbox/.openclaw')
base=pathlib.Path('/sandbox/.openclaw/agents/main/sessions')
session=base/'e2e-kimi-tools.jsonl'
trajectory=base/'e2e-kimi-tools.trajectory.jsonl'
if not session.exists() or not trajectory.exists():
    print(json.dumps({'error':'missing session/trajectory','files':[str(p) for p in root.rglob('*e2e-kimi-tools*.jsonl')]}))
    sys.exit(1)
session_items=[json.loads(line) for line in session.read_text().splitlines() if line.strip()]
trajectory_items=[json.loads(line) for line in trajectory.read_text().splitlines() if line.strip()]
errors=[]
artifacts=[item for item in trajectory_items if item.get('type')=='trace.artifacts']
if len(artifacts)!=1: errors.append(f'trace.artifacts count={len(artifacts)}')
data=(artifacts[-1].get('data') if artifacts else {}) or {}
metas=data.get('toolMetas') or []
if data.get('finalStatus')!='success': errors.append(f'finalStatus={data.get("finalStatus")!r}')
if len(metas)!=3: errors.append(f'toolMetas count={len(metas)}')
if [m.get('toolName') for m in metas] != ['exec','exec','exec']: errors.append('tool names mismatch')
if sorted(m.get('meta') for m in metas) != ['date','hostname','uptime']: errors.append('tool command set mismatch')
messages=[item.get('message',{}) for item in session_items if item.get('type')=='message']
assistant_tool_messages=[m for m in messages if m.get('role')=='assistant' and any(b.get('type')=='toolCall' for b in m.get('content',[]))]
source=[]
for m in assistant_tool_messages:
    source.extend(b.get('arguments',{}).get('command') for b in m.get('content',[]) if b.get('type')=='toolCall')
if source != ['hostname','date','uptime']: errors.append(f'source commands={source!r}')
if any(isinstance(c,str) and ';' in c for c in source): errors.append('combined semicolon command remains')
raw=session.read_text()+trajectory.read_text()
for token in ['abandoned','want me to continue']:
    if token in raw.lower(): errors.append(f'contains {token}')
if data.get('promptErrorSource') is not None: errors.append('promptErrorSource set')
for field in ['aborted','externalAbort','timedOut','idleTimedOut','timedOutDuringCompaction']:
    if data.get(field): errors.append(f'{field}={data.get(field)!r}')
def normalize_final_text(value):
    return value.strip().removesuffix('.') if isinstance(value, str) else value
final_texts=data.get('assistantTexts') or []
if not final_texts or normalize_final_text(final_texts[-1]) != 'hostname, date, and uptime completed successfully': errors.append('final text mismatch')
roles=[m.get('role') for m in messages]
if not ('toolResult' in roles and roles[-1]=='assistant'): errors.append('final assistant not after tool result')
print(json.dumps({'errors':errors,'source':source,'toolMetas':metas,'roles':roles}, indent=2))
sys.exit(1 if errors else 0)
PY`),
    { artifactName: "kimi-trajectory-tool-splitting-check", env: env(), timeoutMs: 60_000 },
  );
  expect(trajectory.exitCode, resultText(trajectory)).toBe(0);
}
