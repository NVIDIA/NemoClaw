// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { switchyardBindingFixture } from "../../helpers/hermes-switchyard.ts";
import {
  createHermesSwitchyardRoutingIntent,
  HERMES_SWITCHYARD_DEPLOYMENT_FILE,
  serializeHermesSwitchyardRouting,
} from "../../../src/lib/hermes-switchyard-routing.ts";

export const SWITCHYARD_BOUNDARY_ANSWER = "switchyard-boundary-ok";
export const SWITCHYARD_CALLER_CANARY = "switchyard-caller-must-not-leave-sandbox";
export const SWITCHYARD_BOUNDARY_CREDENTIAL_ENV = "NEMOCLAW_E2E_EXTRA_PROVIDER_TOKEN";

async function listen(server: Server, host: string): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind a port");
  return address.port;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

/** Host-side peers: the forbidden peer stays healthy but is never added to sandbox policy. */
export async function startSwitchyardBoundaryUpstream(bindHost = "0.0.0.0") {
  const credential = `sy-boundary-${randomUUID()}`;
  const evidence = {
    judge: 0,
    answer: 0,
    redirects: 0,
    forbidden: 0,
    badAuth: 0,
    callerLeaked: false,
  };
  let redirect = false;
  const forbidden = createServer((_request, response) => {
    evidence.forbidden++;
    response.writeHead(200).end(SWITCHYARD_BOUNDARY_ANSWER);
  });
  const forbiddenPort = await listen(forbidden, bindHost);
  const upstream = createServer(async (request, response) => {
    // Retain only counts/booleans, never headers, bodies, or credentials in evidence.
    let text = "";
    try {
      for await (const chunk of request) {
        text += chunk.toString();
        if (text.length > 64 * 1024) {
          response.writeHead(413).end();
          return;
        }
      }
    } catch {
      response.destroy();
      return;
    }
    evidence.callerLeaked ||= (JSON.stringify(request.headers) + text).includes(
      SWITCHYARD_CALLER_CANARY,
    );
    const auth = request.headers.authorization;
    // The reused endpointless fixture profile uses header auth, not a hosted bearer profile.
    if (auth !== credential && auth !== `Bearer ${credential}`) {
      evidence.badAuth++;
      response.writeHead(401).end();
      return;
    }
    if (redirect) {
      evidence.redirects++;
      response
        .writeHead(307, {
          location: `http://host.openshell.internal:${forbiddenPort}/v1/chat/completions`,
        })
        .end();
      return;
    }
    let body: { model?: string; response_format?: unknown };
    try {
      body = JSON.parse(text);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const judge = Boolean(body.response_format);
    evidence[judge ? "judge" : "answer"]++;
    const content = judge
      ? JSON.stringify({
          p_solve: 0.99,
          confidence: 0.99,
          difficulty: "easy",
          category: "general",
          reason: "fixture",
        })
      : SWITCHYARD_BOUNDARY_ANSWER;
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        id: "boundary",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  try {
    const port = await listen(upstream, bindHost);
    return {
      credential,
      evidence,
      port,
      forbiddenPort,
      baseUrl: `http://host.openshell.internal:${port}/v1`,
      forbiddenUrl: `http://host.openshell.internal:${forbiddenPort}/v1`,
      redirect: (enabled: boolean) => {
        redirect = enabled;
      },
      close: () => Promise.all([close(upstream), close(forbidden)]),
    };
  } catch (error) {
    await close(forbidden);
    throw error;
  }
}

/** Localize only transport in temporary files; never modify protected startup configuration. */
export function switchyardBoundaryProbe(baseUrl: string): string[] {
  const intent = createHermesSwitchyardRoutingIntent({
    efficient: { provider: "nvidia-prod", model: "fixture-efficient" },
    capable: { provider: "openai-api", model: "fixture-capable" },
  });
  const routing = serializeHermesSwitchyardRouting(intent, switchyardBindingFixture(intent));
  const deployment = routing.switchyardDeploymentToml
    .replace("https://integrate.api.nvidia.com/v1", baseUrl)
    .replace("https://api.openai.com/v1", baseUrl);
  const payload = Buffer.from(
    JSON.stringify({
      deployment,
      plugins: routing.relayPluginsToml,
      state: routing.relayPluginStateJson,
    }),
  ).toString("base64");
  return [
    "/opt/hermes/.venv/bin/python",
    "-I",
    "-c",
    String.raw`
import asyncio, base64, json, os, signal, sys
from pathlib import Path
from tempfile import TemporaryDirectory
import nemo_relay
sys.path.insert(0, '/opt/hermes')
from agent import relay_runtime

signal.alarm(150)
payload = json.loads(base64.b64decode(sys.argv[1]))
with TemporaryDirectory(prefix='switchyard-boundary-') as directory:
    root = Path(directory)
    deployment = root / 'deployment.toml'
    deployment.write_text(payload['deployment'])
    config = root / 'plugins.toml'
    config.write_text(payload['plugins'].replace('${HERMES_SWITCHYARD_DEPLOYMENT_FILE}', str(deployment)))
    (root / '.dynamic-plugins.json').write_text(payload['state'])
    os.environ[relay_runtime.RELAY_PLUGINS_CONFIG_ENV] = str(config)
    for key in ('NVIDIA_INFERENCE_API_KEY', 'OPENAI_API_KEY'):
        os.environ[key] = 'xapp-OPENSHELL-RESOLVE-ENV-${SWITCHYARD_BOUNDARY_CREDENTIAL_ENV}'
    runtime = relay_runtime.RelayRuntime()
    outcome = {'active': False, 'failed': False, 'passthrough': False, 'answer': None}
    try:
        outcome['active'] = runtime.managed_execution_enabled()
        if not outcome['active']:
            raise RuntimeError('Native Switchyard did not activate')
        async def reject_passthrough(_request):
            outcome['passthrough'] = True
            raise RuntimeError('Unexpected provider passthrough')
        async def execute():
            return await nemo_relay.llm.execute('openai.chat_completions', nemo_relay.LLMRequest({
                'authorization': 'Bearer ${SWITCHYARD_CALLER_CANARY}',
                'x-api-key': '${SWITCHYARD_CALLER_CANARY}',
                'x-switchyard-session-id': 'boundary',
            }, {'model': 'switchyard', 'messages': [{'role': 'user', 'content': 'Say OK.'}]}), reject_passthrough)
        try:
            result = asyncio.run(execute())
            outcome['answer'] = result.get('choices', [{}])[0].get('message', {}).get('content')
            outcome['failed'] = bool(result.get('error'))
        except Exception:
            # Do not print upstream errors: they might contain credentials on a regression.
            outcome['failed'] = True
    finally:
        runtime.shutdown()
    print(json.dumps(outcome))
signal.alarm(0)
`,
    payload,
  ];
}
