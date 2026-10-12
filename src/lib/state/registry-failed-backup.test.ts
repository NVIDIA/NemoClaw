// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SandboxEntry } from "./registry/types";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("restores only the owning session's unchanged published route after backup failure (#13018)", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-rollback-"));
  vi.stubEnv("HOME", home);
  vi.resetModules();
  try {
    const registry = await import("./registry");
    const original: SandboxEntry = {
      name: "alpha",
      provider: "nvidia-prod",
      model: "old-model",
      endpointUrl: null,
      endpointSource: null,
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      preferredInferenceApi: null,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      createdAt: "2026-10-12T00:00:00Z",
    };
    registry.restoreSandboxEntry(original);
    expect(registry.setDefault("alpha")).toBe(true);
    const route = {
      provider: "nvidia-prod",
      model: "new-model",
      endpointUrl: null,
      endpointSource: null,
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      preferredInferenceApi: null,
      gatewayName: "nemoclaw",
      reservationSessionId: "session-owner",
    };
    expect(registry.reserveSandboxInferenceRoute("alpha", route)).toBe(true);
    const expected = registry.getSandbox("alpha")!;
    expect(expected.preRecreatePublishedEntry).toEqual(original);
    expect(registry.restorePublishedSandboxAfterFailedBackup(expected, "other-session")).toBe(
      false,
    );
    expect(registry.restorePublishedSandboxAfterFailedBackup(expected, "session-owner")).toBe(true);
    expect(registry.getSandbox("alpha")).toEqual(original);
    expect(registry.getDefault()).toBe("alpha");
    expect(registry.restorePublishedSandboxAfterFailedBackup(expected, "session-owner")).toBe(
      false,
    );

    expect(registry.reserveSandboxInferenceRoute("alpha", route)).toBe(true);
    const stale = registry.getSandbox("alpha")!;
    registry.updateSandbox("alpha", { model: "raced-model" });
    expect(registry.restorePublishedSandboxAfterFailedBackup(stale, "session-owner")).toBe(false);
    expect(registry.getSandbox("alpha")?.model).toBe("raced-model");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
