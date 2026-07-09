// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { prepareSandboxCreateLaunch } from "./sandbox-create-launch";

const disabledHermesDashboardState = { config: null, enabled: false };

describe("prepareSandboxCreateLaunch observability", () => {
  it("forwards only the backend-neutral observability enable bit to Deep Agents Code", () => {
    const result = prepareSandboxCreateLaunch({
      agent: { name: "langchain-deepagents-code" } as any,
      observabilityEnabled: true,
      chatUiUrl: "",
      createArgs: ["--name", "dcode-demo"],
      sandboxName: "dcode-demo",
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example/v1/traces",
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=secret",
        LANGSMITH_API_KEY: "must-not-enter",
      },
      extraPlaceholderKeys: [],
      getDashboardForwardPort: vi.fn(() => "0"),
      hermesDashboardState: disabledHermesDashboardState,
      manageDashboard: false,
      openshellShellCommand: (args) => args.join(" "),
      buildEnv: () => ({}),
    });

    expect(result.envArgs).toContain("NEMOCLAW_OBSERVABILITY=1");
    const serialized = result.envArgs.join("\n");
    expect(serialized).not.toContain("collector.example");
    expect(serialized).not.toContain("OTEL_EXPORTER_OTLP_HEADERS");
    expect(serialized).not.toContain("LANGSMITH");
    expect(serialized).not.toContain("secret");
  });

  it("does not forward observability for another agent or when disabled", () => {
    const render = (name: string, observabilityEnabled: boolean) =>
      prepareSandboxCreateLaunch({
        agent: { name } as any,
        observabilityEnabled,
        chatUiUrl: "",
        createArgs: [],
        env: {},
        extraPlaceholderKeys: [],
        getDashboardForwardPort: vi.fn(() => "0"),
        hermesDashboardState: disabledHermesDashboardState,
        manageDashboard: false,
        openshellShellCommand: (args) => args.join(" "),
        buildEnv: () => ({}),
      });

    expect(render("langchain-deepagents-code", false).envArgs).not.toContain(
      "NEMOCLAW_OBSERVABILITY=1",
    );
    expect(render("hermes", true).envArgs).not.toContain("NEMOCLAW_OBSERVABILITY=1");
  });

  it("never trusts ambient DCode auto-approval as sandbox runtime input (#6478)", () => {
    const result = prepareSandboxCreateLaunch({
      agent: { name: "langchain-deepagents-code" } as any,
      chatUiUrl: "",
      createArgs: [],
      env: { NEMOCLAW_DCODE_AUTO_APPROVAL: "thread-opt-in" },
      extraPlaceholderKeys: [],
      getDashboardForwardPort: vi.fn(() => "0"),
      hermesDashboardState: disabledHermesDashboardState,
      manageDashboard: false,
      openshellShellCommand: (args) => args.join(" "),
      buildEnv: () => ({}),
    });

    expect(result.envArgs.join("\n")).not.toContain("NEMOCLAW_DCODE_AUTO_APPROVAL");
    expect(result.sandboxStartupCommand.join("\n")).not.toContain("NEMOCLAW_DCODE_AUTO_APPROVAL");
  });
});
