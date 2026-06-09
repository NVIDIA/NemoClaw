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
    expect(header).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/);
    for (const line of header.split("\n")) {
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
    for (const line of header.split("\n")) {
      expect(line.length).toBeLessThan(180);
    }
  });
});
