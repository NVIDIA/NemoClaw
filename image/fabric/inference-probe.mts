// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type Model = {
  api: "anthropic-messages" | "openai-responses" | "openai-completions";
  connection: { model: string; base_url: string; api_key_env: string };
};
type Configuration = Model & {
  agents?: { inference?: { models: Record<string, Model> } }[];
};

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
    const identity = JSON.stringify([api, model, base_url, api_key_env]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const key = process.env[api_key_env];
    if (!key) throw new Error("Missing inference credential");
    if (!["anthropic-messages", "openai-responses", "openai-completions"].includes(api)) {
      throw new Error("Unsupported inference API");
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
    });
    if (!response.ok) throw new Error("Inference request failed");
    const result = await response.json();
    const items = anthropic ? result.content : responses ? result.output : result.choices;
    if (!Array.isArray(items) || items.length === 0) throw new Error("Empty inference result");
  }
} catch {
  // Never print upstream response bodies, request headers, or credential values.
  process.exitCode = 1;
}
