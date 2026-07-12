// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";

import type { ArtifactSink } from "./artifacts.ts";
import { buildAvailabilityProbeEnv } from "./availability-env.ts";
import { type ProviderClient, trustedProviderEndpoint } from "./clients/provider.ts";
import {
  type FakeOpenAiCompatibleServer,
  startFakeOpenAiCompatibleServer,
} from "./fake-openai-compatible.ts";
import {
  DEFAULT_HOSTED_INFERENCE_MODEL,
  HOSTED_INFERENCE_CREDENTIAL_ENV,
  HOSTED_INFERENCE_PROVIDER,
  HOSTED_INFERENCE_PROVIDER_NAME,
  HOSTED_INFERENCE_SECRET,
  type HostedInferenceSecrets,
  requireHostedInferenceConfig,
} from "./hosted-inference.ts";

/**
 * Gives E2E suites one inference contract across three execution modes.
 * `mock` exposes an authenticated local compatible endpoint and stages only
 * `COMPATIBLE_API_KEY`; `internal-nvidia` stages the internal NVIDIA endpoint
 * as compatible inference and rejects endpoint overrides outside its static
 * allowlist; `public-nvidia` uses the public NVIDIA provider and stages only
 * `NVIDIA_INFERENCE_API_KEY`. Every mode registers its credential for artifact
 * redaction and removes credentials owned by the other modes.
 *
 * Tests normally consume the `inference` fixture from `e2e-test.ts`, pass
 * `inference.env()` to install/onboard commands, use its model and provider
 * fields in assertions, and rely on fixture cleanup. When migrating
 * `launchable-smoke`, `issue-4434-tui-unreachable-inference`,
 * `model-router-provider-routed-inference`, or `agent-turn-latency`, replace
 * bespoke inference env/probes with that lifecycle, preserve the suite-specific
 * sandbox assertions, scope `inference_mode` to the consuming workflow job,
 * and add the suite's fast-test mapping to `test/e2e/mock-parity.json`.
 */
export type E2EInferenceMode = "mock" | "internal-nvidia" | "public-nvidia";

