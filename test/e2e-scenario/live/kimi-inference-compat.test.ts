// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Live Vitest replacement for test/e2e/test-kimi-inference-compat.sh. */

import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { trustedSandboxShellScript, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-kimi-compat";
validateSandboxName(SANDBOX_NAME);
const KIMI_MODEL = process.env.NEMOCLAW_KIMI_MODEL ?? "moonshotai/kimi-k2.6";
const TIMEOUT_MS = 40 * 60_000;

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    COMPATIBLE_API_KEY: "test-kimi-key",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_MODEL: KIMI_MODEL,
    NEMOCLAW_NON_INTERACTIVE: "1",
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

async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {}
}

interface KimiRequest {
  path: string;
  model?: string;
  hasTools: boolean;
  hasToolResult: boolean;
  authOk: boolean;
}

async function startKimiMock(): Promise<{
  baseUrl: string;
  requests: KimiRequest[];
  close(): Promise<void>;
}> {
  const requests: KimiRequest[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      if (req.headers.authorization !== "Bearer test-kimi-key") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "missing bearer credential" } }));
        return;
      }
      requests.push({
        path: req.url,
        model: KIMI_MODEL,
        hasTools: false,
        hasToolResult: false,
        authOk: true,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: KIMI_MODEL, object: "model" }] }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let body: {
        model?: string;
        stream?: boolean;
        tools?: unknown[];
        messages?: Array<{ role?: string; content?: string }>;
      };
      try {
        body = JSON.parse(raw || "{}") as typeof body;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid json" } }));
        return;
      }
      const authOk = req.headers.authorization === "Bearer test-kimi-key";
      if (!authOk) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "missing bearer credential" } }));
        return;
      }
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      const hasToolResult = body.messages?.some((message) => message.role === "tool") ?? false;
      requests.push({ path: req.url ?? "", model: body.model, hasTools, hasToolResult, authOk });
      const id = `chatcmpl-kimi-${Date.now()}`;
      const sendJson = (payload: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const sendSse = (chunks: unknown[]) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.end("data: [DONE]\n\n");
      };
      const requestText = JSON.stringify(body);
      if (requestText.includes("Reply with exactly: OK")) {
        sendJson({
          id,
          object: "chat.completion",
          model: KIMI_MODEL,
          choices: [
            { index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" },
          ],
        });
        return;
      }
      if (hasTools && !hasToolResult) {
        const toolCall = {
          id: "call_kimi_exec",
          type: "function",
          function: {
            name: "exec",
            arguments: JSON.stringify({ command: "hostname; date; uptime" }),
          },
        };
        if (body.stream) {
          sendSse([
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
        } else {
          sendJson({
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
        return;
      }
      const text = "hostname, date, and uptime completed successfully.";
      if (body.stream) {
        sendSse([
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
            choices: [{ index: 0, delta: { content: text } }],
          },
          {
            id,
            object: "chat.completion.chunk",
            model: KIMI_MODEL,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
        ]);
      } else {
        sendJson({
          id,
          object: "chat.completion",
          model: KIMI_MODEL,
          choices: [
            { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
          ],
        });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function parseConfig(raw: string): {
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

test.skipIf(!shouldRunLiveE2EScenarios())(
  "Kimi-compatible endpoint config enables plugin wiring and managed inference route",
  { timeout: TIMEOUT_MS },
  async ({ artifacts, cleanup, host, sandbox }) => {
    const fake = await startKimiMock();
    cleanup.add("close fake Kimi endpoint", () => fake.close());
    cleanup.add("destroy Kimi sandbox", async () => {
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
    });

    await artifacts.writeJson("scenario.json", {
      id: "kimi-inference-compat",
      legacySource: "test/e2e/test-kimi-inference-compat.sh",
      boundary:
        "source CLI onboard + fake OpenAI-compatible Kimi endpoint + OpenClaw config/plugin/inference route",
      sandboxName: SANDBOX_NAME,
      model: KIMI_MODEL,
    });

    const docker = await host.command("docker", ["info"], {
      artifactName: "docker-info",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    expect(docker.exitCode, resultText(docker)).toBe(0);

    await bestEffort(() =>
      host.command("node", [CLI, SANDBOX_NAME, "destroy", "--yes"], {
        artifactName: "pre-cleanup-destroy-kimi",
        env: env(),
        timeoutMs: 120_000,
      }),
    );
    await bestEffort(() =>
      sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
        artifactName: "pre-cleanup-delete-kimi",
        env: env(),
        timeoutMs: 60_000,
      }),
    );

    const onboard = await host.command(
      "node",
      [CLI, "onboard", "--fresh", "--non-interactive", "--yes-i-accept-third-party-software"],
      {
        artifactName: "onboard-kimi-compatible",
        cwd: REPO_ROOT,
        env: env({ NEMOCLAW_ENDPOINT_URL: fake.baseUrl }),
        redactionValues: ["test-kimi-key"],
        timeoutMs: 20 * 60_000,
      },
    );
    expect(onboard.exitCode, resultText(onboard)).toBe(0);

    const config = await sandbox.exec(SANDBOX_NAME, ["cat", "/sandbox/.openclaw/openclaw.json"], {
      artifactName: "openclaw-config",
      env: env(),
      timeoutMs: 60_000,
    });
    expect(config.exitCode, resultText(config)).toBe(0);
    const parsed = parseConfig(config.stdout);
    expect(Object.keys(parsed.providers ?? {})).toEqual(["inference"]);
    const inference = parsed.providers?.inference;
    expect(inference?.baseUrl).toBe("https://inference.local/v1");
    expect(inference?.api).toBe("openai-completions");
    const modelEntry = inference?.models?.find((entry) => entry.id === KIMI_MODEL);
    expect(modelEntry, config.stdout).toBeDefined();
    expect(modelEntry?.compat?.requiresStringContent).toBe(true);
    expect(modelEntry?.compat?.requiresToolResultName).toBe(true);
    expect(modelEntry?.compat?.maxTokensField).toBe("max_tokens");
    expect(modelEntry?.compat?.supportsStore).toBe(false);
    expect(config.stdout).toContain(
      "/usr/local/share/nemoclaw/openclaw-plugins/kimi-inference-compat",
    );
    expect(parsed.primary).toBe(`inference/${KIMI_MODEL}`);
    expect(parsed.pluginEnabled).toBe(true);
    expect(parsed.toolSearch).toBe(false);

    const modelsRoute = await sandbox.exec(
      SANDBOX_NAME,
      ["curl", "-sk", "--max-time", "20", "https://inference.local/v1/models"],
      { artifactName: "inference-local-models", env: env(), timeoutMs: 60_000 },
    );
    expect(modelsRoute.exitCode, resultText(modelsRoute)).toBe(0);
    expect(resultText(modelsRoute)).toContain(KIMI_MODEL);

    const agent = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        "openclaw agent --agent main --json --session-id e2e-kimi-compat -m 'Reply with exactly: OK'",
      ),
      {
        artifactName: "kimi-agent-smoke",
        env: env(),
        redactionValues: ["test-kimi-key"],
        timeoutMs: 150_000,
      },
    );
    expect(agent.exitCode, resultText(agent)).toBe(0);
    expect(resultText(agent)).toMatch(/OK/i);

    const toolAgent = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        "openclaw agent --agent main --json --session-id e2e-kimi-tools -m 'Use the exec tool to run hostname, date, and uptime. Run each command and then say exactly: hostname, date, and uptime completed successfully.'",
      ),
      {
        artifactName: "kimi-agent-tool-splitting",
        env: env(),
        redactionValues: ["test-kimi-key"],
        timeoutMs: 420_000,
      },
    );
    expect(toolAgent.exitCode, resultText(toolAgent)).toBe(0);
    const trajectory = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        String.raw`python3 - <<'PY'
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
final_texts=data.get('assistantTexts') or []
if not final_texts or final_texts[-1] != 'hostname, date, and uptime completed successfully.': errors.append('final text mismatch')
roles=[m.get('role') for m in messages]
if not ('toolResult' in roles and roles[-1]=='assistant'): errors.append('final assistant not after tool result')
print(json.dumps({'errors':errors,'source':source,'toolMetas':metas,'roles':roles}, indent=2))
sys.exit(1 if errors else 0)
PY`,
      ),
      { artifactName: "kimi-trajectory-tool-splitting-check", env: env(), timeoutMs: 60_000 },
    );
    expect(trajectory.exitCode, resultText(trajectory)).toBe(0);
    expect(
      fake.requests.some(
        (request) =>
          request.authOk &&
          request.path.includes("/chat/completions") &&
          request.model === KIMI_MODEL &&
          request.hasTools,
      ),
    ).toBe(true);
    expect(fake.requests.some((request) => request.authOk && request.hasToolResult)).toBe(true);
  },
);
