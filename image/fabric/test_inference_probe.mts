// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";

const requests: { path: string; model: string; key: string | undefined }[] = [];
let broken = "";
let status = 403;
let responseBody: string | undefined;
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push({
    path: request.url!,
    model: body.model,
    key: (request.headers["x-api-key"] ?? request.headers.authorization) as string | undefined,
  });
  response.writeHead(body.model === broken ? status : 200, { "content-type": "application/json" });
  response.end(
    responseBody ?? JSON.stringify(
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
const smart = model("smart", "anthropic-messages", "HOSTED_KEY");
const responses = model("responses", "openai-responses", "HOSTED_KEY");
const config = {
  ...fast,
  agents: [
    { name: "researcher", inference: { default: "fast", models: { fast, smart, responses } } },
    { name: "writer", inference: { default: "fast", models: { fast } } },
  ],
};
async function probe(
  value: unknown,
  credentials = { LOCAL_KEY: "local-placeholder", HOSTED_KEY: "hosted-placeholder" },
  fetchFailure?: { name?: string; code?: string },
) {
  requests.length = 0;
  const child = spawn(
    process.execPath,
    fetchFailure
      ? ["--input-type=module", "-e", `
          globalThis.fetch = async () => {
            const error = new Error("secret-placeholder response body https://private.invalid/");
            error.name = ${JSON.stringify(fetchFailure.name ?? "TypeError")};
            error.cause = { code: ${JSON.stringify(fetchFailure.code)} };
            throw error;
          };
          await import(${JSON.stringify(new URL("inference-probe.mts", import.meta.url).href)});
        `]
      : [fileURLToPath(new URL("inference-probe.mts", import.meta.url))],
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
    child.on("close", resolve);
  });
  assert.equal(output, "", "only the fixed exit code may leave the probe");
  return code;
}
try {
  assert.equal(await probe(config), 0);
  assert.deepEqual(requests.map((r) => r.model).sort(), ["fast", "responses", "smart"]);
  assert(requests.some((r) => r.path === "/v1/messages" && r.key === "hosted-placeholder"));
  assert(requests.some((r) => r.path === "/v1/responses" && r.key === "Bearer hosted-placeholder"));
  assert(
    requests.some((r) => r.path === "/v1/chat/completions" && r.key === "Bearer local-placeholder"),
  );
  broken = "smart";
  assert.equal(await probe(config), 43, "a failing non-default choice must identify HTTP 403");
  broken = "fast";
  for (const [httpStatus, exit] of [
    [400, 40], [401, 41], [403, 43], [404, 44], [408, 48], [429, 49],
    [500, 50], [502, 52], [503, 53], [504, 54], [418, 55],
  ]) {
    status = httpStatus;
    responseBody = "secret-placeholder https://private.invalid/";
    assert.equal(await probe(config), exit, `HTTP ${httpStatus} must produce a fixed exit code`);
  }
  broken = "";
  responseBody = "secret-placeholder https://private.invalid/";
  assert.equal(await probe(fast), 28, "invalid JSON must not expose the response body");
  responseBody = JSON.stringify({ choices: [], private: "secret-placeholder" });
  assert.equal(await probe(fast), 29, "an empty result must identify the response shape failure");
  responseBody = undefined;
  assert.equal(await probe(config, { LOCAL_KEY: "local-placeholder", HOSTED_KEY: "" }), 21);
  assert.equal(await probe(fast), 0, "single-model wire remains supported");
  assert.equal(await probe({ ...fast, api: "unknown" }), 22, "unknown API must fail closed");
  for (const invalid of [null, {}, { ...fast, connection: {} }]) {
    assert.equal(await probe(invalid), 20, "invalid configuration must have a fixed exit code");
  }
  for (const [failure, exit] of [
    [{ name: "TimeoutError" }, 24],
    [{ name: "AbortError" }, 24],
    [{ code: "UND_ERR_CONNECT_TIMEOUT" }, 24],
    [{ code: "CERT_HAS_EXPIRED" }, 25],
    [{ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }, 25],
    [{ code: "ENOTFOUND" }, 26],
    [{ code: "EAI_AGAIN" }, 26],
    [{ code: "ECONNREFUSED" }, 27],
    [{ code: "secret-placeholder" }, 23],
  ] as const) {
    assert.equal(await probe(fast, undefined, failure), exit);
  }
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
