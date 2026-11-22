// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import {
  isSwitchyardCallbackPolicyDenial,
  startSwitchyardBoundaryUpstream,
  switchyardBoundaryProbe,
  SWITCHYARD_BOUNDARY_ANSWER,
  SWITCHYARD_BOUNDARY_CREDENTIAL_ENV,
  SWITCHYARD_CALLER_CANARY,
  SWITCHYARD_BODY_CANARY,
  SWITCHYARD_PEER_CREDENTIAL_ENV,
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
    fixture.respondWithError(true);
    const judged = await post(headers, {
      model: "fixture-capable",
      response_format: { type: "json_schema" },
    });
    const decision = JSON.parse(JSON.parse(await judged.text()).choices[0].message.content);
    expect(decision).toEqual({
      crux: "bounded fixture task",
      primary_rule: "SUP-1",
      capability_boundary: "supported",
      p_solve: 0.99,
    });
    fixture.respondWithError(false);
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
    fixture.redirect(false);
    fixture.respondWithError(true);
    const failure = await post(headers);
    expect(failure.status).toBe(500);
    expect(await failure.text()).toContain(SWITCHYARD_BODY_CANARY);
    expect(fixture.evidence).toEqual({
      requests: 5,
      judge: 1,
      answer: 1,
      redirects: 1,
      errors: 1,
      forbidden: 1,
      badAuth: 1,
      callerLeaked: true,
    });
  } finally {
    await fixture.close();
  }
});

