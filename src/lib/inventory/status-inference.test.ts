// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { getStatusReport, showStatusCommand } from "./index";

describe("global status inference", () => {
  it("prints sandbox models and delegates service status", async () => {
    const lines: string[] = [];
    const showServiceStatus = vi.fn();
    await showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [
          { name: "alpha", model: "nvidia/nemotron-3-super-120b-a12b" },
          { name: "beta", model: "z-ai/glm-5.1" },
        ],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => ({ provider: "nvidia-prod", model: "provider/runtime-model" }),
      showServiceStatus,
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain("  Global status (registered sandboxes and host services):");
    expect(lines).toContain("  Sandboxes:");
    expect(lines).toContain("    alpha * (provider/runtime-model)");
    expect(lines).toContain("      (onboarded: nvidia/nemotron-3-super-120b-a12b)");
    expect(lines).toContain("    beta (z-ai/glm-5.1)");
    expect(showServiceStatus).toHaveBeenCalledWith({ sandboxName: "alpha" });
  });

  it("does not annotate status when the live route matches the recorded model", async () => {
    const lines: string[] = [];
    await showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [{ name: "alpha", model: "nvidia/nemotron-3-super-120b-a12b" }],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => ({
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
      }),
      showServiceStatus: vi.fn(),
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain("    alpha * (nvidia/nemotron-3-super-120b-a12b)");
    expect(lines.some((line) => line.includes("onboarded"))).toBe(false);
  });

  it("falls back to the recorded model when the gateway is unreachable", async () => {
    const lines: string[] = [];
    await showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [{ name: "alpha", model: "nvidia/nemotron-3-super-120b-a12b" }],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => null,
      showServiceStatus: vi.fn(),
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain("    alpha * (nvidia/nemotron-3-super-120b-a12b)");
    expect(lines.some((line) => line.includes("onboarded"))).toBe(false);
  });

  it("annotates live-route drift as unknown when the recorded model is missing", async () => {
    const lines: string[] = [];
    await showStatusCommand({
      listSandboxes: () => ({ sandboxes: [{ name: "alpha" }], defaultSandbox: "alpha" }),
      getLiveInference: () => ({ provider: "nvidia-prod", model: "provider/runtime-model" }),
      showServiceStatus: vi.fn(),
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain("    alpha * (provider/runtime-model)");
    expect(lines).toContain("      (onboarded: unknown)");
    expect(lines).toContain("      Inference (configured): unknown / unknown");
  });

  it("prints the configured provider and model for every sandbox (#2604)", async () => {
    const lines: string[] = [];
    await showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [
          {
            name: "alpha",
            model: "nvidia/nemotron-3-super-120b-a12b",
            provider: "nvidia-prod",
          },
          { name: "beta", model: "qwen3.5:9b", provider: "ollama-local" },
        ],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => null,
      showServiceStatus: vi.fn(),
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain(
      "      Inference (configured): nvidia-prod / nvidia/nemotron-3-super-120b-a12b",
    );
    expect(lines).toContain("      Inference (configured): ollama-local / qwen3.5:9b");
  });

  it("keeps each configured line on its recorded route when the live route differs (#11412)", async () => {
    const lines: string[] = [];
    await showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [
          { name: "route-a", model: "llama3.2:1b", provider: "ollama-route-a" },
          { name: "route-b", model: "qwen2.5:0.5b", provider: "ollama-route-b" },
        ],
        defaultSandbox: "route-b",
      }),
      getLiveInference: () => ({ provider: "ollama-route-a", model: "llama3.2:1b" }),
      showServiceStatus: vi.fn(),
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain("    route-b * (llama3.2:1b)");
    expect(lines).toContain("      (onboarded: qwen2.5:0.5b)");
    expect(lines).toContain("      Inference (configured): ollama-route-a / llama3.2:1b");
    expect(lines).toContain("      Inference (configured): ollama-route-b / qwen2.5:0.5b");
    expect(lines).toContain("      Inference (live): ollama-route-a / llama3.2:1b");
  });

  it("shows provider-only live-route drift when the model matches (#11412)", async () => {
    const lines: string[] = [];
    await showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [{ name: "route-b", model: "shared-model", provider: "provider-b" }],
        defaultSandbox: "route-b",
      }),
      getLiveInference: () => ({ provider: "provider-a", model: "shared-model" }),
      showServiceStatus: vi.fn(),
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain("      Inference (configured): provider-b / shared-model");
    expect(lines).toContain("      Inference (live): provider-a / shared-model");
    expect(lines).not.toContain("      (onboarded: shared-model)");
  });

  it("reports recorded routes without changing version-1 row fields (#11412)", async () => {
    const sandboxes = [
      { name: "route-a", model: "llama3.2:1b", provider: "ollama-route-a" },
      { name: "route-b", model: "qwen2.5:0.5b", provider: "ollama-route-b" },
    ];
    const report = await getStatusReport({
      listSandboxes: () => ({ sandboxes, defaultSandbox: "route-b" }),
      getLiveInference: () => ({ provider: "ollama-route-a", model: "llama3.2:1b" }),
      showServiceStatus: vi.fn(),
    });

    expect(report.schemaVersion).toBe(1);
    expect(report.sandboxes).toMatchObject([
      {
        name: "route-a",
        model: "llama3.2:1b",
        provider: "ollama-route-a",
        configuredInference: { model: "llama3.2:1b", provider: "ollama-route-a" },
      },
      {
        name: "route-b",
        model: "llama3.2:1b",
        provider: "ollama-route-a",
        configuredInference: { model: "qwen2.5:0.5b", provider: "ollama-route-b" },
      },
    ]);
  });
});
