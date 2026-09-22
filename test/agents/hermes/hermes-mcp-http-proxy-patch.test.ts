// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const PATCHER = path.join(ROOT, "agents", "hermes", "patch-mcp-http-proxy.py");

const UPSTREAM_FIXTURE = `from typing import Optional

def _present(**kwargs) -> dict:
    """*kwargs* minus the \`\`None\`\` values (optional httpx client arguments)."""
    return {k: v for k, v in kwargs.items() if v is not None}

def _make_mcp_body_cap_transport(_module, transport):
    return ("capped", transport)

class Transport:
    def sse(self, headers, ssl_verify, client_cert, _httpx_mod):
        sse_kwargs = {}
        sse_kwargs["httpx_client_factory"] = lambda headers=None, timeout=None, auth=None: _httpx_mod.AsyncClient(
            follow_redirects=True,
            timeout=timeout if timeout is not None else _httpx_mod.Timeout(30.0, read=300.0),
            transport=_make_mcp_body_cap_transport(
                _httpx_mod, _httpx_mod.AsyncHTTPTransport(verify=ssl_verify, **_present(cert=client_cert))),
            **_present(headers=headers, auth=auth))
        return sse_kwargs

    def streamable(self, headers, ssl_verify, client_cert, oauth_auth, connect_timeout, httpx):
        _strip_auth_on_cross_origin_redirect = object()
        client_kwargs: dict = {"follow_redirects": True, "timeout": httpx.Timeout(float(connect_timeout), read=300.0),
                               **({"headers": headers} if headers else {}),
                               "event_hooks": {"response": [_strip_auth_on_cross_origin_redirect]},
                               "transport": _make_mcp_body_cap_transport(
                                   httpx, httpx.AsyncHTTPTransport(verify=ssl_verify, **_present(cert=client_cert))),
                               **_present(auth=oauth_auth)}
        async def owned_client():
            async with httpx.AsyncClient(**client_kwargs) as http_client:
                return http_client
        return client_kwargs, owned_client
`;

function runPatcher(fixture: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-mcp-proxy-"));
  const transportPath = path.join(tmp, "mcp_tool_transport.py");
  fs.writeFileSync(transportPath, fixture);
  const result = spawnSync("python3", ["-I", PATCHER, transportPath], {
    encoding: "utf-8",
    timeout: 5000,
  });
  return { result, transportPath, tmp };
}

describe("Hermes MCP managed proxy transport patch", () => {
  it("routes both body-capped HTTP transports through the selected environment proxy", () => {
    const { result, transportPath, tmp } = runPatcher(UPSTREAM_FIXTURE);
    try {
      expect(result.status, result.stderr).toBe(0);
      const source = fs.readFileSync(transportPath, "utf-8");
      expect(source.match(/_body_capped_httpx_client\(/gu)).toHaveLength(3);
      expect(source).not.toContain("AsyncHTTPTransport(");

      const probe = spawnSync(
        "python3",
        [
          "-I",
          "-c",
          [
            "import json, runpy, sys",
            "namespace = runpy.run_path(sys.argv[1])",
            "class FakeTransport:",
            " def __init__(self, **kwargs): self.kwargs = kwargs",
            "class FakeClient:",
            " def __init__(self, **kwargs): self.kwargs = kwargs; self._transport = FakeTransport(kind='direct'); self._mounts = {'proxy': FakeTransport(kind='proxy'), 'excluded': None}",
            "class FakeHttpx:",
            " AsyncHTTPTransport = FakeTransport",
            " @staticmethod",
            " def AsyncClient(**kwargs): return FakeClient(**kwargs)",
            " @staticmethod",
            " def Timeout(*args, **kwargs): return (args, kwargs)",
            "fake_httpx = FakeHttpx()",
            "client = namespace['_body_capped_httpx_client'](fake_httpx, verify=True)",
            "print(json.dumps({'trust_env': client.kwargs['trust_env'], 'direct': client._transport[0], 'proxy': client._mounts['proxy'][0], 'excluded': client._mounts['excluded']}))",
          ].join("\n"),
          transportPath,
        ],
        {
          encoding: "utf-8",
          env: {
            PATH: process.env.PATH ?? "",
          },
          timeout: 5000,
        },
      );
      expect(probe.status, probe.stderr).toBe(0);
      expect(JSON.parse(probe.stdout)).toEqual({
        trust_env: true,
        direct: "capped",
        proxy: "capped",
        excluded: null,
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("is idempotent", () => {
    const { result, transportPath, tmp } = runPatcher(UPSTREAM_FIXTURE);
    try {
      expect(result.status, result.stderr).toBe(0);
      const once = fs.readFileSync(transportPath, "utf-8");
      const second = spawnSync("python3", ["-I", PATCHER, transportPath], {
        encoding: "utf-8",
        timeout: 5000,
      });
      expect(second.status, second.stderr).toBe(0);
      expect(fs.readFileSync(transportPath, "utf-8")).toBe(once);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed without editing when the pinned transport shape changes", () => {
    const drifted = UPSTREAM_FIXTURE.replace(
      "httpx.AsyncHTTPTransport(verify=ssl_verify, **_present(cert=client_cert))",
      "httpx.AsyncHTTPTransport(verify=ssl_verify, trust_env=True, **_present(cert=client_cert))",
    );
    const { result, transportPath, tmp } = runPatcher(drifted);
    try {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("MCP HTTP proxy source shape changed");
      expect(fs.readFileSync(transportPath, "utf-8")).toBe(drifted);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
