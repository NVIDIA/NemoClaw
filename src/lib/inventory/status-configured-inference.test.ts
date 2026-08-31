// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { getStatusReport, showStatusCommand } from "./index";

// #10221: a QA report read the bare view's `Inference:` line as a broken
// rendering of the per-sandbox `Inference: healthy (<endpoint>)` line. Both
// commands printed one field name for two different questions: the bare view
// reports the registry route, the per-sandbox view reports a probe result.
// The bare view now names itself `(configured)` and reports the upstream it is
// routed at, still without probing anything.
describe("bare status configured-inference line (#10221)", () => {
  it("qualifies the label and names the configured endpoint", () => {
    const lines: string[] = [];
    showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [
          {
            name: "alpha",
            model: "nvidia/nemotron-3-super-120b-a12b",
            provider: "nvidia-prod",
            endpointUrl: "https://integrate.api.nvidia.com/v1",
          },
        ],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => null,
      showServiceStatus: vi.fn(),
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain(
      "      Inference (configured): nvidia-prod / nvidia/nemotron-3-super-120b-a12b " +
        "(https://integrate.api.nvidia.com/v1)",
    );
    // This view must never claim health — that word belongs to the probe in
    // `nemoclaw <name> status`.
    expect(lines.some((line) => line.includes("healthy"))).toBe(false);
  });

  it("omits the endpoint when the registry records none", () => {
    const lines: string[] = [];
    showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [{ name: "alpha", model: "qwen3.5:9b", provider: "ollama-local" }],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => null,
      showServiceStatus: vi.fn(),
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain("      Inference (configured): ollama-local / qwen3.5:9b");
  });

  it("omits an endpoint that has no configured provider owner (#10221)", () => {
    const lines: string[] = [];
    showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [
          {
            name: "alpha",
            model: "m",
            provider: "   ",
            endpointUrl: "https://internal.example/v1",
          },
        ],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => null,
      showServiceStatus: vi.fn(),
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain("      Inference (configured): m");
    expect(lines.some((line) => line.includes("internal.example"))).toBe(false);
  });

  it("redacts credentials embedded in the configured endpoint", () => {
    const lines: string[] = [];
    showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [
          {
            name: "alpha",
            model: "m",
            provider: "compatible-endpoint",
            endpointUrl: "https://user:hunter2@inference.example/v1?api_key=sk-abc123",
          },
        ],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => null,
      showServiceStatus: vi.fn(),
      log: (message = "") => lines.push(message),
    });

    const inferenceLine = lines.find((line) => line.includes("Inference (configured):")) ?? "";
    expect(inferenceLine).toContain("https://inference.example/v1");
    expect(inferenceLine).not.toContain("hunter2");
    expect(inferenceLine).not.toContain("sk-abc123");
  });

  it("renders endpoint control characters as inert text (#10221)", () => {
    const lines: string[] = [];
    showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [
          {
            name: "alpha",
            model: "m",
            provider: "compatible-endpoint",
            endpointUrl: "not-a-url\n\u001b[31mforged\u202efailure",
          },
        ],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => null,
      showServiceStatus: vi.fn(),
      log: (message = "") => lines.push(message),
    });

    const inferenceLine = lines.find((line) => line.includes("Inference (configured):")) ?? "";
    expect(inferenceLine).toContain(String.raw`not-a-url\u000a\u001b[31mforged\u202efailure`);
    expect(inferenceLine).not.toMatch(
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u,
    );
  });

  // The stored endpoint belongs to the stored provider. The default sandbox's
  // row prefers the live gateway provider (#2369), so when that has drifted,
  // reporting the stored endpoint would name an upstream this sandbox is no
  // longer routed at.
  it("suppresses the stored endpoint when the live provider has drifted", () => {
    const lines: string[] = [];
    showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [
          {
            name: "alpha",
            model: "stored-model",
            provider: "stored-provider",
            endpointUrl: "https://stored.example/v1",
          },
        ],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => ({ provider: "live-provider", model: "live-model" }),
      showServiceStatus: vi.fn(),
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain("      Inference (configured): live-provider / live-model");
    expect(lines.some((line) => line.includes("stored.example"))).toBe(false);
  });

  it("keeps the endpoint on a non-default row while the gateway serves another sandbox", () => {
    const lines: string[] = [];
    showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [
          { name: "alpha", model: "live-model", provider: "live-provider" },
          {
            name: "beta",
            model: "qwen3.5:9b",
            provider: "ollama-local",
            endpointUrl: "http://localhost:11434/v1",
          },
        ],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => ({ provider: "live-provider", model: "live-model" }),
      showServiceStatus: vi.fn(),
      log: (message = "") => lines.push(message),
    });

    // Only the default row consults the live route, so beta keeps reporting
    // its own stored endpoint.
    expect(lines).toContain(
      "      Inference (configured): ollama-local / qwen3.5:9b (http://localhost:11434/v1)",
    );
  });
});

// Keep `--json` in step with the text view (same contract as #8710) so a
// consumer does not have to scrape the rendered line for the endpoint.
describe("status --json configured endpoint (#10221)", () => {
  it("reports the configured endpoint on each JSON sandbox row", () => {
    const report = getStatusReport({
      listSandboxes: () => ({
        sandboxes: [
          {
            name: "alpha",
            provider: "nvidia-prod",
            model: "nvidia/nemotron-3-super-120b-a12b",
            endpointUrl: "https://integrate.api.nvidia.com/v1",
          },
          { name: "beta", provider: "ollama-local", model: "qwen3.5:9b" },
        ],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => null,
      showServiceStatus: vi.fn(),
    });

    expect(report.sandboxes[0]?.endpointUrl).toBe("https://integrate.api.nvidia.com/v1");
    expect(report.sandboxes[1]?.endpointUrl).toBeNull();
  });

  it("redacts and drift-suppresses the endpoint on JSON sandbox rows", () => {
    const report = getStatusReport({
      listSandboxes: () => ({
        sandboxes: [
          {
            name: "alpha",
            provider: "stored-provider",
            model: "stored-model",
            endpointUrl: "https://stored.example/v1",
          },
          {
            name: "beta",
            provider: "compatible-endpoint",
            model: "m",
            endpointUrl: "https://user:hunter2@inference.example/v1",
          },
        ],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => ({ provider: "live-provider", model: "live-model" }),
      showServiceStatus: vi.fn(),
    });

    // alpha is the default sandbox and its live route drifted off the stored
    // provider, so the stored endpoint must not be attributed to it.
    expect(report.sandboxes[0]?.endpointUrl).toBeNull();
    expect(report.sandboxes[1]?.endpointUrl).toBe("https://inference.example/v1");
  });

  it("reports no JSON endpoint without a configured provider owner (#10221)", () => {
    const report = getStatusReport({
      listSandboxes: () => ({
        sandboxes: [
          {
            name: "alpha",
            model: "m",
            provider: "   ",
            endpointUrl: "https://internal.example/v1",
          },
        ],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => null,
      showServiceStatus: vi.fn(),
    });

    expect(report.sandboxes[0]?.endpointUrl).toBeNull();
  });
});
