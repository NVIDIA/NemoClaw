// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";

const requests: { path: string; model: string; key: string | undefined }[] = [];
let broken = "";
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push({
    path: request.url!,
    model: body.model,
    key: (request.headers["x-api-key"] ?? request.headers.authorization) as string | undefined,
  });
  response.writeHead(body.model === broken ? 403 : 200, { "content-type": "application/json" });
  response.end(
    JSON.stringify(
      request.url?.endsWith("/messages")
        ? { content: [{ type: "text", text: "OK" }] }
        : request.url?.endsWith("/responses")
          ? { output: [{ type: "message" }] }
          : { choices: [{ message: { content: "OK" } }] },
    ),
  );
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}/v1`;
const model = (name: string, api: string, credential = "LOCAL_KEY") => ({
  provider: name,
  api,
  tuning: {},
  connection: { provider: name, model: name, base_url: base, api_key_env: credential },
});
const fast = model("fast", "openai-completions");
const smart = model("smart", "anthropic-messages", "ORACLE_KEY");
const responses = model("responses", "openai-responses", "ORACLE_KEY");
const config = {
  ...fast,
  agents: [
    { name: "researcher", inference: { default: "fast", models: { fast, smart, responses } } },
    { name: "writer", inference: { default: "fast", models: { fast } } },
  ],
};
async function probe(
  value: unknown,
  credentials = { LOCAL_KEY: "local-placeholder", ORACLE_KEY: "oracle-placeholder" },
) {
  requests.length = 0;
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("inference-probe.mts", import.meta.url))],
    {
      env: { NEMOCLAW_INFERENCE_CONFIG: JSON.stringify(value), ...credentials },
      stdio: "pipe",
    },
  );
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  assert(!output.includes("placeholder"), "probe must not expose credentials");
  return code;
}
try {
  assert.equal(await probe(config), 0);
  assert.deepEqual(requests.map((r) => r.model).sort(), ["fast", "responses", "smart"]);
  assert(requests.some((r) => r.path === "/v1/messages" && r.key === "oracle-placeholder"));
  assert(requests.some((r) => r.path === "/v1/responses" && r.key === "Bearer oracle-placeholder"));
  assert(
    requests.some((r) => r.path === "/v1/chat/completions" && r.key === "Bearer local-placeholder"),
  );
  broken = "smart";
  assert.equal(await probe(config), 1, "a failing non-default choice must fail readiness");
  broken = "";
  assert.equal(await probe(config, { LOCAL_KEY: "local-placeholder", ORACLE_KEY: "" }), 1);
  assert.equal(await probe(fast), 0, "single-model wire remains supported");
  assert.equal(await probe({ ...fast, api: "unknown" }), 1, "unknown API must fail closed");
  assert.equal(await probe(null), 1);
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
