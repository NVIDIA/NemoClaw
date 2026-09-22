// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { loadConfiguredModel } from "./pi-model.js";

let cleanup: (() => Promise<void>) | undefined;
try {
  const overrides = JSON.parse(process.argv[2] ?? "null");
  const connection = JSON.parse(process.env.NEMOCLAW_INFERENCE_CONFIG ?? "null").connection;
  const credential = process.env[connection.api_key_env];
  if (!credential) throw new Error("Attached inference credential is unavailable");
  const loaded = await loadConfiguredModel(
    {
      provider: connection.provider,
      model: overrides.model,
      base_url: connection.base_url,
      ...(overrides.piModel ? { settings: { model_metadata: overrides.piModel } } : {}),
    },
    new InMemoryCredentialStore(),
  );
  cleanup = loaded.cleanup;
  const { modelRuntime, model } = loaded;
  await modelRuntime.setRuntimeApiKey(connection.provider, credential);
  const result = await modelRuntime.completeSimple(
    model,
    {
      messages: [{ role: "user", content: "Reply OK.", timestamp: Date.now() }],
    },
    { maxTokens: Math.min(16, model.maxTokens), signal: AbortSignal.timeout(80000) },
  );
  process.exitCode =
    result.stopReason !== "error" && result.stopReason !== "aborted" && result.content.length > 0
      ? 0
      : 1;
} catch {
  process.exitCode = 1;
} finally {
  await cleanup?.();
}
