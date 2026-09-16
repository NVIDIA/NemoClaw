// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Run in an owned, network-disabled image containing the pinned Brave plugin.
import assert from "node:assert/strict";
import http from "node:http";
import { u as prepareSecretsRuntimeSnapshot } from "/app/dist/runtime-3_-fmbqF.mjs";
import { execFileSync } from "node:child_process";
import { createOpenClawCodingTools } from "/app/dist/agent-tools-CNTtT1Sj.mjs";
import { t as createBraveProvider } from "/opt/nemoclaw/plugins/brave/dist/brave-web-search-provider-CY6mh6hm.js";
const options = {
  api: "openai-completions",
  tuning: {},
  agents: [{ name: "main" }, { name: "reader", tools: { allow: ["read"] } }, { name: "writer" }],
  webSearch: { provider: "brave", agentRefs: ["main"], credential: { env: "SEARCH_KEY" } },
};
const config: {
  plugins: { entries: { brave: { config: { webSearch: { baseUrl?: string; apiKey: unknown } } } } };
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
process.env.BRAVE_API_KEY = "fixture-placeholder";
for (const agentId of ["main", "reader", "writer"]) {
  const tools = createOpenClawCodingTools({
    config,
    agentId,
    sessionKey: `agent:${agentId}:fixture`,
    workspaceDir: "/sandbox/workspace",
    cwd: "/sandbox/workspace",
  });
  const names = tools.map((t) => t.name);
  assert.equal(names.includes("web_search"), agentId === "main", `${agentId}: ${names}`);
  if (agentId === "reader") assert.deepEqual(names, ["read"]);
}
const requests: { url: string; key: string | string[] | undefined }[] = [];
const server = http.createServer((request, response) => {
  assert(request.url);
  requests.push({ url: request.url, key: request.headers["x-subscription-token"] });
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      web: {
        results: [
          {
            title: "Owned fixture",
            url: "https://example.com/fixture",
            description: "Search response fixture",
          },
        ],
      },
    }),
  );
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  // A private baseUrl is fixture-only; production always uses Brave's HTTPS endpoint.
  const address = server.address();
  assert(address && typeof address === "object");
  config.plugins.entries.brave.config.webSearch.baseUrl = `http://127.0.0.1:${address.port}`;
  const snapshot = await prepareSecretsRuntimeSnapshot({
    config,
    env: process.env,
    includeAuthStoreRefs: false,
  });
  assert.equal(
    snapshot.config.plugins.entries.brave.config.webSearch.apiKey,
    "fixture-placeholder",
  );
  const tool = createBraveProvider().createTool({
    config: snapshot.config,
    searchConfig: snapshot.config.tools.web.search,
  });
  const result = await tool.execute({ query: "owned fixture", count: 1 });
  assert(JSON.stringify(result).includes("Owned fixture"));
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert(request);
  assert.equal(request.key, "fixture-placeholder");
  assert.equal(new URL(request.url, "http://fixture").pathname, "/res/v1/web/search");
  assert.equal(new URL(request.url, "http://fixture").searchParams.get("q"), "owned fixture");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
console.log("Native Brave plugin: selected-agent tool grants and HTTP search response verified.");
