// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Run in an owned, network-disabled image containing the pinned search plugins.
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import type { Duplex } from "node:stream";
import { u as prepareSecretsRuntimeSnapshot } from "/app/dist/runtime-3_-fmbqF.mjs";
import { createOpenClawCodingTools } from "/app/dist/agent-tools-CNTtT1Sj.mjs";
import { t as createBraveProvider } from "/opt/nemoclaw/plugins/brave/dist/brave-web-search-provider-CY6mh6hm.js";
import { t as createTavilyProvider } from "/opt/nemoclaw/plugins/tavily/dist/tavily-search-provider-D3jRulyv.js";

for (const [provider, createProvider] of [
  ["brave", createBraveProvider],
  ["tavily", createTavilyProvider],
] as const) {
  const options = {
    api: "openai-completions",
    tuning: {},
    agents: [{ name: "main" }],
    webSearch: { provider, agentRefs: ["main"], credential: { env: "SEARCH_KEY" } },
  };
  const config: {
    plugins: {
      entries: Record<string, { config: { webSearch: { baseUrl?: string; apiKey: unknown } } }>;
    };
    tools: { web: { search: unknown } };
  } = JSON.parse(
    execFileSync(
      "/opt/fabric/bin/python",
      [
        "-c",
        'import json,sys; from openclaw_adapter import native_configuration; print(json.dumps(native_configuration("main",json.loads(sys.argv[1]))))',
        JSON.stringify(options),
      ],
      { encoding: "utf8" },
    ),
  );
  process.env[`${provider.toUpperCase()}_API_KEY`] = "fixture-placeholder";
  const tools = createOpenClawCodingTools({
    config,
    agentId: "main",
    sessionKey: `agent:main:${provider}`,
    workspaceDir: "/sandbox/workspace",
    cwd: "/sandbox/workspace",
  });
  const names = tools.map((tool) => tool.name);
  assert(names.includes("web_search"), names.join(","));
  const requests: {
    url: string;
    method: string | undefined;
    host: string | undefined;
    key: string | string[] | undefined;
    body: string;
  }[] = [];
  const server = http.createServer(async (request, response) => {
    assert(request.url);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      url: request.url,
      method: request.method,
      host: request.headers.host,
      key: request.headers[provider === "brave" ? "x-subscription-token" : "authorization"],
      body: Buffer.concat(chunks).toString(),
    });
    response.writeHead(200, { "content-type": "application/json" });
    const item = { title: "Owned fixture", url: "https://example.com/fixture" };
    response.end(
      JSON.stringify(
        provider === "brave"
          ? { web: { results: [{ ...item, description: "Search response fixture" }] } }
          : { results: [{ ...item, content: "Search response fixture", score: 1 }] },
      ),
    );
  });
  const tunnels = new Set<Duplex>();
  let proxyRequests = 0;
  server.on("connect", (request, socket, head) => {
    assert.equal(provider, "tavily");
    assert.equal(request.url, "api.tavily.com:80");
    proxyRequests += 1;
    tunnels.add(socket);
    socket.on("close", () => tunnels.delete(socket));
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    server.emit("connection", socket);
    if (head.length) socket.unshift(head);
  });
  const previousProxy = process.env.HTTP_PROXY;
  const previousNoProxy = process.env.NO_PROXY;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const entry = config.plugins.entries[provider];
    assert(entry);
    const fixtureUrl = `http://127.0.0.1:${address.port}`;
    entry.config.webSearch.baseUrl = provider === "tavily" ? "http://api.tavily.com" : fixtureUrl;
    if (provider === "tavily") {
      process.env.HTTP_PROXY = fixtureUrl;
      process.env.NO_PROXY = "";
    }
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config,
      env: process.env,
      includeAuthStoreRefs: false,
    });
    assert.equal(
      snapshot.config.plugins.entries[provider]?.config.webSearch.apiKey,
      "fixture-placeholder",
    );
    const tool = createProvider().createTool({
      config: snapshot.config,
      searchConfig: snapshot.config.tools.web.search,
    });
    const result = await tool.execute({ query: `owned ${provider} fixture`, count: 1 });
    assert(JSON.stringify(result).includes("Owned fixture"));
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert(request);
    assert.equal(
      request.key,
      provider === "brave" ? "fixture-placeholder" : "Bearer fixture-placeholder",
    );
    if (provider === "brave") {
      assert.equal(proxyRequests, 0);
      assert.equal(request.method, "GET");
      assert.equal(new URL(request.url, "http://fixture").pathname, "/res/v1/web/search");
      assert.equal(
        new URL(request.url, "http://fixture").searchParams.get("q"),
        "owned brave fixture",
      );
    } else {
      assert.equal(proxyRequests, 1);
      assert.equal(request.host, "api.tavily.com");
      assert.equal(request.method, "POST");
      assert.equal(new URL(request.url, "http://fixture").pathname, "/search");
      const body = JSON.parse(request.body);
      assert.equal(body.query, "owned tavily fixture");
      assert.equal(body.max_results, 1);
      assert.equal(body.api_key, undefined);
    }
  } finally {
    for (const socket of tunnels) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    delete process.env[`${provider.toUpperCase()}_API_KEY`];
    for (const [key, value] of [
      ["HTTP_PROXY", previousProxy],
      ["NO_PROXY", previousNoProxy],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
console.log(
  "Native Brave and Tavily plugins: single-agent tool grants and HTTP search responses verified.",
);
