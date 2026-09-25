// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const tempHomes: string[] = [];

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-protected-ports-"));
  tempHomes.push(home);
  return home;
}

describe("protected NemoClaw host ports", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("./repository-root");
    vi.resetModules();
    for (const home of tempHomes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
  });

  it("rejects the Model Router port configured by the routed blueprint", async () => {
    const root = tempHome();
    const blueprintDir = path.join(root, "nemoclaw-blueprint");
    fs.mkdirSync(blueprintDir, { recursive: true });
    fs.writeFileSync(
      path.join(blueprintDir, "blueprint.yaml"),
      [
        "components:",
        "  inference:",
        "    profiles:",
        "      routed:",
        "        model: test/model",
        "  router:",
        "    enabled: true",
        "    port: 23006",
        "",
      ].join("\n"),
    );
    vi.stubEnv("HOME", tempHome());
    vi.doMock("./repository-root", () => ({ REPOSITORY_ROOT: root }));
    vi.resetModules();

    const { isProtectedNemoClawHostPort } = await import("./protected-host-ports");
    const { isLoopbackNoAuthCompatibleEndpointUrl } =
      await import("../onboard/inference-providers/compatible-endpoint-gateway-route");

    expect(isProtectedNemoClawHostPort(23006)).toBe(true);
    expect(
      isLoopbackNoAuthCompatibleEndpointUrl("compatible-endpoint", "http://localhost:23006/v1"),
    ).toBe(false);
  });

  it("keeps the default and automatic gateway ports reserved under an override", async () => {
    vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "18080");
    vi.resetModules();

    const {
      AUTOMATIC_GATEWAY_PORT_RANGE_END,
      AUTOMATIC_GATEWAY_PORT_RANGE_START,
      DEFAULT_GATEWAY_PORT,
      isProtectedNemoClawHostPort,
    } = await import("./protected-host-ports");

    expect(isProtectedNemoClawHostPort(DEFAULT_GATEWAY_PORT)).toBe(true);
    expect(isProtectedNemoClawHostPort(18080)).toBe(true);
    expect(isProtectedNemoClawHostPort(AUTOMATIC_GATEWAY_PORT_RANGE_START)).toBe(true);
    expect(isProtectedNemoClawHostPort(AUTOMATIC_GATEWAY_PORT_RANGE_END)).toBe(true);
    expect(isProtectedNemoClawHostPort(AUTOMATIC_GATEWAY_PORT_RANGE_START - 1)).toBe(false);
    expect(isProtectedNemoClawHostPort(AUTOMATIC_GATEWAY_PORT_RANGE_END + 1)).toBe(false);
  });

  it.each([
    ["dashboard", "NEMOCLAW_DASHBOARD_PORT", 23001],
    ["Ollama proxy", "NEMOCLAW_OLLAMA_PROXY_PORT", 23002],
    ["Bedrock adapter", "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT", 23003],
    ["OpenRouter adapter", "NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT", 23004],
    ["HTTPS-pin adapter", "NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_PORT", 23005],
  ])("rejects a configured %s port at the no-auth route boundary", async (_label, env, port) => {
    vi.stubEnv("HOME", tempHome());
    vi.stubEnv(env, String(port));
    vi.resetModules();

    const { isProtectedNemoClawHostPort } = await import("./protected-host-ports");
    const { isLoopbackNoAuthCompatibleEndpointUrl } =
      await import("../onboard/inference-providers/compatible-endpoint-gateway-route");

    expect(isProtectedNemoClawHostPort(port)).toBe(true);
    expect(
      isLoopbackNoAuthCompatibleEndpointUrl(
        "compatible-endpoint",
        `http://localhost:${String(port)}/v1`,
      ),
    ).toBe(false);
  });
});