test.each([undefined, SWITCHYARD_PEER_CREDENTIAL_ENV] as const)(
  "boundary probe selects issued handle %s and localizes only temporary transport",
  (credentialEnv) => {
    const args = switchyardBoundaryProbe("http://host.openshell.internal:12345/v1", {
      credentialEnv,
    });
    const sdk = String.raw`
import base64, json, os, sys, types
class Runtime:
    def __init__(self):
        injected = os.environ[json.loads(base64.b64decode(sys.argv[1]))['credentialEnv']]
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
        [SWITCHYARD_PEER_CREDENTIAL_ENV]: `openshell:resolve:env:v9_${SWITCHYARD_PEER_CREDENTIAL_ENV}`,
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
      callback_status: null,
      callback_errno: null,
      callback_syscall: null,
      failure_category: null,
    });
    const payload = JSON.parse(Buffer.from(args[4]!, "base64").toString());
    expect(payload.deployment.match(/^base_url = .*$/gm)).toEqual([
      'base_url = "http://host.openshell.internal:12345/v1"',
      'base_url = "http://host.openshell.internal:12345/v1"',
    ]);
  },
);

function runContinuationProbe(mode: "unmanaged" | "unmatched" | undefined, fault = "") {
  const args = switchyardBoundaryProbe("http://host.openshell.internal:12345/v1", { mode });
  const sdk = String.raw`
import base64, io, json, os, socket, sys, types, urllib.error, urllib.request
payload = json.loads(base64.b64decode(sys.argv[1]))
fault = os.environ['TEST_PROBE_FAULT']
canary = '${SWITCHYARD_BODY_CANARY}' * 10000
class Runtime:
    def managed_execution_enabled(self): return bool(os.environ.get('TEST_RELAY_CONFIG'))
    def shutdown(self):
        if socket.socket.connect is not fixture_connect: raise RuntimeError('Connect observer not restored')
        if fault == 'shutdown': raise RuntimeError(canary)
class Response:
    status = 200
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self, size):
        if fault == 'parse': return canary.encode()
        if fault == 'read': raise OSError(canary)
        return json.dumps({'choices': [{'message': {'content': '${SWITCHYARD_BOUNDARY_ANSWER}'}}]}).encode()
original_connect = socket.socket.connect
def fixture_connect(sock, address):
    if fault in ('connect-permission', 'connect-unrelated-permission'): raise PermissionError(13, canary)
    if fault == 'connect-refused': raise ConnectionRefusedError(111, canary)
    if fault == 'connect-timed-out': raise TimeoutError(110, canary)
    raise RuntimeError('Unexpected network attempt')
socket.socket.connect = fixture_connect
def urlopen(request, **kwargs):
    if fault.startswith('connect-'):
        try:
            with socket.socket() as sock: sock.connect(('127.0.0.1', 1))
        except OSError as error:
            if fault == 'connect-unrelated-permission': error = PermissionError(13, canary)
            raise urllib.error.URLError(error) from None
    if fault in ('http', 'denial'):
        status = 403 if fault == 'denial' else 503
        raise urllib.error.HTTPError(request.full_url, status, 'fixture error', {}, io.BytesIO(canary.encode()))
    if fault == 'proxy':
        raise urllib.error.URLError(OSError('Tunnel connection failed: 403 Forbidden ' + canary))
    if fault == 'transport': raise urllib.error.URLError(OSError(canary))
    errnos = {'permission': 13, 'refused': 111, 'timed-out': 110,
        'negative-errno': -1, 'oversized-errno': 4096, 'boolean-errno': True,
        'string-errno': canary}
    if fault in errnos:
        reason = OSError(canary)
        reason.errno = errnos[fault]
        raise urllib.error.URLError(reason)
    return Response()
def checked_urlopen(request, **kwargs):
    try: return urlopen(request, **kwargs)
    finally:
        if socket.socket.connect is fixture_connect: raise RuntimeError('Missing connect observation')
urllib.request.urlopen = checked_urlopen
async def execute(capability, request, continuation):
    if fault == 'native-exception': raise RuntimeError(canary)
    if fault == 'native-error': return {'error': {'message': canary}}
    if fault == 'native-answer': return {'choices': [{'message': {'content': canary}}]}
    return await continuation(request)
relay = types.ModuleType('nemo_relay')
relay.LLMRequest = lambda headers, body: body
relay.llm = types.SimpleNamespace(execute=execute)
agent = types.ModuleType('agent')
agent.relay_runtime = types.SimpleNamespace(RELAY_PLUGINS_CONFIG_ENV='TEST_RELAY_CONFIG', RelayRuntime=Runtime)
sys.modules['nemo_relay'] = relay
sys.modules['agent'] = agent
`;
  const result = spawnSync("python3", ["-I", "-c", sdk + args[3], args[4]!], {
    env: {
      ...process.env,
      TEST_PROBE_FAULT: fault,
      [SWITCHYARD_BOUNDARY_CREDENTIAL_ENV]: "issued-fixture-handle",
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(Buffer.byteLength(result.stdout + result.stderr)).toBeLessThan(1024);
  expect(result.stdout + result.stderr).not.toContain(SWITCHYARD_BODY_CANARY);
  return result;
}

function continuationProbe(mode: "unmanaged" | "unmatched" | undefined, fault = "") {
  const result = runContinuationProbe(mode, fault);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

test.each(["unmanaged", "unmatched"] as const)(
  "%s routing exercises the original-provider continuation",
  (mode) => {
    const outcome = continuationProbe(mode);
    expect(isSwitchyardCallbackPolicyDenial(outcome)).toBe(false);
    expect(outcome).toEqual({
      active: mode === "unmatched",
      failed: false,
      passthrough: true,
      answer: SWITCHYARD_BOUNDARY_ANSWER,
      callback_status: 200,
      callback_errno: null,
      callback_syscall: null,
      failure_category: null,
    });
  },
);

test.each(["unmanaged", "unmatched"] as const)(
  "%s callback failures expose only observed status and bounded categories",
  (mode) => {
    const denial = continuationProbe(mode, "denial");
    expect(isSwitchyardCallbackPolicyDenial(denial)).toBe(true);
    expect(denial).toMatchObject({
      failed: true,
      callback_status: 403,
      failure_category: "http_error",
      answer: null,
    });
    const http = continuationProbe(mode, "http");
    expect(isSwitchyardCallbackPolicyDenial(http)).toBe(false);
    expect(http).toMatchObject({
      failed: true,
      callback_status: 503,
      failure_category: "http_error",
      answer: null,
    });
    const proxy = continuationProbe(mode, "proxy");
    expect(isSwitchyardCallbackPolicyDenial(proxy)).toBe(true);
    expect(proxy).toMatchObject({
      failed: true,
      callback_status: 403,
      failure_category: "proxy_connect_denied",
      answer: null,
    });
    const transport = continuationProbe(mode, "transport");
    expect(isSwitchyardCallbackPolicyDenial(transport)).toBe(false);
    expect(transport).toMatchObject({
      failed: true,
      callback_status: null,
      failure_category: "transport_error",
      answer: null,
    });
  },
);

test.each([
  ["unmanaged", "parse"],
  ["unmanaged", "read"],
  ["unmatched", "parse"],
  ["unmatched", "read"],
] as const)("%s callback %s failure preserves HTTP 200 instead of a denial", (mode, fault) => {
  expect(continuationProbe(mode, fault)).toMatchObject({
    failed: true,
    callback_status: 200,
    failure_category: "upstream_details_unavailable",
    answer: null,
  });
});

test.each(["native-exception", "native-error"])(
  "%s preserves unavailable upstream detail without leaking bodies",
  (fault) => {
    expect(continuationProbe(undefined, fault)).toMatchObject({
      failed: true,
      callback_status: null,
      failure_category: "upstream_details_unavailable",
      answer: null,
    });
  },
);

test("unexpected content is withheld and shutdown failure cannot satisfy a denial probe", () => {
  expect(continuationProbe(undefined, "native-answer").answer).toBeNull();
  const stopped = runContinuationProbe("unmanaged", "shutdown");
  expect(stopped.status).toBe(1);
  expect(stopped.stderr).toContain("Native Switchyard shutdown failed");
  expect(stopped.stdout).toBe("");
});

test.each(
  (["unmanaged", "unmatched"] as const).flatMap((mode) =>
    (
      [
        ["connect-permission", 13],
        ["connect-unrelated-permission", 13],
        ["connect-refused", 111],
        ["connect-timed-out", 110],
        ["permission", 13],
        ["refused", 111],
        ["timed-out", 110],
        ["negative-errno", null],
        ["oversized-errno", null],
        ["boolean-errno", null],
        ["string-errno", null],
      ] as const
    ).map(([fault, errno]) => [mode, fault, errno] as const),
  ),
)("%s callback %s retains only a bounded numeric errno", (mode, fault, errno) => {
  const outcome = continuationProbe(mode, fault);
  expect(isSwitchyardCallbackPolicyDenial(outcome)).toBe(fault === "connect-permission");
  expect(outcome).toMatchObject({
    failed: true,
    callback_status: null,
    callback_errno: errno,
    callback_syscall:
      fault.startsWith("connect-") && fault !== "connect-unrelated-permission" ? "connect" : null,
    failure_category: "transport_error",
    answer: null,
  });
});
