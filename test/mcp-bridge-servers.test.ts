// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { MCP_BRIDGE_ALLOWED_METHODS } from "../src/lib/actions/sandbox/mcp-bridge-policy";
import {
  buildCloudflaredQuickTunnelArgs,
  parseTryCloudflareOrigin,
  type StartedHttpServer,
  startCompatibleMock,
  startFakeMcpHttpsServer,
  startPublicMcpHttpsTunnel,
} from "./e2e/live/mcp-bridge-servers";

const servers: StartedHttpServer[] = [];
type CompatibleToolCallResponse = {
  choices: Array<{
    message: {
      content?: unknown;
      tool_calls: Array<{ function: { name: string; arguments: string } }>;
    };
  }>;
};
const tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-fixture-tls-"));
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-keyout",
    path.join(tlsDir, "server.key"),
    "-out",
    path.join(tlsDir, "server.crt"),
  ],
  { stdio: "ignore" },
);
const fixtureTls = {
  cert: fs.readFileSync(path.join(tlsDir, "server.crt")),
  key: fs.readFileSync(path.join(tlsDir, "server.key")),
};

afterAll(() => {
  fs.rmSync(tlsDir, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("authenticated MCP live fixtures", () => {
  it("builds a bounded public HTTPS quick-tunnel origin without embedding credentials", () => {
    expect(buildCloudflaredQuickTunnelArgs(43123)).toEqual([
      "tunnel",
      "--no-autoupdate",
      "--protocol",
      "http2",
      "--url",
      "https://127.0.0.1:43123",
      "--no-tls-verify",
      "--loglevel",
      "info",
    ]);
    expect(() => buildCloudflaredQuickTunnelArgs(0)).toThrow(/invalid local MCP HTTPS port/);
    expect(() => buildCloudflaredQuickTunnelArgs(65_536)).toThrow(/invalid local MCP HTTPS port/);
  });

  it("accepts only an exact public trycloudflare origin from tunnel output", () => {
    expect(
      parseTryCloudflareOrigin(
        '{"message":"https://mcp-fixture-123.trycloudflare.com registered"}',
      ),
    ).toBe("https://mcp-fixture-123.trycloudflare.com");
    expect(parseTryCloudflareOrigin("http://mcp-fixture.trycloudflare.com")).toBeNull();
    expect(
      parseTryCloudflareOrigin("https://mcp-fixture.trycloudflare.com.attacker.invalid"),
    ).toBeNull();
  });

  it("waits for public readiness and registers unconditional process cleanup", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cloudflared-fixture-"));
    const cloudflared = path.join(directory, "cloudflared");
    const priorAmbientSecret = process.env.MCP_TUNNEL_MUST_NOT_LEAK;
    const priorOpenShellSecret = process.env.OPENSHELL_OIDC_CLIENT_SECRET;
    process.env.MCP_TUNNEL_MUST_NOT_LEAK = "ambient-ci-secret";
    process.env.OPENSHELL_OIDC_CLIENT_SECRET = "ambient-openshell-secret";
    fs.writeFileSync(
      cloudflared,
      [
        "#!/bin/sh",
        '[ -z "${MCP_TUNNEL_MUST_NOT_LEAK:-}" ] || exit 9',
        '[ -z "${OPENSHELL_OIDC_CLIENT_SECRET:-}" ] || exit 10',
        "printf '%s\\n' 'https://fixture-cleanup-123.trycloudflare.com' >&2",
        "trap 'exit 0' TERM INT",
        "while :; do sleep 1; done",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ body: null, status: 502 } as Response)
      .mockResolvedValue({ body: null, status: 405 } as Response);
    let cleanupName = "";
    let cleanupProcess: (() => Promise<void>) | undefined;

    try {
      const tunnel = await startPublicMcpHttpsTunnel({
        cloudflaredBin: cloudflared,
        cleanup: {
          add: (name, run) => {
            cleanupName = name;
            cleanupProcess = async () => {
              await run();
            };
          },
        },
        label: "unit MCP fixture",
        server: { port: 43123, close: async () => {} },
      });

      expect(tunnel).toMatchObject({
        origin: "https://fixture-cleanup-123.trycloudflare.com",
        url: "https://fixture-cleanup-123.trycloudflare.com/mcp",
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(cleanupName).toBe("stop unit MCP fixture cloudflared quick tunnel");
      expect(cleanupProcess).toBeTypeOf("function");
    } finally {
      await cleanupProcess?.();
      fetchMock.mockRestore();
      priorAmbientSecret === undefined
        ? delete process.env.MCP_TUNNEL_MUST_NOT_LEAK
        : (process.env.MCP_TUNNEL_MUST_NOT_LEAK = priorAmbientSecret);
      priorOpenShellSecret === undefined
        ? delete process.env.OPENSHELL_OIDC_CLIENT_SECRET
        : (process.env.OPENSHELL_OIDC_CLIENT_SECRET = priorOpenShellSecret);
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("omits failed cloudflared child output from diagnostics", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cloudflared-redaction-"));
    const cloudflared = path.join(directory, "cloudflared");
    const boundaryUrl = "HTTPS://boundary-user:boundary-password@boundary-proxy.example.test:9443/";
    const diagnosticSuffix = [
      "",
      "proxy HTTPS://proxy-user:proxy-password@proxy.example.test:8443 failed",
      "fallback socks5://socks-user:socks-password@socks.example.test:1080 failed",
      "PASSWORD=tunnel-password-value",
      "token: eyJhbGciOiJIUzI1NiJ9.tunnel-payload",
      "",
    ].join("\n");
    const boundaryPaddingBytes =
      32 * 1024 + "HTTPS://".length - boundaryUrl.length - diagnosticSuffix.length;
    fs.writeFileSync(
      cloudflared,
      [
        "#!/bin/sh",
        `printf '%s' '${boundaryUrl}' >&2`,
        `dd if=/dev/zero bs=${boundaryPaddingBytes} count=1 2>/dev/null | tr '\\000' x >&2`,
        `printf '%s' '${diagnosticSuffix}' >&2`,
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      let failure: unknown;
      try {
        await startPublicMcpHttpsTunnel({
          cloudflaredBin: cloudflared,
          cleanup: { add: vi.fn() },
          label: "redaction fixture",
          server: { port: 43123, close: async () => {} },
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      const message = failure instanceof Error ? failure.message : String(failure);
      expect(message).toContain("cloudflared child output omitted from diagnostics");
      expect(message).not.toContain("boundary-proxy.example.test:9443");
      expect(message).not.toContain("proxy.example.test:8443");
      expect(message).not.toContain("socks.example.test:1080");
      expect(message).not.toContain("boundary-user");
      expect(message).not.toContain("boundary-password");
      expect(message).not.toContain("proxy-user");
      expect(message).not.toContain("proxy-password");
      expect(message).not.toContain("socks-user");
      expect(message).not.toContain("socks-password");
      expect(message).not.toContain("tunnel-password-value");
      expect(message).not.toContain("tunnel-payload");
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("omits a Slack credential split across cloudflared data events", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cloudflared-chunks-"));
    const cloudflared = path.join(directory, "cloudflared");
    const credentialPrefix = ["xoxb", "1234567890"].join("-");
    const credentialTail = "-1234567890123-abcdefghijklmnopqrstuvwxyz";
    fs.writeFileSync(
      cloudflared,
      [
        "#!/bin/sh",
        `printf '%s' '${credentialPrefix}' >&2`,
        "sleep 1",
        `printf '%s\\n' '${credentialTail}' >&2`,
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      let failure: unknown;
      try {
        await startPublicMcpHttpsTunnel({
          cloudflaredBin: cloudflared,
          cleanup: { add: vi.fn() },
          label: "chunked redaction fixture",
          server: { port: 43123, close: async () => {} },
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      const message = failure instanceof Error ? failure.message : String(failure);
      expect(message).toContain("cloudflared child output omitted from diagnostics");
      expect(message).not.toContain(credentialPrefix);
      expect(message).not.toContain(credentialTail);
      expect(message).not.toContain(`${credentialPrefix}${credentialTail}`);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("implements stateless Streamable HTTP and validates the tool challenge", async () => {
    const secret = "fixture-secret";
    const challenge = "fixture-challenge";
    const resultToken = `MCP_AUTH_REWRITE_OK::${challenge}`;
    const server = await startFakeMcpHttpsServer({
      secret,
      challenge,
      resultToken,
      tls: fixtureTls,
    });
    servers.push(server);
    const url = `https://127.0.0.1:${server.port}/mcp`;
    const headers = {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    };

    const request = async (
      method: string,
      body?: Record<string, unknown>,
    ): Promise<{ status: number; body: string; json(): unknown }> =>
      await new Promise((resolve, reject) => {
        const encoded = body ? JSON.stringify(body) : "";
        const req = https.request(
          url,
          {
            method,
            ca: fixtureTls.cert,
            headers: encoded
              ? { ...headers, "content-length": Buffer.byteLength(encoded) }
              : headers,
          },
          (response) => {
            let responseBody = "";
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => {
              responseBody += chunk;
            });
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                body: responseBody,
                json: () => JSON.parse(responseBody),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(encoded);
      });

    expect((await request("HEAD")).status).toBe(405);
    expect(server.requests, "public tunnel readiness must not pollute security assertions").toEqual(
      [],
    );
    const initialize = await request("POST", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(initialize.json()).toMatchObject({
      result: { protocolVersion: "2025-06-18" },
    });
    const initialized = await request("POST", {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(initialized.status).toBe(202);

    const list = await request("POST", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(list.json()).toMatchObject({
      result: {
        tools: [
          {
            name: "fake_echo",
            inputSchema: { required: ["challenge"] },
          },
        ],
      },
    });

    const call = await request("POST", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "fake_echo", arguments: { challenge } },
    });
    expect(call.json()).toMatchObject({
      result: {
        content: [{ type: "text", text: resultToken }],
        isError: false,
      },
    });
    const paramsByMethod: Partial<Record<(typeof MCP_BRIDGE_ALLOWED_METHODS)[number], unknown>> = {
      initialize: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "fixture", version: "1.0.0" },
      },
      "tools/call": { name: "fake_echo", arguments: { challenge } },
      "resources/read": { uri: "file:///empty" },
      "resources/subscribe": { uri: "file:///empty" },
      "resources/unsubscribe": { uri: "file:///empty" },
      "prompts/get": { name: "empty", arguments: {} },
      "tasks/get": { taskId: "fake-task" },
      "tasks/update": { taskId: "fake-task", inputResponses: {} },
      "tasks/result": { taskId: "fake-task" },
      "tasks/cancel": { taskId: "fake-task" },
      "completion/complete": {
        ref: { type: "ref/prompt", name: "empty" },
        argument: { name: "value", value: "" },
      },
      "logging/setLevel": { level: "info" },
      "notifications/cancelled": { requestId: 1 },
      "notifications/progress": { progressToken: 1, progress: 1 },
      "notifications/elicitation/complete": {
        elicitationId: "fake-elicitation",
      },
    };

    for (const rpcMethod of MCP_BRIDGE_ALLOWED_METHODS.filter((method) =>
      method.startsWith("notifications/"),
    )) {
      const params = paramsByMethod[rpcMethod];
      const response = await request("POST", {
        jsonrpc: "2.0",
        method: rpcMethod,
        ...(params !== undefined ? { params } : {}),
      });

      expect({ status: response.status, body: response.body }, rpcMethod).toEqual({
        status: 202,
        body: "",
      });
    }

    for (const [index, rpcMethod] of MCP_BRIDGE_ALLOWED_METHODS.filter(
      (method) => !method.startsWith("notifications/"),
    ).entries()) {
      const id = index + 1;
      const params = paramsByMethod[rpcMethod];
      const response = await request("POST", {
        jsonrpc: "2.0",
        id,
        method: rpcMethod,
        ...(params !== undefined ? { params } : {}),
      });

      expect(response.status, rpcMethod).toBe(200);
      expect(JSON.parse(response.body), rpcMethod).toMatchObject({
        jsonrpc: "2.0",
        id,
      });
      expect(JSON.parse(response.body), rpcMethod).not.toHaveProperty("error");
      expect(JSON.parse(response.body), rpcMethod).toHaveProperty("result");
    }

    expect(
      server.requests.every(
        (request) => request.auth !== "Bearer openshell:resolve:env:FAKE_TOKEN",
      ),
    ).toBe(true);
  });

  it("emits an MCP tool call and withholds success until the tool result returns", async () => {
    const resultToken = "MCP_AUTH_REWRITE_OK::fixture";
    const server = await startCompatibleMock({
      apiKey: "compatible-key",
      model: "mock/model",
      toolChallenge: "fixture",
      toolResultToken: resultToken,
      toolNames: ["mcp_fake_fake_echo"],
    });
    servers.push(server);
    const url = `http://127.0.0.1:${server.port}/v1/chat/completions`;
    const headers = {
      authorization: "Bearer compatible-key",
      "content-type": "application/json",
    };
    const first = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "mock/model",
        messages: [{ role: "user", content: "use the tool" }],
        tools: [
          {
            type: "function",
            function: { name: "mcp_fake_fake_echo", parameters: {} },
          },
        ],
      }),
    });
    const firstBody = (await first.json()) as {
      choices: Array<{
        message: {
          tool_calls: Array<{ function: { name: string; arguments: string } }>;
        };
      }>;
    };
    expect(firstBody.choices[0].message.tool_calls[0]).toMatchObject({
      function: {
        name: "mcp_fake_fake_echo",
        arguments: JSON.stringify({ challenge: "fixture" }),
      },
    });
    expect(JSON.stringify(firstBody)).not.toContain(resultToken);

    const final = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "mock/model",
        messages: [{ role: "tool", content: resultToken }],
        tools: [
          {
            type: "function",
            function: { name: "mcp_fake_fake_echo", parameters: {} },
          },
        ],
      }),
    });
    expect(await final.json()).toMatchObject({
      choices: [{ message: { content: resultToken } }],
    });

    const streamed = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "mock/model",
        stream: true,
        messages: [{ role: "user", content: "use the tool" }],
        tools: [
          {
            type: "function",
            function: { name: "mcp_fake_fake_echo", parameters: {} },
          },
        ],
      }),
    });
    const firstDataLine = (await streamed.text())
      .split("\n")
      .find((line) => line.startsWith("data: {") && line.includes("tool_calls"));
    expect(firstDataLine).toBeDefined();
    const firstChunk = JSON.parse(firstDataLine!.slice("data: ".length));
    expect(firstChunk).toMatchObject({
      model: "mock/model",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { name: "mcp_fake_fake_echo" },
              },
            ],
          },
        },
      ],
    });
  });

  it("uses Hermes progressive disclosure when the MCP tool is deferred", async () => {
    const resultToken = "MCP_AUTH_REWRITE_OK::deferred-fixture";
    const server = await startCompatibleMock({
      apiKey: "compatible-key",
      model: "mock/model",
      toolChallenge: "deferred-fixture",
      toolResultToken: resultToken,
      deferredToolName: "mcp_fake_fake_echo",
    });
    servers.push(server);
    const url = `http://127.0.0.1:${server.port}/v1/chat/completions`;
    const headers = {
      authorization: "Bearer compatible-key",
      "content-type": "application/json",
    };
    const bridgeTools = ["tool_search", "tool_describe", "tool_call"].map((name) => ({
      type: "function",
      function: { name, parameters: {} },
    }));

    const call = async (
      messages: Array<{ role: string; content: string; tool_call_id?: string }>,
    ) =>
      (await (
        await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ model: "mock/model", messages, tools: bridgeTools }),
        })
      ).json()) as CompatibleToolCallResponse;
    const searchBody = await call([{ role: "user", content: "use the deferred tool" }]);
    expect(searchBody.choices[0].message.tool_calls[0]).toMatchObject({
      function: {
        name: "tool_search",
        arguments: JSON.stringify({ query: "mcp_fake_fake_echo" }),
      },
    });
    const missedSearch = await call([
      {
        role: "tool",
        tool_call_id: "call_hermes_tool_search",
        content: '{"matches":[{"name":"some_other_tool"}]}',
      },
    ]);
    expect(missedSearch).toMatchObject({
      choices: [
        { message: { content: expect.stringContaining("did not return the deferred target") } },
      ],
    });
    const searchResult = {
      role: "tool",
      tool_call_id: "call_hermes_tool_search",
      content: '{"matches":[{"name":"mcp_fake_fake_echo"}]}',
    };
    const describeBody = await call([searchResult]);
    expect(describeBody.choices[0].message.tool_calls[0]).toMatchObject({
      function: {
        name: "tool_describe",
        arguments: JSON.stringify({ name: "mcp_fake_fake_echo" }),
      },
    });
    const wrongDescription = await call([
      searchResult,
      {
        role: "tool",
        tool_call_id: "call_hermes_tool_describe",
        content: '{"name":"mcp_fake_fake_echo","parameters":{}}',
      },
    ]);
    expect(wrongDescription).toMatchObject({
      choices: [
        { message: { content: expect.stringContaining("did not return the deferred schema") } },
      ],
    });
    const descriptionResult = {
      role: "tool",
      tool_call_id: "call_hermes_tool_describe",
      content:
        '{"name":"mcp_fake_fake_echo","parameters":{"properties":{"challenge":{"type":"string"}}}}',
    };
    const callBody = await call([searchResult, descriptionResult]);
    expect(callBody.choices[0].message.tool_calls[0]).toMatchObject({
      function: {
        name: "tool_call",
        arguments: JSON.stringify({
          name: "mcp_fake_fake_echo",
          arguments: { challenge: "deferred-fixture" },
        }),
      },
    });
    expect(JSON.stringify(callBody)).not.toContain(resultToken);

    const finalBody = await call([
      searchResult,
      descriptionResult,
      {
        role: "tool",
        tool_call_id: "call_hermes_tool_call",
        content: JSON.stringify({ result: resultToken }),
      },
    ]);
    expect(finalBody).toMatchObject({
      choices: [{ message: { content: resultToken } }],
    });
  });

  it("fails closed when a Hermes deferred tool leaks into the model registry", async () => {
    const server = await startCompatibleMock({
      apiKey: "compatible-key",
      model: "mock/model",
      toolChallenge: "leak-fixture",
      deferredToolName: "mcp_fake_fake_echo",
    });
    servers.push(server);
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer compatible-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "use the deferred tool" }],
        tools: ["tool_search", "tool_describe", "tool_call", "mcp_fake_fake_echo"].map((name) => ({
          type: "function",
          function: { name, parameters: {} },
        })),
      }),
    });
    expect(await response.json()).toMatchObject({
      choices: [
        {
          message: {
            content: expect.stringContaining("deferred target mcp_fake_fake_echo leaked"),
          },
        },
      ],
    });
  });

  it("requires Deep Agents search_tools before exposing the matching MCP tool", async () => {
    const resultToken = "MCP_AUTH_REWRITE_OK::progressive-fixture";
    const server = await startCompatibleMock({
      apiKey: "compatible-key",
      model: "mock/model",
      toolChallenge: "progressive-fixture",
      toolResultToken: resultToken,
      progressiveToolSearch: {
        toolName: "fake_fake_echo",
        query: "AuThEnTiCaTeD McP",
      },
    });
    servers.push(server);
    const url = `http://127.0.0.1:${server.port}/v1/chat/completions`;
    const headers = {
      authorization: "Bearer compatible-key",
      "content-type": "application/json",
    };
    const post = async (
      messages: Array<{ role: string; content: string; tool_call_id?: string }>,
      tools: string[],
    ) =>
      (await (
        await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            messages,
            tools: tools.map((name) => ({ type: "function", function: { name, parameters: {} } })),
          }),
        })
      ).json()) as CompatibleToolCallResponse;

    const searchBody = await post([{ role: "user", content: "use MCP" }], ["search_tools", "ls"]);
    expect(searchBody.choices[0].message.tool_calls[0]).toMatchObject({
      function: {
        name: "search_tools",
        arguments: JSON.stringify({ query: "AuThEnTiCaTeD McP" }),
      },
    });
    const missedSearch = await post(
      [
        {
          role: "tool",
          tool_call_id: "call_progressive_tool_search",
          content: "No hidden tools matched",
        },
      ],
      ["search_tools", "ls"],
    );
    expect(missedSearch).toMatchObject({
      choices: [{ message: { content: expect.stringContaining("did not return the expected") } }],
    });
    const legacySearch = await post(
      [
        {
          role: "tool",
          tool_call_id: "call_progressive_tool_search",
          content: "Discovered fake_fake_echo",
        },
      ],
      ["search_tools", "ls", "fake_fake_echo"],
    );
    expect(legacySearch).toMatchObject({
      choices: [{ message: { content: expect.stringContaining("did not return the expected") } }],
    });
    const searchResult = {
      role: "tool",
      tool_call_id: "call_progressive_tool_search",
      content:
        "Found 1 matching hidden tool(s); returning 1 bounded discovery candidate(s) " +
        "(per-search limit 20):\n- fake_fake_echo: Authenticated MCP tool",
    };
    const callBody = await post([searchResult], ["search_tools", "ls", "fake_fake_echo"]);
    expect(callBody.choices[0].message.tool_calls[0]).toMatchObject({
      function: {
        name: "fake_fake_echo",
        arguments: JSON.stringify({ challenge: "progressive-fixture" }),
      },
    });
    const finalBody = await post(
      [
        searchResult,
        { role: "tool", tool_call_id: "call_progressive_mcp_proof", content: resultToken },
      ],
      ["search_tools", "ls", "fake_fake_echo"],
    );
    expect(finalBody).toMatchObject({ choices: [{ message: { content: resultToken } }] });

    const leaked = await post(
      [{ role: "user", content: "use MCP" }],
      ["search_tools", "fake_fake_echo"],
    );
    expect(leaked).toMatchObject({
      choices: [
        {
          message: {
            content: expect.stringContaining("visible before search_tools"),
          },
        },
      ],
    });
  });
});
