// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import {
  startSwitchyardBoundaryUpstream,
  switchyardBoundaryProbe,
  SWITCHYARD_BOUNDARY_ANSWER,
  SWITCHYARD_BOUNDARY_CREDENTIAL_ENV,
  SWITCHYARD_CALLER_CANARY,
} from "../fixtures/hermes-switchyard-boundary.ts";

test("boundary peers require the credential, expose redirect/denial witnesses, and retain no secrets", async () => {
  const fixture = await startSwitchyardBoundaryUpstream("127.0.0.1");
  const url = `http://127.0.0.1:${fixture.port}/v1/chat/completions`;
  const post = (headers: Record<string, string>, body = {}) =>
    fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
  try {
    expect((await post({ authorization: SWITCHYARD_CALLER_CANARY })).status).toBe(401);
    const headers = { authorization: `Bearer ${fixture.credential}` };
    const judged = await post(headers, {
      model: "fixture-capable",
      response_format: { type: "json_schema" },
    });
    const decision = JSON.parse(JSON.parse(await judged.text()).choices[0].message.content);
    expect(decision.p_solve).toBe(0.99);
    const answered = await post(headers, { model: "fixture-efficient" });
    expect(JSON.parse(await answered.text()).choices[0].message.content).toBe(
      SWITCHYARD_BOUNDARY_ANSWER,
    );
    fixture.redirect(true);
    const redirected = await post(headers);
    expect([redirected.status, redirected.headers.get("location")]).toEqual([
      307,
      `${fixture.forbiddenUrl}/chat/completions`,
    ]);
    const forbidden = await fetch(`http://127.0.0.1:${fixture.forbiddenPort}`, {
      signal: AbortSignal.timeout(5_000),
    });
    expect(await forbidden.text()).toBe(SWITCHYARD_BOUNDARY_ANSWER);
    expect(fixture.evidence).toEqual({
      judge: 1,
      answer: 1,
      redirects: 1,
      forbidden: 1,
      badAuth: 1,
      callerLeaked: true,
    });
  } finally {
    await fixture.close();
  }
});

test("boundary probe uses the injected handle and localizes the temporary deployment transport", () => {
  const args = switchyardBoundaryProbe("http://host.openshell.internal:12345/v1");
  const sdk = String.raw`
import os, sys, types
class Runtime:
    def __init__(self):
        injected = os.environ['${SWITCHYARD_BOUNDARY_CREDENTIAL_ENV}']
        if any(os.environ.get(key) != injected for key in ('NVIDIA_INFERENCE_API_KEY', 'OPENAI_API_KEY')):
            raise RuntimeError('Client did not receive the injected credential handle')
    def managed_execution_enabled(self):
        return True
    def shutdown(self):
        pass
async def execute(_capability, _request, _passthrough):
    return {'choices': [{'message': {'content': '${SWITCHYARD_BOUNDARY_ANSWER}'}}]}
relay = types.ModuleType('nemo_relay')
relay.LLMRequest = lambda headers, body: (headers, body)
relay.llm = types.SimpleNamespace(execute=execute)
agent = types.ModuleType('agent')
agent.relay_runtime = types.SimpleNamespace(RELAY_PLUGINS_CONFIG_ENV='TEST_RELAY_CONFIG', RelayRuntime=Runtime)
sys.modules['nemo_relay'] = relay
sys.modules['agent'] = agent
`;
  const probed = spawnSync("python3", ["-I", "-c", sdk + args[3], args[4]!], {
    env: {
      ...process.env,
      [SWITCHYARD_BOUNDARY_CREDENTIAL_ENV]: `openshell:resolve:env:v7_${SWITCHYARD_BOUNDARY_CREDENTIAL_ENV}`,
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(probed.status, probed.stderr).toBe(0);
  expect(JSON.parse(probed.stdout)).toEqual({
    active: true,
    failed: false,
    passthrough: false,
    answer: SWITCHYARD_BOUNDARY_ANSWER,
  });
  const payload = JSON.parse(Buffer.from(args[4]!, "base64").toString());
  expect(payload.deployment.match(/^base_url = .*$/gm)).toEqual([
    'base_url = "http://host.openshell.internal:12345/v1"',
    'base_url = "http://host.openshell.internal:12345/v1"',
  ]);
});
