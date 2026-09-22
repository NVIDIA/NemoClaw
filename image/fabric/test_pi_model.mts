// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryCredentialStore } from "/opt/fabric-source/adapters/typescript/node_modules/@earendil-works/pi-ai/dist/index.js";
import { loadConfiguredModel } from "/opt/fabric-source/adapters/typescript/pi/dist/pi-model.js";

const selected = {
  provider: "openai",
  model: "gpt-4o-mini",
  base_url: "https://inference.local/v1",
};
const load = (
  metadata: NonNullable<Parameters<typeof loadConfiguredModel>[0]["settings"]>[string] | undefined,
  model = "qwen3:4b",
) =>
  loadConfiguredModel(
    {
      ...selected,
      model,
      ...(metadata === undefined ? {} : { settings: { model_metadata: metadata } }),
    },
    new InMemoryCredentialStore(),
  );

test("Pi resolves the declared catalog model", async () => {
  const loaded = await load(undefined, selected.model);
  try {
    assert.equal(loaded.model.id, selected.model);
    assert.equal(loaded.model.baseUrl, selected.base_url);
  } finally {
    await loaded.cleanup();
  }
});

test("Pi loads native fields, applies defaults, and preserves deployment identity", async () => {
  const loaded = await load({
    api: "openai-completions",
    contextWindow: 8192,
    maxTokens: 2048,
    thinkingLevelMap: { off: null },
    samplingParams: { temperature: 0.17 },
    compat: { supportsDeveloperRole: false },
    id: "wrong-model",
    baseUrl: "https://wrong.example/v1",
  });
  try {
    const model = loaded.model;
    assert.equal(model.id, "qwen3:4b");
    assert.equal(model.baseUrl, selected.base_url);
    assert.equal(model.contextWindow, 8192);
    assert.equal(model.maxTokens, 2048);
    assert.equal(model.api, "openai-completions");
    assert.deepEqual(model.thinkingLevelMap, { off: null });
    assert.deepEqual(model.samplingParams, { temperature: 0.17 });
    assert(model.compat && "supportsDeveloperRole" in model.compat);
    assert.equal(model.compat.supportsDeveloperRole, false);
    assert.equal(model.reasoning, false);
    assert.deepEqual(model.input, ["text"]);
  } finally {
    await loaded.cleanup();
  }
});

test("Pi rejects invalid native schema values and invalid context limits", async () => {
  await assert.rejects(
    load({ api: "openai-completions", contextWindow: "invalid" }),
    /Invalid models.json schema/,
  );
  await assert.rejects(
    load({ api: "openai-completions", contextWindow: -1 }),
    /invalid contextWindow/,
  );
});

test("unknown models without configuration fail instead of borrowing another model", async () => {
  await assert.rejects(load(undefined, "custom-model"), /piModel/);
});

test(
  "Pi keeps endpoint credentials and conversation history when switching choices",
  { timeout: 30000 },
  async () => {
    const { createServer } = await import("node:http");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { PiAdapterRuntime } =
      await import("/opt/fabric-source/adapters/typescript/pi/dist/runtime.js");
    const { PiSdkSessionFactory } =
      await import("/opt/fabric-source/adapters/typescript/pi/dist/pi-sdk.js");
    const requests: {
      path: string | undefined;
      authorization: string | undefined;
      body: { messages: unknown[] };
    }[] = [];
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push({
        path: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "FOUR" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const workspace = await mkdtemp(join(tmpdir(), "pi-choices-"));
    const runtime = new PiAdapterRuntime(new PiSdkSessionFactory());
    try {
      const address = server.address();
      assert(address && typeof address === "object");
      const choice = (path: string, key: string) => ({
        provider: "openai",
        model: "fixture",
        base_url: `http://127.0.0.1:${address.port}/${path}/v1`,
        api_key_env: key,
        settings: {
          model_metadata: { api: "openai-completions", contextWindow: 8192, maxTokens: 128 },
        },
      });
      const fast = choice("fast", "FAST_KEY");
      const smart = choice("smart", "SMART_KEY");
      const input = {
        agentName: "main",
        baseDir: workspace,
        config: {
          models: { default: fast, route_fast: fast, route_smart: smart },
          tools: { enabled: [] },
        },
        runtimeContext: {
          artifacts: {},
          environment: {
            control_location: "external_control" as const,
            environment_id: "fixture",
            ownership: "caller_owned" as const,
            provider: "local" as const,
            workspace,
            env: { FAST_KEY: "fixture-fast", SMART_KEY: "fixture-smart" },
          },
          invocation_id: "start",
          request_id: "start",
          runtime_id: "fixture",
        },
      };
      await runtime.start(input);
      for (const model of ["fast", "smart"]) {
        const result = await runtime.invoke(
          { input: { prompt: "Reply FOUR", model } },
          input.runtimeContext,
        );
        assert.equal(result.status, "succeeded", JSON.stringify(result));
      }
      assert.deepEqual(
        requests.map((r) => [r.path, r.authorization]),
        [
          ["/fast/v1/chat/completions", "Bearer fixture-fast"],
          ["/smart/v1/chat/completions", "Bearer fixture-smart"],
        ],
      );
      assert(
        requests[1]!.body.messages.length > requests[0]!.body.messages.length,
        "model switch must preserve conversation history",
      );
      const unknown = await runtime.invoke(
        { input: { prompt: "Do not send", model: "missing" } },
        input.runtimeContext,
      );
      assert.equal(unknown.status, "failed");
      assert.equal(requests.length, 2, "unknown choices must fail before inference");
    } finally {
      await runtime.stop();
      await rm(workspace, { recursive: true, force: true });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test("Pi uses the native catalog endpoint for a named model without an override", async () => {
  const loaded = await loadConfiguredModel(
    { provider: "openai", model: "gpt-4o-mini" },
    new InMemoryCredentialStore(),
    { default: { provider: "openai", model: "gpt-4o-mini" } },
  );
  try {
    assert.equal(loaded.model.baseUrl, "https://api.openai.com/v1");
  } finally {
    await loaded.cleanup();
  }
});
