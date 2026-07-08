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

// The fake server binds to loopback (127.0.0.1). Loopback is an allowed
// host-side probe target (a locally-run vLLM/Ollama endpoint), so these
// happy-path cases could use its URL directly; they present a routable public
// hostname to the guard and inject a fetcher to the loopback server to keep the
// remote-endpoint path exercised. Loopback probing against the real server is
// asserted by its own case below; non-loopback private-IP rejection is covered
// by the unit tests in src/lib/inference/compatible-endpoint-context.test.ts.
const PUBLIC_ENDPOINT_URL = "https://vllm.public.test/v1";

// The DNS SSRF preflight now runs unconditionally, so inject a clearly-public
// resolver for the public hostname while the injected fetcher targets the
// loopback fake server (#6293).
const RESOLVE_PUBLIC = async () => [{ address: "93.184.216.34", family: 4 }];

let server: FakeOpenAiCompatibleServer | null = null;

function fetchFromServer(apiKey: string): () => unknown | null {
  return () =>
    fetchCompatibleEndpointModels((server as FakeOpenAiCompatibleServer).baseUrl, apiKey);
}

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("compatible-endpoint context probe against a real server (#6177)", {
  timeout: testTimeout(60_000),
}, () => {
  it("reads max_model_len from a live /v1/models endpoint into NEMOCLAW_CONTEXT_WINDOW (#6177)", async () => {
    server = await startFakeOpenAiCompatibleServer({ model: MODEL, maxModelLen: 65_536 });

    const models = fetchCompatibleEndpointModels(server.baseUrl, "");
    expect(models).toMatchObject({ data: [{ id: MODEL, max_model_len: 65_536 }] });

    const env: NodeJS.ProcessEnv = {};
    await applyCompatibleEndpointContextWindow(PUBLIC_ENDPOINT_URL, MODEL, {
      env,
      fetchModels: fetchFromServer(""),
      resolveHost: RESOLVE_PUBLIC,
    });
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("65536");
  });

  it("sends the endpoint credential through curl's --config auth flow (#6177)", async () => {
    server = await startFakeOpenAiCompatibleServer({
      model: MODEL,
      maxModelLen: 32_768,
      apiKey: "secret-key",
    });

    const env: NodeJS.ProcessEnv = {};
    await applyCompatibleEndpointContextWindow(PUBLIC_ENDPOINT_URL, MODEL, {
      env,
      apiKey: "secret-key",
      fetchModels: fetchFromServer("secret-key"),
      resolveHost: RESOLVE_PUBLIC,
    });

    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("32768");
    // The real curl probe transmitted an Authorization header built from the
    // credential (via the temp --config file), proving the auth path works.
    expect(
      server.requests().some((entry) => entry.path === "/v1/models" && entry.authorizationSent),
    ).toBe(true);
  });

  it("enforces auth on /v1/models: sets the window with the key, skips it without (#6177)", async () => {
    server = await startFakeOpenAiCompatibleServer({
      model: MODEL,
      maxModelLen: 65_536,
      apiKey: "secret-key",
      requireAuthModels: true,
    });

    // Wrong/absent credential → the endpoint 401s → no window is set.
    const noKeyEnv: NodeJS.ProcessEnv = {};
    await applyCompatibleEndpointContextWindow(PUBLIC_ENDPOINT_URL, MODEL, {
      env: noKeyEnv,
      apiKey: "",
      fetchModels: fetchFromServer(""),
      resolveHost: RESOLVE_PUBLIC,
    });
    expect(noKeyEnv.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();
    // Assert the endpoint actually rejected the unauthenticated /v1/models
    // request — an unset window alone could also come from a network failure.
    expect(
      server.requests().some((entry) => entry.path === "/v1/models" && entry.auth === "missing"),
    ).toBe(true);

    // Correct credential → authorized → the window is read.
    const keyedEnv: NodeJS.ProcessEnv = {};
    await applyCompatibleEndpointContextWindow(PUBLIC_ENDPOINT_URL, MODEL, {
      env: keyedEnv,
      apiKey: "secret-key",
      fetchModels: fetchFromServer("secret-key"),
      resolveHost: RESOLVE_PUBLIC,
    });
    expect(keyedEnv.NEMOCLAW_CONTEXT_WINDOW).toBe("65536");
    expect(
      server.requests().some((entry) => entry.path === "/v1/models" && entry.auth === "ok"),
    ).toBe(true);
  });

  it("probes a real loopback endpoint and propagates its max_model_len (#6293)", async () => {
    // The fake server binds to 127.0.0.1 — a loopback address. A locally-run
    // vLLM/Ollama custom endpoint is legitimately reached host-side on loopback,
    // so the source-boundary guard exempts loopback (mirroring the chat probe)
    // and the real curl fetcher must run and propagate the window. Non-loopback
    // private targets stay blocked — see the unit-test rejection cases.
    server = await startFakeOpenAiCompatibleServer({ model: MODEL, maxModelLen: 65_536 });
    expect(new URL(server.baseUrl).hostname).toBe("127.0.0.1");
    const modelsRequestsBefore = server
      .requests()
      .filter((entry) => entry.path === "/v1/models").length;

    const env: NodeJS.ProcessEnv = {};
    await applyCompatibleEndpointContextWindow(server.baseUrl, MODEL, {
      env,
      fetchModels: fetchCompatibleEndpointModels,
    });

    const modelsRequestsAfter = server
      .requests()
      .filter((entry) => entry.path === "/v1/models").length;
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("65536");
    expect(modelsRequestsAfter).toBeGreaterThan(modelsRequestsBefore);
  });

  it("keeps the default context window when the endpoint omits max_model_len (#6177)", async () => {
    server = await startFakeOpenAiCompatibleServer({ model: MODEL });

    const env: NodeJS.ProcessEnv = {};
    await applyCompatibleEndpointContextWindow(PUBLIC_ENDPOINT_URL, MODEL, {
      env,
      fetchModels: fetchFromServer(""),
      resolveHost: RESOLVE_PUBLIC,
    });
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();
  });
});
