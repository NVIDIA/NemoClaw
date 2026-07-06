// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Real-server proof for the compatible-endpoint context probe (#6177): a local
// OpenAI-compatible server (spawned as a subprocess so the synchronous curl
// probe cannot deadlock the event loop) advertises a runtime max_model_len on
// /v1/models, and the actual curl-backed probe reads it into
// NEMOCLAW_CONTEXT_WINDOW — the value onboarding bakes into the Hermes config.

import { afterEach, describe, expect, it } from "vitest";

import {
  applyCompatibleEndpointContextWindow,
  fetchCompatibleEndpointModels,
} from "../src/lib/inference/compatible-endpoint-context";
import {
  type FakeOpenAiCompatibleServer,
  startFakeOpenAiCompatibleServer,
} from "./e2e/fixtures/fake-openai-compatible";
import { testTimeout } from "./helpers/timeouts";

const MODEL = "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4";

let server: FakeOpenAiCompatibleServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("compatible-endpoint context probe against a real server (#6177)", {
  timeout: testTimeout(60_000),
}, () => {
  it("reads max_model_len from a live /v1/models endpoint into NEMOCLAW_CONTEXT_WINDOW", async () => {
    server = await startFakeOpenAiCompatibleServer({ model: MODEL, maxModelLen: 65_536 });

    const models = fetchCompatibleEndpointModels(server.baseUrl, "");
    expect(models).toMatchObject({ data: [{ id: MODEL, max_model_len: 65_536 }] });

    const env: NodeJS.ProcessEnv = {};
    applyCompatibleEndpointContextWindow(server.baseUrl, MODEL, {
      env,
      fetchModels: fetchCompatibleEndpointModels,
    });
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("65536");
  });

  it("keeps the default context window when the endpoint omits max_model_len", async () => {
    server = await startFakeOpenAiCompatibleServer({ model: MODEL });

    const env: NodeJS.ProcessEnv = {};
    applyCompatibleEndpointContextWindow(server.baseUrl, MODEL, {
      env,
      fetchModels: fetchCompatibleEndpointModels,
    });
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();
  });
});
