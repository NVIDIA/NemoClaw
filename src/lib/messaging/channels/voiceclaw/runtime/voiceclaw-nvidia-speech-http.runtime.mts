// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: MIT

import { assertOkOrThrowHttpError, postMultipartRequest } from "openclaw/plugin-sdk/provider-http";
import { normalizeNvidiaBaseUrl } from "./voiceclaw-nvidia-speech-config.js";

type MagpieSynthesizeParams = {
  text: string;
  apiKey: string;
  baseUrl: string;
  voice: string;
  language: string;
  sampleRateHz: number;
  customDictionary?: string;
  customConfiguration?: string;
  timeoutMs: number;
};

export async function magpieSynthesize(params: MagpieSynthesizeParams): Promise<Buffer> {
  const form = new FormData();
  form.append("text", params.text);
  form.append("language", params.language);
  form.append("voice", params.voice);
  form.append("encoding", "LINEAR_PCM");
  form.append("sample_rate_hz", String(params.sampleRateHz));
  if (params.customDictionary) {
    form.append("custom_dictionary", params.customDictionary);
  }
  if (params.customConfiguration) {
    form.append("custom_configuration", params.customConfiguration);
  }

  const { response, release } = await postMultipartRequest({
    url: `${normalizeNvidiaBaseUrl(params.baseUrl)}/v1/audio/synthesize`,
    headers: new Headers({ Authorization: `Bearer ${params.apiKey}` }),
    body: form,
    timeoutMs: params.timeoutMs,
    fetchFn: fetch,
    auditContext: "NVIDIA Magpie TTS",
  });
  try {
    await assertOkOrThrowHttpError(response, "NVIDIA Magpie TTS failed");
    return Buffer.from(await response.arrayBuffer());
  } finally {
    await release();
  }
}
