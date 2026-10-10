// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [pi, generator, expectedVersion] = process.argv.slice(2);
assert.ok(
  pi && generator && expectedVersion,
  "Pi executable, generator, and pinned version are required",
);
const home = mkdtempSync(join(tmpdir(), "nemoclaw-pi-native-consumer-"));
const secret = `fixture-${randomUUID()}`;
const model = "native-consumer-model";
const response = "native-pi-consumer-ok";
const requests: { path: string | undefined; authenticated: boolean; model: unknown }[] = [];
const server = http.createServer(async (request, reply) => {
  let text = "";
  for await (const chunk of request) text += chunk;
  const body = JSON.parse(text);
  requests.push({
    path: request.url,
    authenticated: request.headers.authorization === `Bearer ${secret}`,
    model: body.model,
  });
  reply.writeHead(200, { "content-type": "text/event-stream" });
  for (const delta of [{ role: "assistant", content: response }, {}]) {
    reply.write(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: delta.content ? null : "stop" }] })}\n\n`,
    );
  }
  reply.end("data: [DONE]\n\n");
});

try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "Fixture did not bind a loopback port");
  const endpoint = `http://127.0.0.1:${address.port}/v1`;
  // This image consumer probe isolates Pi from external services and host credentials.
  // OpenShell admission, issuance, and revocation remain owned by live routing tests.
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    COMPATIBLE_API_KEY: secret,
    NEMOCLAW_UPSTREAM_PROVIDER: "compatible-endpoint",
    NEMOCLAW_MODEL: model,
    NEMOCLAW_INFERENCE_BASE_URL: endpoint,
    NEMOCLAW_INFERENCE_API: "openai-completions",
  };
  const version = spawnSync(pi, ["--version"], { env, encoding: "utf8", timeout: 10_000 });
  assert.equal(version.status, 0, "Pi version command failed");
  assert.equal(version.stdout.trim(), expectedVersion, "Pi runtime differs from the image pin");
  const generated = spawnSync(process.execPath, [generator], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(generated.status, 0, "Pi catalog generation failed");
  const configPath = join(home, ".pi", "agent", "models.json");
  const config = readFileSync(configPath, "utf8");
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.ok(!config.includes(secret), "Pi catalog contains the fixture credential");
  assert.ok(!config.includes("inference.local"), "Pi catalog uses the shared route");
  const catalog = JSON.parse(config);
  assert.equal(catalog.providers.openshell.baseUrl, endpoint);
  assert.equal(catalog.providers.openshell.apiKey, "$COMPATIBLE_API_KEY");

  const child = spawn(
    pi,
    [
      "--no-approve",
      "--print",
      "--no-session",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--system-prompt",
      "Reply to the supplied prompt.",
      "--provider",
      "openshell",
      "--model",
      model,
      "Reply with the fixture response.",
    ],
    { env, cwd: home, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
  let exit: number | null;
  try {
    exit = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(exit, 0, "Pi native request failed or exceeded its deadline");
  assert.ok(stdout.includes(response), "Pi did not consume the endpoint response");
  assert.ok(!(stdout + stderr).includes(secret), "Pi diagnostics contain the fixture credential");
  assert.deepEqual(requests, [{ path: "/v1/chat/completions", authenticated: true, model }]);
  console.log(
    JSON.stringify({
      contract: "pi-native-compatible-consumer",
      version: expectedVersion,
      authenticatedRequests: 1,
      result: "pass",
    }),
  );
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
}
