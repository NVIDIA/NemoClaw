// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { resolveOnboardOptions } from "./command";
import { type OnboardFlags, resolveDashboardOriginInputs } from "./command-support";

function resolve(flags: OnboardFlags, env: NodeJS.ProcessEnv = {}) {
  const error = vi.fn();
  const options = () =>
    resolveOnboardOptions(flags, {
      env,
      resolveDashboardOrigins: resolveDashboardOriginInputs,
      listAgents: () => ["openclaw", "hermes", "langchain-deepagents-code"],
      error,
      exit: (code: number): never => {
        throw new Error(`exit:${code}`);
      },
    });
  return { options, error };
}

describe("onboard --dashboard-origin (#13177)", () => {
  it("combines the flag with NEMOCLAW_DASHBOARD_ORIGINS", () => {
    const { options } = resolve(
      { "dashboard-origin": ["https://launchpad.example.test:8443"] },
      { NEMOCLAW_DASHBOARD_ORIGINS: "http://localhost:9000,https://launchpad.example.test:8443" },
    );

    expect(options().dashboardOrigins).toEqual([
      "https://launchpad.example.test:8443",
      "http://localhost:9000",
    ]);
  });

  it("leaves the option unset when no origin is requested", () => {
    expect(resolve({}).options()).not.toHaveProperty("dashboardOrigins");
  });

  it("fails before onboarding on an invalid origin", () => {
    const { options, error } = resolve({ "dashboard-origin": ["http://launchpad.example.test"] });

    expect(options).toThrow("exit:1");
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/Dashboard origin 1 must use https unless its host is loopback/),
    );
  });

  it.each(["hermes", "langchain-deepagents-code"])(
    "refuses dashboard origins for %s before onboarding starts",
    (agent) => {
      const { options, error } = resolve({
        agent,
        "dashboard-origin": ["https://launchpad.example.test:8443"],
      });

      expect(options).toThrow("exit:1");
      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(/--dashboard-origin is supported only for OpenClaw sandboxes/),
      );
    },
  );

  it("accepts dashboard origins when NEMOCLAW_AGENT names an OpenClaw alias", () => {
    const { options } = resolve(
      { "dashboard-origin": ["https://launchpad.example.test:8443"] },
      { NEMOCLAW_AGENT: "nemoclaw" },
    );

    expect(options().dashboardOrigins).toEqual(["https://launchpad.example.test:8443"]);
  });

  it("refuses dashboard origins when NEMOCLAW_AGENT names another agent's alias", () => {
    const { options } = resolve(
      { "dashboard-origin": ["https://launchpad.example.test:8443"] },
      { NEMOCLAW_AGENT: "nemohermes" },
    );

    expect(options).toThrow("exit:1");
  });

  it("refuses an exported NEMOCLAW_DASHBOARD_ORIGINS for another agent", () => {
    const { options } = resolve(
      { agent: "hermes" },
      { NEMOCLAW_DASHBOARD_ORIGINS: "https://launchpad.example.test:8443" },
    );

    expect(options).toThrow("exit:1");
  });

  it.each([
    ["--from", { from: "Dockerfile" }],
    [
      "--from-image",
      {
        "from-image": `ghcr.io/example/agent@sha256:${"a".repeat(64)}`,
      },
    ],
  ])("refuses dashboard origins with %s before onboarding starts", (_flag, source) => {
    const { options, error } = resolve({
      ...source,
      "dashboard-origin": ["https://launchpad.example.test:8443"],
    } as OnboardFlags);

    expect(options).toThrow("exit:1");
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/--dashboard-origin requires a managed OpenClaw image/),
    );
  });

  it("refuses an exported NEMOCLAW_DASHBOARD_ORIGINS with --from before onboarding starts", () => {
    const { options, error } = resolve(
      { from: "Dockerfile" },
      { NEMOCLAW_DASHBOARD_ORIGINS: "https://launchpad.example.test:8443" },
    );

    expect(options).toThrow("exit:1");
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/--dashboard-origin requires a managed OpenClaw image/),
    );
  });

  it("refuses more than 16 origins", () => {
    const origins = Array.from({ length: 17 }, (_, i) => `https://o${i}.example.test:8443`);
    const { options, error } = resolve({ "dashboard-origin": origins });

    expect(options).toThrow("exit:1");
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/at most 16/));
  });
});
