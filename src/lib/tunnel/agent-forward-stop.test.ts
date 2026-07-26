// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { stopAgentForwardPortsForStop } from "./agent-forward-stop";

function forwardList(entries: Array<{ sandbox: string; port: number; status?: string }>): string {
  return [
    "SANDBOX BIND PORT PID STATUS",
    ...entries.map(
      (entry, index) =>
        `${entry.sandbox} 127.0.0.1 ${String(entry.port)} ${String(1000 + index)} ${
          entry.status ?? "running"
        }`,
    ),
  ].join("\n");
}

describe("stopAgentForwardPortsForStop", () => {
  it("stops declared and runtime dashboard forwards with sandbox-scoped commands", () => {
    const runOpenshell = vi.fn();
    const runCaptureOpenshell = vi.fn(() =>
      forwardList([
        { sandbox: "nemohermes", port: 18789 },
        { sandbox: "nemohermes", port: 8642 },
        { sandbox: "nemohermes", port: 18792 },
      ]),
    );
    const info = vi.fn<(message: string) => void>();

    stopAgentForwardPortsForStop("nemohermes", {
      getRegisteredAgent: () => ({
        displayName: "Hermes Agent",
        forward_ports: [18789, 8642, "8642", 0, 80, 70000, "not-a-port"],
      }),
      getAgentDisplayName: (agent) => agent?.displayName ?? "OpenClaw",
      getSandbox: () => ({
        dashboardPort: 18792,
        gatewayName: "nemoclaw-18080",
        gatewayPort: 18080,
      }),
      resolveOpenshell: () => "/usr/local/bin/openshell",
      runOpenshell,
      runCaptureOpenshell,
      confirmPortReleased: () => true,
      info,
    });

    expect(runOpenshell).toHaveBeenCalledTimes(3);
    expect(runOpenshell).toHaveBeenNthCalledWith(
      1,
      ["forward", "stop", "18789", "nemohermes", "--gateway", "nemoclaw-18080"],
      {
        ignoreError: true,
        suppressOutput: true,
      },
    );
    expect(runOpenshell).toHaveBeenNthCalledWith(
      2,
      ["forward", "stop", "8642", "nemohermes", "--gateway", "nemoclaw-18080"],
      {
        ignoreError: true,
        suppressOutput: true,
      },
    );
    expect(runOpenshell).toHaveBeenNthCalledWith(
      3,
      ["forward", "stop", "18792", "nemohermes", "--gateway", "nemoclaw-18080"],
      {
        ignoreError: true,
        suppressOutput: true,
      },
    );
    expect(runCaptureOpenshell).toHaveBeenCalledTimes(3);
    expect(runCaptureOpenshell).toHaveBeenCalledWith(
      ["forward", "list", "--gateway", "nemoclaw-18080"],
      expect.any(Object),
    );
    expect(info.mock.calls.map((call) => call[0]).join("\n")).toContain(
      "Stopped Hermes Agent host port forward 8642",
    );
  });

  it("skips OpenClaw or agents without declared forwards", () => {
    const resolveOpenshell = vi.fn(() => "/usr/local/bin/openshell");
    const runOpenshell = vi.fn();

    stopAgentForwardPortsForStop("openclaw-sandbox", {
      getRegisteredAgent: () => null,
      getSandbox: () => ({ agent: "openclaw", gatewayPort: 8080 }),
      resolveOpenshell,
      runOpenshell,
    });

    stopAgentForwardPortsForStop("empty-agent", {
      getRegisteredAgent: () => ({ displayName: "Empty Agent", forward_ports: [] }),
      getSandbox: () => ({ agent: "empty-agent", gatewayPort: 8080 }),
      resolveOpenshell,
      runOpenshell,
    });

    expect(resolveOpenshell).not.toHaveBeenCalled();
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("leaves forwards alone when OpenShell reports a different owner", () => {
    const runOpenshell = vi.fn();
    const warn = vi.fn<(message: string) => void>();

    stopAgentForwardPortsForStop("nemohermes", {
      getRegisteredAgent: () => ({ displayName: "Hermes Agent", forward_ports: [8642] }),
      getAgentDisplayName: (agent) => agent?.displayName ?? "OpenClaw",
      getSandbox: () => ({ gatewayPort: 8080 }),
      resolveOpenshell: () => "/usr/local/bin/openshell",
      runOpenshell,
      runCaptureOpenshell: () => forwardList([{ sandbox: "other-sandbox", port: 8642 }]),
      warn,
    });

    expect(runOpenshell).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((call) => call[0]).join("\n")).toContain(
      "belongs to another sandbox",
    );
  });

  it("does not stop a forward when ownership cannot be enumerated", () => {
    const runOpenshell = vi.fn();
    const warn = vi.fn<(message: string) => void>();

    stopAgentForwardPortsForStop("nemohermes", {
      getRegisteredAgent: () => ({ displayName: "Hermes Agent", forward_ports: [8642] }),
      getAgentDisplayName: (agent) => agent?.displayName ?? "OpenClaw",
      getSandbox: () => ({ gatewayPort: 8080 }),
      resolveOpenshell: () => "/usr/local/bin/openshell",
      runOpenshell,
      runCaptureOpenshell: () => {
        throw new Error("forward list failed");
      },
      warn,
    });

    expect(runOpenshell).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((call) => call[0]).join("\n")).toContain(
      "Could not enumerate OpenShell forwards",
    );
  });

  it("warns instead of claiming success when the listener remains bound (#6392)", () => {
    const runOpenshell = vi.fn();
    const info = vi.fn<(message: string) => void>();
    const warn = vi.fn<(message: string) => void>();

    stopAgentForwardPortsForStop("nemohermes", {
      getRegisteredAgent: () => ({ displayName: "Hermes Agent", forward_ports: [8642] }),
      getAgentDisplayName: (agent) => agent?.displayName ?? "OpenClaw",
      getSandbox: () => ({ gatewayName: "nemoclaw-18080", gatewayPort: 18080 }),
      resolveOpenshell: () => "/usr/local/bin/openshell",
      runOpenshell,
      runCaptureOpenshell: () => forwardList([{ sandbox: "nemohermes", port: 8642 }]),
      confirmPortReleased: () => false,
      info,
      warn,
    });

    expect(runOpenshell).toHaveBeenCalledWith(
      ["forward", "stop", "8642", "nemohermes", "--gateway", "nemoclaw-18080"],
      expect.any(Object),
    );
    expect(info).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((call) => call[0]).join("\n")).toContain(
      "Could not confirm Hermes Agent host port forward 8642 was released within 5 seconds",
    );
  });

  it("fails closed when the sandbox gateway binding is unavailable", () => {
    const resolveOpenshell = vi.fn(() => "/usr/local/bin/openshell");
    const warn = vi.fn<(message: string) => void>();

    stopAgentForwardPortsForStop("nemohermes", {
      getRegisteredAgent: () => ({ displayName: "Hermes Agent", forward_ports: [8642] }),
      getAgentDisplayName: (agent) => agent?.displayName ?? "OpenClaw",
      getSandbox: () => null,
      resolveOpenshell,
      warn,
    });

    expect(resolveOpenshell).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((call) => call[0]).join("\n")).toContain(
      "cannot safely stop agent host port forwards",
    );
  });

  it("does not fall back to an unrelated onboard session when the registry has no agent", () => {
    const getRegisteredAgent = vi.fn(() => null);
    const resolveOpenshell = vi.fn(() => "/usr/local/bin/openshell");

    stopAgentForwardPortsForStop("openclaw-sandbox", {
      getSandbox: () => ({ agent: "openclaw", gatewayPort: 8080 }),
      getRegisteredAgent,
      resolveOpenshell,
    });

    expect(getRegisteredAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "openclaw", gatewayPort: 8080 }),
    );
    expect(resolveOpenshell).not.toHaveBeenCalled();
  });

  it("fails closed when the sandbox registry cannot be read", () => {
    const getRegisteredAgent = vi.fn();
    const runOpenshell = vi.fn();
    const warn = vi.fn<(message: string) => void>();

    expect(() =>
      stopAgentForwardPortsForStop("nemohermes", {
        getSandbox: () => {
          throw new Error("invalid registry data");
        },
        getRegisteredAgent,
        runOpenshell,
        warn,
      }),
    ).not.toThrow();

    expect(getRegisteredAgent).not.toHaveBeenCalled();
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((call) => call[0]).join("\n")).toContain(
      "Could not read the sandbox registry for 'nemohermes'",
    );
  });

  it.each([
    "../escape",
    "bad name",
    "--gateway",
  ])("rejects malformed sandbox name %j before registry or OpenShell access", (sandboxName) => {
    const getSandbox = vi.fn();
    const resolveOpenshell = vi.fn(() => "/usr/local/bin/openshell");
    const runCaptureOpenshell = vi.fn();
    const runOpenshell = vi.fn();
    const warn = vi.fn<(message: string) => void>();

    stopAgentForwardPortsForStop(sandboxName, {
      getSandbox,
      resolveOpenshell,
      runCaptureOpenshell,
      runOpenshell,
      warn,
    });

    expect(getSandbox).not.toHaveBeenCalled();
    expect(resolveOpenshell).not.toHaveBeenCalled();
    expect(runCaptureOpenshell).not.toHaveBeenCalled();
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Invalid sandbox name"));
  });
});
