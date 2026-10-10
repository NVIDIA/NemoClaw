// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { serializedHostLocalInferenceReceipt } from "../../../test/helpers/host-local-inference-receipt";
import { createSandboxHostLocalInferenceProvenance } from "./registry/host-local-inference";

describe("sandbox registry host-local authority guard", () => {
  it("applies non-authority fields while rejecting drifted host-local authority (#12864)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-host-local-guard-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      const receipt = serializedHostLocalInferenceReceipt("docker");
      const provenance = createSandboxHostLocalInferenceProvenance("alpha", receipt);
      registry.restoreSandboxEntry({
        name: "alpha",
        provider: "llama-cpp-local",
        model: "llama-cpp-model",
        hostLocalInferenceReceipt: receipt,
        hostLocalInferenceProvenance: provenance,
      });

      expect(
        registry.updateSandbox("alpha", { dashboardPort: 19876, model: "drifted-model" }),
      ).toBe(true);
      expect(registry.getSandbox("alpha")).toMatchObject({
        model: "llama-cpp-model",
        dashboardPort: 19876,
        hostLocalInferenceReceipt: receipt,
        hostLocalInferenceProvenance: provenance,
      });

      expect(registry.updateSandbox("alpha", { model: "drifted-model" })).toBe(false);
      expect(registry.getSandbox("alpha")?.model).toBe("llama-cpp-model");

      vi.resetModules();
      const reloadedRegistry = await import("./registry");
      expect(reloadedRegistry.getSandbox("alpha")).toMatchObject({
        model: "llama-cpp-model",
        dashboardPort: 19876,
        hostLocalInferenceProvenance: provenance,
      });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
