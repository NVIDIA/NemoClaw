// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureLiveSandboxForAction, getStatusSandboxes, showStatus } from "../bin/nemoclaw.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("status command", () => {
  it("marks registry sandboxes as stale when OpenShell cannot resolve them", () => {
    const status = getStatusSandboxes({
      listSandboxes: () => ({
        sandboxes: [
          { name: "the-crucible", model: "qwen3.5:9b-64k" },
          { name: "live-box", model: "nvidia/nemotron" },
        ],
        defaultSandbox: "the-crucible",
      }),
      runCapture: (command) => (command.includes("'live-box'") ? "Name: live-box" : ""),
    });

    expect(status.defaultSandbox).toBe("the-crucible");
    expect(status.sandboxes).toEqual([
      { name: "the-crucible", model: "qwen3.5:9b-64k", isLive: false },
      { name: "live-box", model: "nvidia/nemotron", isLive: true },
    ]);
  });

  it("prints stale labels and uses the first live sandbox for service status when the default is stale", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const runMock = vi.fn();

    showStatus({
      listSandboxes: () => ({
        sandboxes: [
          { name: "the-crucible", model: "qwen3.5:9b-64k" },
          { name: "live-box", model: "nvidia/nemotron" },
        ],
        defaultSandbox: "the-crucible",
      }),
      runCapture: (command) => (command.includes("'live-box'") ? "Name: live-box" : ""),
      run: runMock,
    });

    const printed = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(printed).toContain("the-crucible * (qwen3.5:9b-64k) [stale]");
    expect(printed).toContain("live-box (nvidia/nemotron)");
    expect(printed).toContain("OpenShell cannot load it");
    expect(printed).toContain("IDENTITY.md");
    expect(printed).toContain("restore workspace files from backup");
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock.mock.calls[0][0]).toContain('SANDBOX_NAME="live-box" ');
    expect(runMock.mock.calls[0][0]).toContain('start-services.sh" --status');
  });

  it("omits SANDBOX_NAME from service status when every registry sandbox is stale", () => {
    const runMock = vi.fn();

    showStatus({
      listSandboxes: () => ({
        sandboxes: [{ name: "the-crucible", model: "qwen3.5:9b-64k" }],
        defaultSandbox: "the-crucible",
      }),
      runCapture: () => "",
      run: runMock,
    });

    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock.mock.calls[0][0]).not.toContain("SANDBOX_NAME=");
    expect(runMock.mock.calls[0][0]).toContain('start-services.sh" --status');
  });

  it("refuses sandbox actions when the registry entry is stale and explains workspace loss", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const isLive = ensureLiveSandboxForAction("the-crucible", "open the dashboard for", {
      isAvailable: false,
      error: console.error,
    });

    expect(isLive).toBe(false);
    const printed = errorSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(printed).toContain("Sandbox 'the-crucible' is stale");
    expect(printed).toContain("OpenShell cannot open the dashboard for it");
    expect(printed).toContain("IDENTITY.md");
    expect(printed).toContain("restored a backup");
  });
});
