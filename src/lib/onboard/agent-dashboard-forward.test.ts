// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureAgentDashboardForward } from "./agent-dashboard-forward";

describe("ensureAgentDashboardForward", () => {
  afterEach(() => {
    delete process.env.CHAT_UI_URL;
  });

  it("preserves additional host-forward ports during dashboard refresh", () => {
    const ensureDashboardForward = vi.fn((_sandboxName, chatUiUrl = "http://127.0.0.1:18789") => {
      const parsed = new URL(chatUiUrl);
      return Number(parsed.port);
    });

    expect(
      ensureAgentDashboardForward({
        sandboxName: "hm",
        agent: {
          forwardPort: 18789,
          forward_ports: [18789, 8642],
        },
        ensureDashboardForward,
        preserveForwardPorts: [3978],
      }),
    ).toBe(18789);

    expect(ensureDashboardForward).toHaveBeenNthCalledWith(1, "hm", "http://127.0.0.1:18789", {
      preserveSandboxPorts: [18789, 8642, 3978],
    });
    expect(ensureDashboardForward).toHaveBeenNthCalledWith(2, "hm", "http://127.0.0.1:8642", {
      preserveSandboxPorts: [18789, 8642, 3978],
      allowPortReallocation: false,
    });
  });

  it("keeps an explicit effective port and omits the replaced manifest default (#6277)", () => {
    const ensureDashboardForward = vi.fn((_sandboxName, chatUiUrl = "") => {
      return Number(new URL(chatUiUrl).port);
    });

    expect(
      ensureAgentDashboardForward({
        sandboxName: "hm",
        agent: {
          forwardPort: 18789,
          forward_ports: [18789, 8642],
        },
        ensureDashboardForward,
        controlUiPort: 9120,
        preserveForwardPorts: [3978],
      }),
    ).toBe(9120);

    expect(ensureDashboardForward).toHaveBeenNthCalledWith(1, "hm", "http://127.0.0.1:9120", {
      preserveSandboxPorts: [9120, 8642, 3978],
    });
    expect(ensureDashboardForward).toHaveBeenNthCalledWith(2, "hm", "http://127.0.0.1:8642", {
      preserveSandboxPorts: [9120, 8642, 3978],
      allowPortReallocation: false,
    });
    expect(ensureDashboardForward).not.toHaveBeenCalledWith(
      "hm",
      "http://127.0.0.1:18789",
      expect.anything(),
    );
    expect(process.env.CHAT_UI_URL).toBe("http://127.0.0.1:9120");
  });

  it("preserves a remote dashboard URL while refreshing its effective port (#6277)", () => {
    const ensureDashboardForward = vi.fn((_sandboxName, chatUiUrl = "") => {
      return Number(new URL(chatUiUrl).port);
    });

    expect(
      ensureAgentDashboardForward({
        sandboxName: "hm",
        agent: {
          dashboard: { kind: "ui" },
          forwardPort: 18789,
          forward_ports: [18789, 8642],
        },
        ensureDashboardForward,
        chatUiUrl: "https://hermes.example.test:9120/ui",
        controlUiPort: 9120,
      }),
    ).toBe(9120);

    expect(ensureDashboardForward).toHaveBeenNthCalledWith(
      1,
      "hm",
      "https://hermes.example.test:9120/ui",
      { preserveSandboxPorts: [9120, 8642] },
    );
    expect(process.env.CHAT_UI_URL).toBe("https://hermes.example.test:9120/ui");
  });

  it("keeps an API-kind agent on its declared primary port", () => {
    const ensureDashboardForward = vi.fn((_sandboxName, chatUiUrl = "") => {
      return Number(new URL(chatUiUrl).port);
    });

    expect(
      ensureAgentDashboardForward({
        sandboxName: "api-agent",
        agent: {
          dashboard: { kind: "api" },
          forwardPort: 8642,
          forward_ports: [8642],
        },
        ensureDashboardForward,
        chatUiUrl: "http://127.0.0.1:9120",
        controlUiPort: 9120,
      }),
    ).toBe(8642);

    expect(ensureDashboardForward).toHaveBeenCalledWith("api-agent", "http://127.0.0.1:8642", {
      preserveSandboxPorts: [8642],
    });
    expect(process.env.CHAT_UI_URL).toBeUndefined();
  });

  it("preserves the canonical WebUI forward for an API-kind agent with an optional dashboard", () => {
    process.env.CHAT_UI_URL = "https://hermes.example.test:9120/ui";
    const ensureDashboardForward = vi.fn((_sandboxName, chatUiUrl = "") => {
      return Number(new URL(chatUiUrl).port);
    });

    expect(
      ensureAgentDashboardForward({
        sandboxName: "legacy-hermes",
        agent: {
          dashboard: { kind: "api" },
          dashboardUi: { port: 9119 },
          forwardPort: 8642,
          forward_ports: [8642],
        },
        ensureDashboardForward,
        chatUiUrl: process.env.CHAT_UI_URL,
        controlUiPort: 9120,
      }),
    ).toBe(8642);

    expect(ensureDashboardForward).toHaveBeenNthCalledWith(
      1,
      "legacy-hermes",
      "http://127.0.0.1:8642",
      { preserveSandboxPorts: [8642, 9120] },
    );
    expect(ensureDashboardForward).toHaveBeenNthCalledWith(
      2,
      "legacy-hermes",
      "https://hermes.example.test:9120/ui",
      {
        preserveSandboxPorts: [8642, 9120],
        allowPortReallocation: false,
      },
    );
    expect(process.env.CHAT_UI_URL).toBe("https://hermes.example.test:9120/ui");
  });
});
