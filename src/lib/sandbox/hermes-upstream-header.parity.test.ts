// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildHermesUpstreamHeader as buildAgentHeader } from "../../../agents/hermes/config/upstream-header.ts";
import { buildHermesUpstreamHeader as buildHostHeader } from "./hermes-upstream-header.ts";

const FIXTURES: Array<{ name: string; config: Record<string, unknown> }> = [
  { name: "absent annotation", config: {} },
  { name: "non-object annotation", config: { _nemoclaw_upstream: "scalar" } },
  {
    name: "provider only",
    config: { _nemoclaw_upstream: { provider: "nvidia-prod" } },
  },
  {
    name: "model only",
    config: { _nemoclaw_upstream: { model: "nvidia/nemotron-3-super-120b-a12b" } },
  },
  {
    name: "provider and model",
    config: {
      _nemoclaw_upstream: {
        provider: "hermes-provider",
        model: "moonshotai/kimi-k2.6",
      },
    },
  },
  {
    name: "newline injection in provider value",
    config: {
      _nemoclaw_upstream: {
        provider: "nvidia-prod\nmodel:\n  base_url: http://attacker",
        model: "test-model",
      },
    },
  },
  {
    name: "overlong provider value",
    config: {
      _nemoclaw_upstream: {
        provider: "a".repeat(512),
        model: "b".repeat(512),
      },
    },
  },
  {
    name: "non-string values",
    config: { _nemoclaw_upstream: { provider: 42, model: null } },
  },
];

describe("buildHermesUpstreamHeader parity", () => {
  for (const fixture of FIXTURES) {
    it(`agent and host helpers produce identical output for: ${fixture.name}`, () => {
      const agent = buildAgentHeader(fixture.config);
      const host = buildHostHeader(fixture.config);
      expect(host).toBe(agent);
    });
  }

  it("strips newlines and control characters so the comment cannot escape into YAML", () => {
    const malicious = {
      _nemoclaw_upstream: {
        provider: "nvidia-prod\nmodel:\n  base_url: http://attacker\x00\x07",
        model: "alpha\rbeta\tgamma",
      },
    };
    const header = buildHostHeader(malicious);
    expect(header.includes("\nmodel:")).toBe(false);
    // Sanitizer strips C0 controls (0x00-0x1F), DEL (0x7F), and C1 controls
    // (0x80-0x9F). Exclude 0x0A from the assertion only because the
    // multi-line header itself separates comment lines with \n.
    for (const line of header.split("\n")) {
      expect(line).not.toMatch(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/);
      if (line.length > 0) expect(line.startsWith("#")).toBe(true);
    }
  });

  it("length-caps each header value to keep the comment block bounded", () => {
    const header = buildHostHeader({
      _nemoclaw_upstream: {
        provider: "x".repeat(1024),
        model: "y".repeat(1024),
      },
    });
    // Worst-case line ≈ "# Upstream provider: " (21 chars) + 128-char value
    // ceiling = ~149 chars; 180 leaves headroom for future prefix tweaks.
    for (const line of header.split("\n")) {
      expect(line.length).toBeLessThan(180);
    }
  });
});
