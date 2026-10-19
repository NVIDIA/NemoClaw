// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { materializeOpenClawPricingPins } from "./preset-parsing";

const preset = `preset:\n  name: openclaw-pricing\nnetwork_policies:\n  openclaw-pricing:\n    endpoints:\n      - host: openrouter.ai\n        port: 443\n        protocol: rest\n        rules:\n          - allow: { method: GET, path: /api/v1/models }\n`;

function live(...routes: Array<{ key: string; pins?: string[] }>): string {
  return YAML.stringify({
    version: 1,
    network_policies: Object.fromEntries(
      routes.map(({ key, pins }) => [
        key,
        {
          endpoints: [{ host: "openrouter.ai", port: 443, ...(pins ? { allowed_ips: pins } : {}) }],
        },
      ]),
    ),
  });
}

describe("OpenClaw pricing with a pinned custom OpenRouter provider", () => {
  it("uses the exact common pins and keeps the pricing route GET-only", () => {
    const pins = ["34.117.59.81", "104.18.8.134"];
    const content = materializeOpenClawPricingPins(
      live(
        { key: "_provider_nemoclaw_custom_openrouter_v1", pins },
        { key: "native_hosted_inference", pins },
      ),
      preset,
    );
    const endpoint = YAML.parse(content).network_policies["openclaw-pricing"].endpoints[0];
    expect(endpoint.allowed_ips).toEqual([...pins].sort());
    expect(endpoint.rules).toEqual([{ allow: { method: "GET", path: "/api/v1/models" } }]);
    expect(content).not.toContain("api_key");
  });

  it("leaves the built-in preset unchanged when there is no OpenRouter overlap", () => {
    expect(materializeOpenClawPricingPins("version: 1\nnetwork_policies: {}\n", preset)).toBe(
      preset,
    );
  });

  it("fails closed for an unpinned or conflicting overlap", () => {
    expect(() =>
      materializeOpenClawPricingPins(
        live({ key: "user_custom_route", pins: ["34.117.59.81"] }),
        preset,
      ),
    ).toThrow("no verified OpenRouter provider route");
    expect(() =>
      materializeOpenClawPricingPins(live({ key: "native_hosted_inference" }), preset),
    ).toThrow("no verified IP pins");
    expect(() =>
      materializeOpenClawPricingPins(
        live(
          { key: "_provider_nemoclaw_custom_openrouter_v1", pins: ["34.117.59.81"] },
          { key: "native_hosted_inference", pins: ["104.18.8.134"] },
        ),
        preset,
      ),
    ).toThrow("conflicting IP pins");
  });
});
