// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { getStatusReport, showStatusCommand } from "./index";

describe("global status configured inference routes", () => {
  it("keeps JSON sandbox routes recorded while reporting the live gateway separately (#11412)", async () => {
    const report = await getStatusReport({
      listSandboxes: () => ({
        sandboxes: [
          { name: "alpha", provider: "provider-a", model: "model-a" },
          { name: "beta", provider: "provider-b", model: "model-b" },
        ],
        defaultSandbox: "beta",
      }),
      getLiveInference: () => ({ provider: "provider-a", model: "model-a" }),
      showServiceStatus: vi.fn(),
    });

    expect(report.liveInference).toEqual({ provider: "provider-a", model: "model-a" });
    expect(report.sandboxes).toMatchObject([
      { name: "alpha", provider: "provider-a", model: "model-a", isDefault: false },
      { name: "beta", provider: "provider-b", model: "model-b", isDefault: true },
    ]);
  });

  it("keeps the recorded route in text when the live gateway differs (#11412)", async () => {
    const lines: string[] = [];
    await showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [{ name: "alpha", model: "stored-model", provider: "stored-provider" }],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => ({ provider: "live-provider", model: "live-model" }),
      showServiceStatus: vi.fn(),
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain("    alpha * (live-model)");
    expect(lines).toContain("      (onboarded: stored-model)");
    expect(lines).toContain("      Inference (configured): stored-provider / stored-model");
    expect(lines).not.toContain("      Inference (configured): live-provider / live-model");
  });
});
