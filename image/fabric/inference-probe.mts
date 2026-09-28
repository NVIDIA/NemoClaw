// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type Model = {
  api: "anthropic-messages" | "openai-responses" | "openai-completions";
  connection: { model: string; base_url: string; api_key_env: string };
};
type Configuration = Model & {
  agents?: { inference?: { models: Record<string, Model> } }[];
};

// Only these fixed exit codes cross the diagnostic boundary. Keep their SDK
// messages in openshell/probes.rs aligned; never forward an exception or body.
class ProbeFailure extends Error {
  exitCode: number;
  constructor(exitCode: number) {
    super("Inference readiness failed");
    this.exitCode = exitCode;
  }
}

function transportFailure(error: unknown): ProbeFailure {
  const failure = error as { name?: string; cause?: { code?: string } } | null;
  const code = failure?.cause?.code;
  if (
    failure?.name === "TimeoutError" || failure?.name === "AbortError" ||
    ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]
      .includes(code ?? "")
  ) return new ProbeFailure(24);
  if ([
    "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "CERT_REVOKED", "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID",
  ].includes(code ?? "")) return new ProbeFailure(25);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new ProbeFailure(26);
  if (code === "ECONNREFUSED") return new ProbeFailure(27);
  return new ProbeFailure(23);
}

try {
  // The SDK validates this wire format before installing the sandbox environment.
  const config: Configuration = JSON.parse(process.env.NEMOCLAW_INFERENCE_CONFIG!);
  const choices = [
    config,
    ...(config.agents ?? []).flatMap((agent) => Object.values(agent.inference?.models ?? {})),
  ];
  const seen = new Set<string>();
  const signal = AbortSignal.timeout(80000);
  for (const { api, connection } of choices) {
    const { model, base_url, api_key_env } = connection;
    if ([model, base_url, api_key_env].some((value) => typeof value !== "string" || !value)) {
      throw new ProbeFailure(20);
    }
    const identity = JSON.stringify([api, model, base_url, api_key_env]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const key = process.env[api_key_env];
    if (!key) throw new ProbeFailure(21);
    if (!["anthropic-messages", "openai-responses", "openai-completions"].includes(api)) {
      throw new ProbeFailure(22);
    }
    const anthropic = api === "anthropic-messages";
    const responses = api === "openai-responses";
    const path = anthropic ? "messages" : responses ? "responses" : "chat/completions";
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (anthropic) {
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers.authorization = `Bearer ${key}`;
    }
    const body = {
      model,
      stream: false,
      ...(responses
        ? { input: "Reply OK.", max_output_tokens: 16 }
        : { messages: [{ role: "user", content: "Reply OK." }], max_tokens: 16 }),
    };
    const response = await fetch(`${base_url.replace(/\/$/, "")}/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    }).catch((error: unknown) => { throw transportFailure(error); });
    if (!response.ok) {
      const statuses: Record<number, number> = {
        400: 40, 401: 41, 403: 43, 404: 44, 408: 48, 429: 49,
        500: 50, 502: 52, 503: 53, 504: 54,
      };
      throw new ProbeFailure(statuses[response.status] ?? 55);
    }
    const result = await response.json().catch((error: unknown) => {
      if (error instanceof SyntaxError) throw new ProbeFailure(28);
      throw transportFailure(error);
    });
    const items = anthropic ? result?.content : responses ? result?.output : result?.choices;
    if (!Array.isArray(items) || items.length === 0) throw new ProbeFailure(29);
  }
} catch (error) {
  // Never print upstream response bodies, request headers, or credential values.
  process.exitCode = error instanceof ProbeFailure ? error.exitCode : 20;
}
