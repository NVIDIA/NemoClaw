// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { HERMES_SWITCHYARD_LOCAL_UPSTREAM } from "../fixtures/hermes-switchyard-package.ts";

test.each([
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