export interface E2EInferenceAdapter {
  readonly mode: E2EInferenceMode;
  readonly model: string;
  readonly provider: string;
  readonly providerName: string;
  readonly endpointUrl: string;
  readonly expectedRouteProvider: string;
  readonly contractLabel: string;
  env(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  redactionValues(): string[];
  probeModels(artifactName: string): Promise<unknown>;
  directChat(
    prompt: string,
    options?: { artifactName?: string; maxTokens?: number },
  ): Promise<unknown>;
  close(): Promise<void>;
}

export interface E2EInferenceAdapterOptions {
  readonly artifacts: ArtifactSink;
  readonly env?: NodeJS.ProcessEnv;
  readonly provider: Pick<ProviderClient, "requestJson">;
  readonly secrets: HostedInferenceSecrets;
}

const DEFAULT_MOCK_MODEL = "nvidia/nvidia/nemotron-3-ultra";
const DEFAULT_PUBLIC_NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const DEFAULT_PUBLIC_NVIDIA_MODEL = "nvidia/nemotron-3-super-120b-a12b";
const DIRECT_CHAT_TIMEOUT_MS = 120_000;
const INTERNAL_NVIDIA_ALLOWED_HOSTS = ["inference-api.nvidia.com"] as const;
const MODEL_PROBE_TIMEOUT_MS = 30_000;
const PUBLIC_NVIDIA_ALLOWED_HOSTS = ["integrate.api.nvidia.com"] as const;
const SANDBOX_HOST_ALIAS = "host.openshell.internal";

function normalizeMode(env: NodeJS.ProcessEnv): E2EInferenceMode {
  const raw = env.NEMOCLAW_E2E_INFERENCE_MODE?.trim().toLowerCase();
  if (!raw) return "mock";
  if (raw === "mock" || raw === "internal-nvidia" || raw === "public-nvidia") return raw;
  throw new Error(
    `NEMOCLAW_E2E_INFERENCE_MODE must be one of: mock, internal-nvidia, public-nvidia; got ${env.NEMOCLAW_E2E_INFERENCE_MODE}`,
  );
}

export function requirePublicNvidiaInferenceKey(value: string): string {
  if (!value.startsWith("nvapi-")) {
    throw new Error(`${HOSTED_INFERENCE_SECRET} must start with nvapi- for public NVIDIA mode`);
  }
  return value;
}

function joinEndpoint(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}

function endpointForHost(endpointUrl: string): string {
  const url = new URL(endpointUrl);
  url.hostname = "127.0.0.1";
  return url.toString().replace(/\/$/, "");
}

function chatPayload(model: string, prompt: string, maxTokens = 256): string {
  return JSON.stringify({
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens,
  });
}

async function responseJsonOrThrow(response: Response, label: string): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status} ${response.statusText}`.trim());
  }
  return (await response.json()) as unknown;
}

class OpenAiCompatibleInferenceAdapter implements E2EInferenceAdapter {
  readonly provider = HOSTED_INFERENCE_PROVIDER;
  readonly providerName = HOSTED_INFERENCE_PROVIDER_NAME;
  readonly expectedRouteProvider = HOSTED_INFERENCE_PROVIDER_NAME;
  readonly contractLabel: string;

  constructor(
    readonly mode: "mock" | "internal-nvidia",
    readonly model: string,
    readonly endpointUrl: string,
    private readonly requestEndpointUrl: string,
    private readonly apiKey: string,
    private readonly preferredApi: string,
    private readonly providerClient: Pick<ProviderClient, "requestJson"> | undefined,
    private readonly artifacts: ArtifactSink,
    private readonly fake: FakeOpenAiCompatibleServer | undefined,
  ) {
    this.artifacts.addRedactionValues([apiKey]);
    this.contractLabel =
      mode === "mock"
        ? "fake OpenAI-compatible endpoint is staged as the compatible endpoint credential"
        : "NVIDIA_INFERENCE_API_KEY is staged as the compatible endpoint credential";
  }

  env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const sanitizedExtra = { ...extra };
    delete sanitizedExtra[HOSTED_INFERENCE_SECRET];
    delete sanitizedExtra.NEMOCLAW_E2E_USE_HOSTED_INFERENCE;
    return {
      ...sanitizedExtra,
      NEMOCLAW_E2E_INFERENCE_MODE: this.mode,
      ...(this.mode === "internal-nvidia" ? { NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1" } : {}),
      NEMOCLAW_PROVIDER: this.provider,
      NEMOCLAW_ENDPOINT_URL: this.endpointUrl,
      NEMOCLAW_MODEL: this.model,
      NEMOCLAW_COMPAT_MODEL: this.model,
      NEMOCLAW_PREFERRED_API: this.preferredApi,
      [HOSTED_INFERENCE_CREDENTIAL_ENV]: this.apiKey,
    };
  }

  redactionValues(): string[] {
    return [this.apiKey];
  }

  async probeModels(artifactName: string): Promise<unknown> {
    if (this.providerClient) {
      const response = await this.providerClient.requestJson(
        trustedProviderEndpoint(joinEndpoint(this.requestEndpointUrl, "models"), {
          allowedHosts: INTERNAL_NVIDIA_ALLOWED_HOSTS,
        }),
        {
          artifactName,
          curlMaxTimeSeconds: 15,
          headers: [`Authorization: Bearer ${this.apiKey}`],
          env: buildAvailabilityProbeEnv(),
          redactionValues: this.redactionValues(),
          timeoutMs: MODEL_PROBE_TIMEOUT_MS,
        },
      );
      return response.json;
    }
    const response = await fetch(joinEndpoint(this.requestEndpointUrl, "models"), {
      signal: AbortSignal.timeout(MODEL_PROBE_TIMEOUT_MS),
    });
    const json = await responseJsonOrThrow(response, "model probe");
    await this.artifacts.writeJson(`${artifactName}.json`, json);
    return json;
  }

  async directChat(
    prompt: string,
    options: { artifactName?: string; maxTokens?: number } = {},
  ): Promise<unknown> {
    const body = chatPayload(this.model, prompt, options.maxTokens);
    if (this.providerClient) {
      const response = await this.providerClient.requestJson(
        trustedProviderEndpoint(joinEndpoint(this.requestEndpointUrl, "chat/completions"), {
          allowedHosts: INTERNAL_NVIDIA_ALLOWED_HOSTS,
        }),
        {
          artifactName: options.artifactName ?? "direct-compatible-chat",
          body,
          curlMaxTimeSeconds: 90,
          headers: ["Content-Type: application/json", `Authorization: Bearer ${this.apiKey}`],
          env: buildAvailabilityProbeEnv(),
          redactionValues: this.redactionValues(),
          timeoutMs: DIRECT_CHAT_TIMEOUT_MS,
        },
      );
      return response.json;
    }
    const response = await fetch(joinEndpoint(this.requestEndpointUrl, "chat/completions"), {
      body,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(DIRECT_CHAT_TIMEOUT_MS),
    });
    const json = await responseJsonOrThrow(response, "direct chat");
    await this.artifacts.writeJson(
      `${options.artifactName ?? "direct-compatible-chat"}.json`,
      json,
    );
    return json;
  }

  async close(): Promise<void> {
    if (!this.fake) return;
    try {
      await this.artifacts.writeJson("e2e-inference-adapter-requests.json", this.fake.requests());
    } finally {
      await this.fake.close();
    }
  }
}

class PublicNvidiaInferenceAdapter implements E2EInferenceAdapter {
  readonly mode = "public-nvidia";
  readonly provider = "cloud";
  readonly providerName = "nvidia";
  readonly endpointUrl = DEFAULT_PUBLIC_NVIDIA_BASE_URL;
  readonly expectedRouteProvider = "nvidia-prod";
  readonly contractLabel = "public NVIDIA Endpoints provider keeps nvapi validation centralized";

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly providerClient: Pick<ProviderClient, "requestJson">,
  ) {}

  env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const sanitizedExtra = { ...extra };
    delete sanitizedExtra[HOSTED_INFERENCE_CREDENTIAL_ENV];
    delete sanitizedExtra.NEMOCLAW_E2E_USE_HOSTED_INFERENCE;
    return {
      ...sanitizedExtra,
      NEMOCLAW_E2E_INFERENCE_MODE: this.mode,
      NEMOCLAW_PROVIDER: this.provider,
      NEMOCLAW_MODEL: this.model,
      [HOSTED_INFERENCE_SECRET]: this.apiKey,
    };
  }

  redactionValues(): string[] {
    return [this.apiKey];
  }

  async probeModels(artifactName: string): Promise<unknown> {
    const response = await this.providerClient.requestJson(
      trustedProviderEndpoint(joinEndpoint(this.endpointUrl, "models"), {
        allowedHosts: PUBLIC_NVIDIA_ALLOWED_HOSTS,
      }),
      {
        artifactName,
        curlMaxTimeSeconds: 15,
        headers: [`Authorization: Bearer ${this.apiKey}`],
        env: buildAvailabilityProbeEnv(),
        redactionValues: this.redactionValues(),
        timeoutMs: MODEL_PROBE_TIMEOUT_MS,
      },
    );
    return response.json;
  }

  async directChat(
    prompt: string,
    options: { artifactName?: string; maxTokens?: number } = {},
  ): Promise<unknown> {
    const response = await this.providerClient.requestJson(
      trustedProviderEndpoint(joinEndpoint(this.endpointUrl, "chat/completions"), {
        allowedHosts: PUBLIC_NVIDIA_ALLOWED_HOSTS,
      }),
      {
        artifactName: options.artifactName ?? "direct-nvidia-chat",
        body: chatPayload(this.model, prompt, options.maxTokens),
        curlMaxTimeSeconds: 90,
        headers: ["Content-Type: application/json", `Authorization: Bearer ${this.apiKey}`],
        env: buildAvailabilityProbeEnv(),
        redactionValues: this.redactionValues(),
        timeoutMs: DIRECT_CHAT_TIMEOUT_MS,
      },
    );
    return response.json;
  }

  async close(): Promise<void> {}
}

export async function createE2EInferenceAdapter(
  options: E2EInferenceAdapterOptions,
): Promise<E2EInferenceAdapter> {
  const env = options.env ?? process.env;
  const mode = normalizeMode(env);
  if (mode === "mock") {
    const model = env.NEMOCLAW_MODEL || env.NEMOCLAW_COMPAT_MODEL || DEFAULT_MOCK_MODEL;
    const apiKey = env.COMPATIBLE_API_KEY || `mock-${randomBytes(32).toString("hex")}`;
    const fake = await startFakeOpenAiCompatibleServer({
      apiKey,
      chatContent: "PONG",
      // A Docker network namespace cannot reach host loopback through the host
      // alias, so listen on the bridge-facing interfaces. The workflow uses an
      // ephemeral ubuntu-latest VM, an OS-assigned port, and a per-run credential.
      host: "0.0.0.0",
      model,
      publicHost: SANDBOX_HOST_ALIAS,
      requireAuth: true,
      responseText: "PONG",
    });
    try {
      await options.artifacts.writeJson("e2e-inference-adapter.json", {
        mode,
        model,
        endpointUrl: fake.baseUrl,
        expectedRouteProvider: HOSTED_INFERENCE_PROVIDER_NAME,
        publicHost: SANDBOX_HOST_ALIAS,
      });
      return new OpenAiCompatibleInferenceAdapter(
        mode,
        model,
        fake.baseUrl,
        endpointForHost(fake.baseUrl),
        apiKey,
        "openai-completions",
        undefined,
        options.artifacts,
        fake,
      );
    } catch (error) {
      await fake.close();
      throw error;
    }
  }
  if (mode === "internal-nvidia") {
    const hosted = requireHostedInferenceConfig(options.secrets, env);
    trustedProviderEndpoint(hosted.endpointUrl, { allowedHosts: INTERNAL_NVIDIA_ALLOWED_HOSTS });
    return new OpenAiCompatibleInferenceAdapter(
      mode,
      hosted.model,
      hosted.endpointUrl,
      hosted.endpointUrl,
      hosted.apiKey,
      hosted.env.NEMOCLAW_PREFERRED_API || "openai-completions",
      options.provider,
      options.artifacts,
      undefined,
    );
  }
  const apiKey = requirePublicNvidiaInferenceKey(options.secrets.required(HOSTED_INFERENCE_SECRET));
  const model = env.NEMOCLAW_MODEL || DEFAULT_PUBLIC_NVIDIA_MODEL;
  return new PublicNvidiaInferenceAdapter(model, apiKey, options.provider);
}

export const E2E_INFERENCE_MODE_VALUES: readonly E2EInferenceMode[] = [
  "mock",
  "internal-nvidia",
  "public-nvidia",
];

export { DEFAULT_HOSTED_INFERENCE_MODEL as DEFAULT_INTERNAL_NVIDIA_MODEL };
