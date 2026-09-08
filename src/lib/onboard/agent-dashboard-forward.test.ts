// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureAgentDashboardForward } from "./agent-dashboard-forward";

describe("ensureAgentDashboardForward", () => {
  afterEach(() => {
    delete process.env.CHAT_UI_URL;
  });

  it("launches each declared host-forward port", async () => {
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
        hermesApiPort: 8642,
      }),
    ).toBe(18789);

    expect(ensureDashboardForward).toHaveBeenNthCalledWith(1, "hm", "http://127.0.0.1:18789", {
      allowPortReallocation: false,
    });
    expect(ensureDashboardForward).toHaveBeenNthCalledWith(2, "hm", "http://127.0.0.1:8642", {
      allowPortReallocation: false,
    });
  });

  it("forwards the sandbox's per-sandbox API port instead of the manifest default (#8543)", async () => {
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
        hermesApiPort: 8643,
      }),
    ).toBe(18789);

    expect(ensureDashboardForward).toHaveBeenNthCalledWith(1, "hm", "http://127.0.0.1:18789", {
      allowPortReallocation: false,
    });
    expect(ensureDashboardForward).toHaveBeenNthCalledWith(2, "hm", "http://127.0.0.1:8643", {
      allowPortReallocation: false,
    });
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
      hermesApiPort: 8643,
      beforeForwardPort: (port) => {
        events.push(`before:${port}`);
      },
    });

    expect(events).toEqual(["before:18789", "forward:18789", "before:8643", "forward:8643"]);
  });

  it("keeps an explicit effective port and omits the replaced manifest default (#6277)", async () => {
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
        hermesApiPort: 8642,
        controlUiPort: 9120,
      }),
    ).toBe(9120);

    expect(ensureDashboardForward).toHaveBeenNthCalledWith(1, "hm", "http://127.0.0.1:9120", {
      allowPortReallocation: false,
    });
    expect(ensureDashboardForward).toHaveBeenNthCalledWith(2, "hm", "http://127.0.0.1:8642", {
      allowPortReallocation: false,
    });
    expect(ensureDashboardForward).not.toHaveBeenCalledWith(
      "hm",
      "http://127.0.0.1:18789",
      expect.anything(),
    );
    expect(process.env.CHAT_UI_URL).toBe("http://127.0.0.1:9120");
  });

  it("preserves a remote dashboard URL while refreshing its effective port (#6277)", async () => {
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
        hermesApiPort: 8647,
        chatUiUrl: "http://127.0.0.1:9120",
        controlUiPort: 9120,
      }),
    ).toBe(8647);

    expect(ensureDashboardForward).toHaveBeenCalledWith(
      "api-agent",
      "http://127.0.0.1:8647",
      { allowPortReallocation: false },
    );
    expect(ensureDashboardForward).not.toHaveBeenCalledWith(
      "api-agent",
      "http://127.0.0.1:8642",
      expect.anything(),
    );
    expect(process.env.CHAT_UI_URL).toBeUndefined();
  });

  it("preserves the canonical WebUI forward for an API-kind agent with an optional dashboard", async () => {
    process.env.CHAT_UI_URL = "https://hermes.example.test:9120/ui";
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
        hermesApiPort: 8642,
        chatUiUrl: process.env.CHAT_UI_URL,
        controlUiPort: 9120,
      }),
    ).toBe(8642);

    expect(ensureDashboardForward).toHaveBeenNthCalledWith(
      1,
      "legacy-hermes",
      "http://127.0.0.1:8642",
      { allowPortReallocation: false },
    );
    expect(ensureDashboardForward).toHaveBeenNthCalledWith(
      2,
      "legacy-hermes",
      "https://hermes.example.test:9120/ui",
      {
        allowPortReallocation: false,
      },
    );
    expect(process.env.CHAT_UI_URL).toBe("https://hermes.example.test:9120/ui");
  });
});
