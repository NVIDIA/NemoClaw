// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveMaxTokensField } from "./max-tokens-field";

export function isDeepSeekV4ProModel(model: unknown): boolean {
  return String(model || "").toLowerCase() === "deepseek-ai/deepseek-v4-pro";
}

export function isKimiK26Model(model: unknown): boolean {
  return String(model || "").toLowerCase() === "moonshotai/kimi-k2.6";
}

export function getChatCompletionsProbePayload(model: string): Record<string, unknown> {
  const maxTokensField = resolveMaxTokensField(model);
  const payload = {
    model,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    [maxTokensField]: 8,
  };

  if (isDeepSeekV4ProModel(model)) {
    return {
      ...payload,
      temperature: 1,
      top_p: 0.95,
      [maxTokensField]: 8192,
      chat_template_kwargs: { thinking: false },
      stream: true,
    };
  }

  if (isKimiK26Model(model)) {
    return {
      ...payload,
      [maxTokensField]: 8,
      chat_template_kwargs: { thinking: false },
    };
  }

  return payload;
}
