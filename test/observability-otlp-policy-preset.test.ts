// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { filterSetupPolicyPresetsForAgent } from "../src/lib/onboard/agent-policy-presets";
import * as policies from "../src/lib/policy";

describe("backend-neutral OTLP observability policy preset", () => {
  it("keeps the built-in preset catalog complete", () => {
    expect(
      policies
        .listPresets()
        .map((preset) => preset.name)
        .sort(),
    ).toEqual([
      "brave",
      "brew",
      "claude-code",
      "discord",
      "github",
      "huggingface",
      "jira",
      "local-inference",
      "nous-audio",
      "nous-browser",
      "nous-code",
      "nous-image",
      "nous-web",
      "npm",
      "observability-otlp-local",
      "openclaw-diagnostics-otel-local",
      "openclaw-pricing",
      "outlook",
      "public-reference",
      "pypi",
      "slack",
      "tavily",
      "teams",
      "telegram",
      "weather",
      "wechat",
      "whatsapp",
    ]);
  });

  it("is available only to LangChain Deep Agents Code", () => {
    const namesFor = (agent: string) =>
      filterSetupPolicyPresetsForAgent(policies.listPresets(), agent).map((preset) => preset.name);

    expect(namesFor("langchain-deepagents-code")).toContain("observability-otlp-local");
    expect(namesFor("openclaw")).not.toContain("observability-otlp-local");
    expect(namesFor("hermes")).not.toContain("observability-otlp-local");
  });

  it("permits only trace POSTs from managed Python", () => {
    const parsed = YAML.parse(String(policies.loadPreset("observability-otlp-local"))) as {
      network_policies?: Record<
        string,
        {
          endpoints?: Array<Record<string, unknown>>;
          binaries?: Array<{ path: string }>;
        }
      >;
    };
    const policy = parsed.network_policies?.["observability-otlp-local"];

    expect(policy?.endpoints).toEqual([
      {
        host: "host.openshell.internal",
        port: 4318,
        protocol: "rest",
        enforcement: "enforce",
        allowed_ips: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
        rules: [{ allow: { method: "POST", path: "/v1/traces" } }],
      },
    ]);
    expect(policy?.binaries).toEqual([{ path: "/opt/venv/bin/python3*" }]);
  });
});
