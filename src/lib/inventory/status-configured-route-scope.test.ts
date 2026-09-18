// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { getStatusReport, showStatusCommand } from "./index";

// #11412: a stop/start on one sandbox realigns the one shared live inference
// route. That must not change what a different sandbox's own "Inference
// (configured)" line or status --json row reports.
describe("status inference row stays scoped to its own sandbox (#11412)", () => {
  const sandboxes = [
    { name: "route-a", model: "llama3.2:1b", provider: "ollama-route-a" },
    { name: "route-b", model: "qwen2.5:0.5b", provider: "ollama-route-b" },
  ];
  const listSandboxes = () => ({ sandboxes, defaultSandbox: "route-b" });
  // The gateway's one shared route was last aligned to route-a (the reported
  // trigger: starting route-a realigns the shared route to its model and
  // provider). Using distinct providers here proves the "configured" line
  // and JSON row use each sandbox's own provider, not just its own model.
  const getLiveInference = () => ({ provider: "ollama-route-a", model: "llama3.2:1b" });

  it("keeps the text Inference (configured) line on each sandbox's own recorded route", async () => {
    const lines: string[] = [];
    await showStatusCommand({
      listSandboxes,
      getLiveInference,
      showServiceStatus: vi.fn(),
      log: (message = "") => lines.push(message),
    });

    // The name-line model still prefers the live route for the default
    // sandbox, per #2369, with its own onboarded value noted alongside.
    expect(lines).toContain("    route-b * (llama3.2:1b)");
    expect(lines).toContain("      (onboarded: qwen2.5:0.5b)");
    expect(lines).toContain("      Inference (configured): ollama-route-a / llama3.2:1b");
    expect(lines).toContain("      Inference (configured): ollama-route-b / qwen2.5:0.5b");
  });

  it("keeps status --json rows on each sandbox's own recorded route", async () => {
    const report = await getStatusReport({
      listSandboxes,
      getLiveInference,
      showServiceStatus: vi.fn(),
    });

    expect(report.sandboxes).toMatchObject([
      { name: "route-a", model: "llama3.2:1b", provider: "ollama-route-a" },
      { name: "route-b", model: "qwen2.5:0.5b", provider: "ollama-route-b" },
    ]);
  });
});
