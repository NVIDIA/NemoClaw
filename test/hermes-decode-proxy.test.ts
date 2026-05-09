// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PROXY_PATH = path.join(import.meta.dirname, "..", "agents", "hermes", "decode-proxy.py");

function runProxyProbe(requestBody: string) {
  const script = String.raw`
import asyncio
import importlib.util
import json
import os

module_path = os.environ["NEMOCLAW_DECODE_PROXY_PATH"]
spec = importlib.util.spec_from_file_location("decode_proxy", module_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

async def main():
    captured = {}

    async def upstream(reader, writer):
        request_line = (await reader.readline()).decode("utf-8", errors="replace").rstrip("\r\n")
        headers = {}
        while True:
            line = await reader.readline()
            if line in (b"\r\n", b"\n", b""):
                break
            text = line.decode("utf-8", errors="replace").rstrip("\r\n")
            name, value = text.split(":", 1)
            headers[name.lower()] = value.strip()
        length = int(headers.get("content-length", "0"))
        body = await reader.readexactly(length) if length else b""
        captured.update({
            "requestLine": request_line,
            "headers": headers,
            "body": body.decode("utf-8", errors="replace"),
        })
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK")
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    upstream_server = await asyncio.start_server(upstream, "127.0.0.1", 0)
    mod.UPSTREAM_HOST = "127.0.0.1"
    mod.UPSTREAM_PORT = upstream_server.sockets[0].getsockname()[1]
    proxy_server = await asyncio.start_server(mod.handle_client, "127.0.0.1", 0)
    proxy_port = proxy_server.sockets[0].getsockname()[1]

    reader, writer = await asyncio.open_connection("127.0.0.1", proxy_port)
    body = os.environ["NEMOCLAW_PROBE_BODY"].encode("utf-8")
    request = (
        b"POST http://slack.test/api/auth.test?token=xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN HTTP/1.1\r\n"
        b"Host: slack.test\r\n"
        b"Authorization: Bearer xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN\r\n"
        b"Content-Type: application/x-www-form-urlencoded\r\n"
        + f"Content-Length: {len(body)}\r\n".encode("ascii")
        + b"\r\n"
        + body
    )
    writer.write(request)
    await writer.drain()
    writer.write_eof()
    await reader.read()
    writer.close()
    await writer.wait_closed()

    proxy_server.close()
    upstream_server.close()
    await proxy_server.wait_closed()
    await upstream_server.wait_closed()
    print(json.dumps(captured, sort_keys=True))

asyncio.run(main())
`;

  const result = spawnSync("python3", ["-c", script], {
    encoding: "utf-8",
    env: {
      ...process.env,
      NEMOCLAW_DECODE_PROXY_PATH: PROXY_PATH,
      NEMOCLAW_PROBE_BODY: requestBody,
    },
    timeout: 10_000,
  });

  if (result.status !== 0) {
    throw new Error(
      `decode proxy probe failed (exit ${result.status}):\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }

  return JSON.parse(result.stdout) as {
    requestLine: string;
    headers: Record<string, string>;
    body: string;
  };
}

describe("agents/hermes/decode-proxy.py", () => {
  it("rewrites Slack bot placeholders in request paths and headers", () => {
    const captured = runProxyProbe("token=xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN");

    expect(captured.requestLine).toContain("token=openshell:resolve:env:SLACK_BOT_TOKEN");
    expect(captured.headers.authorization).toBe(
      "Bearer openshell:resolve:env:SLACK_BOT_TOKEN",
    );
    expect(captured.requestLine).not.toContain("OPENSHELL-RESOLVE-ENV-");
    expect(captured.headers.authorization).not.toContain("OPENSHELL-RESOLVE-ENV-");
  });

  it("rewrites Slack app placeholders in request bodies and adjusts Content-Length", () => {
    const expectedBody = "token=openshell:resolve:env:SLACK_APP_TOKEN";
    const captured = runProxyProbe("token=xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN");

    expect(captured.body).toBe(expectedBody);
    expect(captured.body).not.toContain("OPENSHELL-RESOLVE-ENV-");
    expect(captured.headers["content-length"]).toBe(String(Buffer.byteLength(expectedBody)));
  });
});
