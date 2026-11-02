// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureAgentDashboardForward } from "./agent-dashboard-forward";
import { canReuseDashboardForwardForAgent } from "./dashboard-runtime";
import { createOnboardDashboardHelpers } from "./dashboard";
import { loadAgent } from "../agent/defs";
import type { OpenShellForwardAdapter } from "../adapters/openshell/forward";

describe("agent dashboard forward reuse eligibility", () => {
  it.each([
    { agent: undefined, expected: true },
    { agent: null, expected: true },
    { agent: { name: "openclaw" }, expected: true },
    { agent: { name: "hermes" }, expected: true },
    { agent: { name: "pi" }, expected: false },
    { agent: { name: "deepagents" }, expected: false },
  ])("permits reuse=$expected for $agent", ({ agent, expected }) => {
    expect(canReuseDashboardForwardForAgent(agent)).toBe(expected);
  });
});

describe("ensureAgentDashboardForward", () => {
  afterEach(() => {
    delete process.env.CHAT_UI_URL;
    vi.unstubAllEnvs();
  });

  it.each([8642, 8643])(
    "migrates the registered Hermes API on port %i during onboarding",
    async (port) => {
      vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
      const sandbox = {
        name: "hm",
        agent: "hermes",
        hermesApiPort: port,
        dashboardRemoteBindPrepared: true,
      };
      const events: string[] = [];
      let wildcard = true;
      const adapter: OpenShellForwardAdapter = {
        observeForwards: async (request) => {
          await request.assertCurrent?.();
          events.push(
            request.forwards[0]?.port === port ? "observe-wildcard" : "observe-dashboard",
          );
          return request.forwards.map((forward) => ({ state: "owned", forward }));
        },
        retireLegacyForward: async (request) => {
          await request.assertCurrent?.();
          await request.authorize(request.forward);
          expect(request.forward.localHost).toBe("0.0.0.0");
          expect(request.migrateToLoopback).toBe(true);
          events.push("retire-wildcard");
          wildcard = false;
          return { state: "retired", forward: request.forward };
        },
        startForward: async (request) => {
          await request.assertCurrent?.();
          switch (request.forward.port) {
            case 18789:
              expect(request.forward.localHost).toBe("0.0.0.0");
              events.push("reuse-dashboard");
              return { state: "reused", forward: request.forward };
          }
          expect(request.forward.localHost).toBe("127.0.0.1");
          expect(request.forward.port).toBe(port);
          events.push(wildcard ? "refuse-loopback" : "start-loopback");
          return wildcard
            ? { state: "refused", observation: { state: "foreign", forward: request.forward } }
            : { state: "reused", forward: request.forward };
        },
        verifyForwardRelease: vi.fn(),
      };
      const helpers = createOnboardDashboardHelpers({
        runCaptureOpenshell: vi.fn(() => ""),
        cliName: () => "nemoclaw",
        agentProductName: () => "NemoClaw",
        getProviderLabel: (provider) => provider,
        note: vi.fn(),
        isWsl: () => true,
        redact: String,
        sleep: vi.fn(),
        printAgentDashboardUi: vi.fn(),
        listSandboxes: () => ({ sandboxes: [sandbox] }),
        getSandbox: () => sandbox,
        getGatewayForwardRuntimeAuthority: () => ({ gatewayEndpoint: "https://127.0.0.1:8080" }),
        resolveForwardGatewayName: () => "nemoclaw",
        forwardAdapterForAuthority: () => adapter,
      });
      await expect(helpers.ensureAgentDashboardForward("hm", loadAgent("hermes"))).resolves.toBe(
        18789,
      );
      expect(events).toEqual([
        "observe-dashboard",
        "reuse-dashboard",
        "refuse-loopback",
        "observe-wildcard",
        "retire-wildcard",
        "start-loopback",
      ]);
    },
  );

  it.each([false, true])("forwards Hermes ports with reuse=%s", async (reuseExistingForward) => {
    const ensureLoopbackForward = vi.fn();
    const ensureDashboardForward = vi.fn((_sandboxName, chatUiUrl = "http://127.0.0.1:18789") => {
      const parsed = new URL(chatUiUrl);
      return Number(parsed.port);
    });

    expect(
      await ensureAgentDashboardForward({
        sandboxName: "hm",
        agent: {
          forwardPort: 18789,
          forward_ports: [18789, 8642],
        },
        ensureDashboardForward,
        ensureLoopbackForward,
        hermesApiPort: 8642,
        reuseExistingForward,
      }),
    ).toBe(18789);

    expect(ensureDashboardForward).toHaveBeenNthCalledWith(1, "hm", "http://127.0.0.1:18789", {
      allowPortReallocation: false,
      ...(reuseExistingForward ? { reuseExistingForward: true } : {}),
    });
    expect(ensureLoopbackForward).toHaveBeenCalledWith("hm", 8642, undefined);
  });

  it("forwards the sandbox's per-sandbox API port instead of the manifest default (#8543)", async () => {
    const ensureLoopbackForward = vi.fn();
    const ensureDashboardForward = vi.fn((_sandboxName, chatUiUrl = "http://127.0.0.1:18789") => {
      const parsed = new URL(chatUiUrl);
      return Number(parsed.port);
    });

    expect(
      await ensureAgentDashboardForward({
        sandboxName: "hm",
        agent: {
          forwardPort: 18789,
          forward_ports: [18789, 8642],
        },
        ensureDashboardForward,
        ensureLoopbackForward,
        hermesApiPort: 8643,
      }),
    ).toBe(18789);

    expect(ensureDashboardForward).toHaveBeenNthCalledWith(1, "hm", "http://127.0.0.1:18789", {
      allowPortReallocation: false,
    });
    expect(ensureLoopbackForward).toHaveBeenCalledWith("hm", 8643, undefined);
    expect(ensureDashboardForward).not.toHaveBeenCalledWith(
      "hm",
      "http://127.0.0.1:8642",
      expect.anything(),
    );
  });

  it("hands off a reserved port immediately before starting its host forward", async () => {
    const events: string[] = [];
    const ensureDashboardForward = vi.fn((_sandboxName, chatUiUrl = "") => {
      const port = Number(new URL(chatUiUrl).port);
      events.push(`forward:${port}`);
      return port;
    });

    await ensureAgentDashboardForward({
      sandboxName: "hm",
      agent: {
        forwardPort: 18789,
        forward_ports: [18789, 8642],
      },
      ensureDashboardForward,
      ensureLoopbackForward: (_name, port) => {
        events.push(`forward:${port}`);
      },
      hermesApiPort: 8643,
      beforeForwardPort: (port) => {
        events.push(`before:${port}`);
      },
    });

    expect(events).toEqual(["before:18789", "forward:18789", "before:8643", "forward:8643"]);
  });

  it("keeps an explicit effective port and omits the replaced manifest default (#6277)", async () => {
    const ensureLoopbackForward = vi.fn();
    const ensureDashboardForward = vi.fn((_sandboxName, chatUiUrl = "") => {
      return Number(new URL(chatUiUrl).port);
    });

    expect(
      await ensureAgentDashboardForward({
        sandboxName: "hm",
        agent: {
          forwardPort: 18789,
          forward_ports: [18789, 8642],
        },
        ensureDashboardForward,
        ensureLoopbackForward,
        hermesApiPort: 8642,
        controlUiPort: 9120,
      }),
    ).toBe(9120);

    expect(ensureDashboardForward).toHaveBeenNthCalledWith(1, "hm", "http://127.0.0.1:9120", {
      allowPortReallocation: false,
    });
    expect(ensureLoopbackForward).toHaveBeenCalledWith("hm", 8642, undefined);
    expect(ensureDashboardForward).not.toHaveBeenCalledWith(
      "hm",
      "http://127.0.0.1:18789",
      expect.anything(),
    );
    expect(process.env.CHAT_UI_URL).toBe("http://127.0.0.1:9120");
  });

  it("preserves a remote dashboard URL while refreshing its effective port (#6277)", async () => {
    const ensureLoopbackForward = vi.fn();
    const ensureDashboardForward = vi.fn((_sandboxName, chatUiUrl = "") => {
      return Number(new URL(chatUiUrl).port);
    });

    expect(
      await ensureAgentDashboardForward({
        sandboxName: "hm",
        agent: {
          dashboard: { kind: "ui" },
          forwardPort: 18789,
          forward_ports: [18789, 8642],
        },
        ensureDashboardForward,
        ensureLoopbackForward,
        hermesApiPort: 8642,
        chatUiUrl: "https://hermes.example.test:9120/ui",
        controlUiPort: 9120,
      }),
    ).toBe(9120);

    expect(ensureDashboardForward).toHaveBeenNthCalledWith(
      1,
      "hm",
      "https://hermes.example.test:9120/ui",
      { allowPortReallocation: false },
    );
    expect(process.env.CHAT_UI_URL).toBe("https://hermes.example.test:9120/ui");
  });

  it("forwards an API-kind agent on the sandbox-owned primary port", async () => {
    const ensureLoopbackForward = vi.fn();
    const ensureDashboardForward = vi.fn((_sandboxName, chatUiUrl = "") => {
      return Number(new URL(chatUiUrl).port);
    });

    expect(
      await ensureAgentDashboardForward({
        sandboxName: "api-agent",
        agent: {
          dashboard: { kind: "api" },
          forwardPort: 8642,
          forward_ports: [8642],
        },
        ensureDashboardForward,
        ensureLoopbackForward,
        hermesApiPort: 8647,
        chatUiUrl: "http://127.0.0.1:9120",
        controlUiPort: 9120,
      }),
    ).toBe(8647);

    expect(ensureLoopbackForward).toHaveBeenCalledWith("api-agent", 8647, undefined);
    expect(ensureDashboardForward).not.toHaveBeenCalled();
    expect(ensureDashboardForward).not.toHaveBeenCalledWith(
      "api-agent",
      "http://127.0.0.1:8642",
      expect.anything(),
    );
    expect(process.env.CHAT_UI_URL).toBeUndefined();
  });

  it("preserves the canonical WebUI forward for an API-kind agent with an optional dashboard", async () => {
    process.env.CHAT_UI_URL = "https://hermes.example.test:9120/ui";
    const ensureLoopbackForward = vi.fn();
    const ensureDashboardForward = vi.fn((_sandboxName, chatUiUrl = "") => {
      return Number(new URL(chatUiUrl).port);
    });

    expect(
      await ensureAgentDashboardForward({
        sandboxName: "legacy-hermes",
        agent: {
          dashboard: { kind: "api" },
          dashboardUi: { port: 9119 },
          forwardPort: 8642,
          forward_ports: [8642],
        },
        ensureDashboardForward,
        ensureLoopbackForward,
        hermesApiPort: 8642,
        chatUiUrl: process.env.CHAT_UI_URL,
        controlUiPort: 9120,
      }),
    ).toBe(8642);

    expect(ensureLoopbackForward).toHaveBeenCalledWith("legacy-hermes", 8642, undefined);
    expect(ensureDashboardForward).toHaveBeenNthCalledWith(
      1,
      "legacy-hermes",
      "https://hermes.example.test:9120/ui",
      {
        allowPortReallocation: false,
      },
    );
    expect(process.env.CHAT_UI_URL).toBe("https://hermes.example.test:9120/ui");
  });

  it("fails reuse and restores the dashboard URL when the Hermes API forward fails", async () => {
    process.env.CHAT_UI_URL = "http://127.0.0.1:18790";
    const warn = vi.fn();
    const ensureLoopbackForward = vi.fn(() => {
      throw new Error("API forward ownership is unknown");
    });
    const ensureDashboardForward = vi.fn(() => 18790);
    await expect(
      ensureAgentDashboardForward({
        sandboxName: "hm",
        agent: { forwardPort: 18789, forward_ports: [18789, 8642] },
        ensureDashboardForward,
        ensureLoopbackForward,
        hermesApiPort: 8643,
        reuseExistingForward: true,
        warn,
      }),
    ).rejects.toThrow("API forward ownership is unknown");
    expect(process.env.CHAT_UI_URL).toBe("http://127.0.0.1:18790");
    expect(warn).not.toHaveBeenCalled();
  });
});
