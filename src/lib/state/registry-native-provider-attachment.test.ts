// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

it("clears a stale native NVIDIA attachment when reserving a shared route", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-native-attachment-"));
  vi.stubEnv("HOME", home);
  vi.resetModules();
  try {
    const registry = await import("./registry");
    registry.registerSandbox({
      name: "alpha",
      provider: "nvidia-prod",
      model: "model-a",
      nativeNvidiaProviderAttachment: {
        schemaVersion: 1,
        profileId: "nemoclaw-nvidia-inference-v1",
        providerName: "nemoclaw-nvidia-prod-v1",
        providerId: "provider-id",
      },
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
    });
    expect(registry.getSandbox("alpha")?.nativeNvidiaProviderAuthority).toMatchObject({
      providerId: "provider-id",
    });

    registry.reserveSandboxInferenceRoute("alpha", {
      provider: "anthropic-prod",
      model: "model-b",
      endpointUrl: null,
      credentialEnv: "ANTHROPIC_API_KEY",
      preferredInferenceApi: "anthropic-messages",
      gatewayName: "nemoclaw-9090",
    });

    expect(registry.getSandbox("alpha")?.nativeNvidiaProviderAttachment).toBeUndefined();
    expect(registry.getSandbox("alpha")?.nativeNvidiaProviderAuthority).toBeUndefined();
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});
