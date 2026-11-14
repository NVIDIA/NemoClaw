// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "vitest";
import {
  createHermesSwitchyardRoutingIntent,
  serializeHermesSwitchyardRouting,
} from "../../../src/lib/hermes-switchyard-routing.ts";
import { switchyardBindingFixture } from "../../helpers/hermes-switchyard.ts";
import {
  HERMES_SWITCHYARD_LOCALIZE_DEPLOYMENT,
  HERMES_SWITCHYARD_LOCAL_UPSTREAM,
  HERMES_SWITCHYARD_PROVISION_CONFIG_HASHES,
} from "../fixtures/hermes-switchyard-package.ts";

test.each(["reuse-capable", "dedicated"] as const)(
  "%s fixture localizes each production client without changing judge selection or credentials",
  (judgeMode) => {
    const intent = createHermesSwitchyardRoutingIntent({
      efficient: { provider: "nvidia-prod", model: "fixture-efficient" },
      capable: { provider: "openai-api", model: "fixture-capable" },
      ...(judgeMode === "dedicated"
        ? { judge: { provider: "openai-api", model: "fixture-judge" } }
        : {}),
    });
    const deployment = serializeHermesSwitchyardRouting(
      intent,
      switchyardBindingFixture(intent),
    ).switchyardDeploymentToml;
    const result = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        HERMES_SWITCHYARD_LOCALIZE_DEPLOYMENT +
          String.raw`
import json
import sys

deployment = sys.stdin.read()
endpoints = {'efficient': 'http://127.0.0.1:10001/v1',
             'capable': 'http://127.0.0.1:10002/v1',
             'judge': 'http://127.0.0.1:10003/v1'}
before = tomllib.loads(deployment)
after = tomllib.loads(localize_deployment(deployment, endpoints))
for role, client in before['llm_clients'].items():
    assert after['llm_clients'][role] == dict(client, base_url=endpoints[role])
before.pop('llm_clients')
after.pop('llm_clients')
assert before == after
try:
    localize_deployment(deployment.replace('https://api.openai.com/v1', 'https://unexpected.invalid/v1'), endpoints)
    rejected = False
except ValueError:
    rejected = True
print(json.dumps({'classifier': after['routes']['switchyard']['classifier_target'],
                  'rejectsUnexpectedEndpoint': rejected}))
`,
      ],
      { input: deployment, encoding: "utf8", timeout: 10_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      classifier: judgeMode === "dedicated" ? "judge" : "capable",
      rejectsUnexpectedEndpoint: true,
    });
  },
);

test("routed fixture provisions both integrity anchors without changing file authority", () => {
  const result = spawnSync(
    "python3",
    [
      "-I",
      "-c",
      HERMES_SWITCHYARD_PROVISION_CONFIG_HASHES +
        String.raw`
import importlib.util
import json
import stat
import sys
from tempfile import TemporaryDirectory

spec = importlib.util.spec_from_file_location('runtime_config_guard', sys.argv[1])
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)
with TemporaryDirectory() as directory:
    home = Path(directory) / 'hermes'
    home.mkdir()
    config = home / 'config.yaml'
    env = home / '.env'
    config.write_text('model:\n  default: fixture-original\nmcp_servers: {}\n')
    env.write_text('HERMES_API_PORT=18642\n')
    strict = Path(directory) / 'hermes.config-hash'
    compat = home / '.config-hash'
    original = ''.join(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + str(p) + '\n'
                       for p in (config, env))
    strict.write_text(original)
    compat.write_text(original)
    strict.chmod(0o600)
    compat.chmod(0o640)
    def authority(p):
        s = p.stat()
        return (s.st_uid, s.st_gid, stat.S_IMODE(s.st_mode), s.st_ino)
    before = [authority(p) for p in (strict, compat)]
    config.write_text('model:\n  default: switchyard\nmcp_servers: {}\n')
    provision_config_hashes(home, strict)
    guard.inspect_mcp_integrity_snapshot(str(home), str(strict), str(compat))
    consistent = strict.read_bytes() == compat.read_bytes()
    changed = strict.read_text() != original
    unchanged_authority = before == [authority(p) for p in (strict, compat)]
    compat.write_text(original)
    try:
        guard.inspect_mcp_integrity_snapshot(str(home), str(strict), str(compat))
        rejected = False
    except guard.UnsafePathError:
        rejected = True
    print(json.dumps({'consistent': consistent, 'changed': changed,
                      'unchangedAuthority': unchanged_authority, 'rejectsStaleAnchor': rejected}))
`,
      path.resolve(import.meta.dirname, "../../../agents/hermes/runtime-config-guard.py"),
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    consistent: true,
    changed: true,
    unchangedAuthority: true,
    rejectsStaleAnchor: true,
  });
});

test.each([
  {
    role: "judge",
    key: "OPENAI_API_KEY",
    content: JSON.stringify({
      crux: "bounded fixture task",
      primary_rule: "SUP-1",
      capability_boundary: "supported",
      p_solve: 0.9,
    }),
  },
  {
    role: "capable",
    key: "OPENAI_API_KEY",
    content: JSON.stringify({
      crux: "bounded fixture task",
      primary_rule: "SUP-1",
      capability_boundary: "supported",
      p_solve: 0.9,
    }),
  },
  { role: "efficient", key: "NVIDIA_INFERENCE_API_KEY", content: "routed-efficient" },
])(
  "local $role provider rejects other credentials and retains bounded call evidence",
  ({ role, key, content }) => {
    const result = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        HERMES_SWITCHYARD_LOCAL_UPSTREAM +
          String.raw`
import sys
from tempfile import TemporaryDirectory
from urllib.error import HTTPError
from urllib.request import Request, urlopen

role, key = sys.argv[1:]
with TemporaryDirectory() as directory:
    evidence = Path(directory) / (role + '.jsonl')
    with LocalUpstream(role, evidence) as upstream:
        def request(token):
            return urlopen(Request(upstream.base_url + '/chat/completions',
                data=json.dumps({'model': 'fixture-' + role}).encode(),
                headers={'authorization': 'Bearer ' + token, 'content-type': 'application/json'}), timeout=2)
        try:
            request('wrong-fixture-key')
            raise AssertionError('invalid fixture authentication was accepted')
        except HTTPError as error:
            assert error.code == 401
        assert not evidence.exists()
        with request('xapp-OPENSHELL-RESOLVE-ENV-' + key) as response:
            body = json.load(response)
        calls = [json.loads(line) for line in evidence.read_text().splitlines()]
        print(json.dumps({'body': body, 'calls': calls}))
`,
        role,
        key,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    const { body, calls } = JSON.parse(result.stdout);
    expect(calls).toEqual([
      { role, model: `fixture-${role}`, gatewayListening: expect.any(Boolean) },
    ]);
    expect(body.model).toBe(`fixture-${role}`);
    expect(body.usage).toEqual({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
    expect(body.choices[0].message.content).toBe(content);
  },
);
