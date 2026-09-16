// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../state/registry";
import { fingerprintSandboxRegistryEntry } from "./sandbox-recreate-transaction";

describe("N1x recreate source registry fingerprint", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("survives managed vLLM route reservation during rebuild (#11886)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-recreate-journal-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("../state/registry");
      registry.registerSandbox({
        name: "alpha",
        agent: "openclaw",
        createdAt: "2026-07-27T20:00:00.000Z",
        provider: "vllm-local",
        model: "nvidia/Qwen3.6-35B-A3B-NVFP4",
        endpointUrl: null,
        endpointSource: null,
        credentialEnv: null,
        preferredInferenceApi: "openai-completions",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        openshellDriver: "docker",
        deferredN1xManagedVllmAccepted: true,
      });
      const journaled = fingerprintSandboxRegistryEntry(
        registry.getSandbox("alpha") as SandboxEntry,
      );

      expect(
        registry.reserveSandboxInferenceRoute("alpha", {
          provider: "vllm-local",
          model: "nvidia/Qwen3.6-35B-A3B-NVFP4",
          endpointUrl: null,
          endpointSource: null,
          credentialEnv: null,
          preferredInferenceApi: "openai-completions",
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          openshellDriver: "docker",
          reservationSessionId: "session-n1x-rebuild",
        }),
      ).toBe(true);
      const reserved = registry.getSandbox("alpha") as SandboxEntry;

      expect(reserved.deferredN1xManagedVllmAccepted).toBeUndefined();
      expect(fingerprintSandboxRegistryEntry(reserved)).toBe(journaled);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
