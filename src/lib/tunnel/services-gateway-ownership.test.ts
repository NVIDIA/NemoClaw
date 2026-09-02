// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../state/registry";
import * as agentForwardStop from "./agent-forward-stop";
import type { ReleaseGatewayPortResult } from "./gateway-port-release";
import type { GatewayStopDeps } from "./gateway-stop";
import * as gatewayStop from "./gateway-stop";
import * as sandboxGatewayStop from "./sandbox-gateway-stop";
import { stopAll } from "./services";

const neutralOllamaCleanup = () => undefined;

vi.mock("../adapters/docker", () => ({
  dockerCapture: vi.fn(),
  dockerForceRm: vi.fn(),
  dockerRunDetached: vi.fn(),
  dockerSpawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "" })),
}));

vi.mock("../adapters/openshell/resolve", () => ({
  resolveOpenshell: vi.fn(() => null),
}));

function sandboxList(sandboxes: SandboxEntry[]): NonNullable<GatewayStopDeps["listSandboxes"]> {
  return vi.fn(() => ({ sandboxes, defaultSandbox: sandboxes[0]?.name ?? null }));
}

function releaseResult(
  overrides: Partial<ReleaseGatewayPortResult> = {},
): ReleaseGatewayPortResult {
  return {
    port: 8080,
    released: true,
    stopped: [],
    remaining: [],
    scanned: true,
    skipped: false,
    ...overrides,
  };
}

function gatewayRelease(
  result: ReleaseGatewayPortResult = releaseResult(),
): NonNullable<GatewayStopDeps["releaseManagedGatewayPort"]> {
  return vi.fn(() => result);
}

describe("releaseGatewayPortForStop", () => {
  it("keeps the host gateway when another registered sandbox shares its port", () => {
    const release = gatewayRelease();
    const info = vi.fn<(message: string) => void>();

    gatewayStop.releaseGatewayPortForStop("alpha", {
      listSandboxes: sandboxList([
        { name: "alpha", gatewayName: "nemoclaw", gatewayPort: 8080 },
        { name: "beta", gatewayName: "nemoclaw", gatewayPort: 8080 },
      ]),
      releaseManagedGatewayPort: release,
      info,
    });

    expect(release).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      "Keeping shared NemoClaw gateway port 8080 running for registered sandbox 'beta'.",
    );
  });

  it("releases the host gateway for the only registered sandbox", () => {
    const release = gatewayRelease();

    gatewayStop.releaseGatewayPortForStop("alpha", {
      listSandboxes: sandboxList([{ name: "alpha", gatewayName: "nemoclaw", gatewayPort: 8080 }]),
      releaseManagedGatewayPort: release,
    });

    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith({ sandboxName: "alpha" });
  });

  it("releases only the selected port when another sandbox uses a different gateway", () => {
    const release = gatewayRelease();

    gatewayStop.releaseGatewayPortForStop("alpha", {
      listSandboxes: sandboxList([
        { name: "alpha", gatewayName: "nemoclaw", gatewayPort: 8080 },
        { name: "beta", gatewayName: "nemoclaw-18080", gatewayPort: 18080 },
      ]),
      releaseManagedGatewayPort: release,
    });

    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith({ sandboxName: "alpha" });
  });

  it("does not resolve or release a process-wide default without a sandbox name", () => {
    const listSandboxes = sandboxList([]);
    const release = gatewayRelease();

    gatewayStop.releaseGatewayPortForStop(undefined, {
      listSandboxes,
      releaseManagedGatewayPort: release,
    });

    expect(listSandboxes).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("releases an explicit NEMOCLAW_GATEWAY_PORT when no sandbox name is available (#8952)", () => {
    const release = gatewayRelease(releaseResult({ port: 8814, stopped: [99] }));
    const warn = vi.fn<(message: string) => void>();

    const outcome = gatewayStop.releaseGatewayPortForStop(undefined, {
      env: { NEMOCLAW_GATEWAY_PORT: "8814" },
      listSandboxes: sandboxList([]),
      releaseManagedGatewayPort: release,
      warn,
    });

    expect(outcome).toBe("attempted");
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(
      { port: 8814 },
      expect.objectContaining({ env: { NEMOCLAW_GATEWAY_PORT: "8814" } }),
    );
  });

  it("does not release when NEMOCLAW_GATEWAY_PORT is set but not a usable port (#8952)", () => {
    const release = gatewayRelease(releaseResult({ port: 8814, stopped: [99] }));

    const outcome = gatewayStop.releaseGatewayPortForStop(undefined, {
      env: { NEMOCLAW_GATEWAY_PORT: "not-a-port" },
      listSandboxes: sandboxList([]),
      releaseManagedGatewayPort: release,
    });

    expect(outcome).toBe("not-scoped");
    expect(release).not.toHaveBeenCalled();
  });

  it("warns without failing stop when gateway release throws", () => {
    const release = vi.fn(() => {
      throw new Error("registry boom");
    });
    const warn = vi.fn<(message: string) => void>();

    const outcome = gatewayStop.releaseGatewayPortForStop("alpha", {
      listSandboxes: sandboxList([{ name: "alpha", gatewayPort: 8080 }]),
      releaseManagedGatewayPort: release,
      warn,
    });

    expect(outcome).toBe("unconfirmed");
    const output = warn.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toContain("Could not release the NemoClaw gateway port: registry boom");
    expect(output).toContain("repair the sandbox registry and retry");
    expect(output).toContain("NODE_DEBUG=nemoclaw:gateway");
  });

  it("uses inspect-only guidance when release cannot confirm the port is free", () => {
    const warn = vi.fn<(message: string) => void>();

    const outcome = gatewayStop.releaseGatewayPortForStop("alpha", {
      listSandboxes: sandboxList([{ name: "alpha", gatewayPort: 8080 }]),
      releaseManagedGatewayPort: gatewayRelease(
        releaseResult({ released: false, remaining: [4242] }),
      ),
      warn,
    });

    expect(outcome).toBe("unconfirmed");
    const output = warn.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toContain("gateway port 8080 was not confirmed released");
    expect(output).not.toContain("4242");
    expect(output).not.toContain("pkill");
    expect(output).toContain("only if it is the matching gateway process");
  });

  it("does not duplicate the release helper warning for an invalid binding", () => {
    const warn = vi.fn<(message: string) => void>();

    gatewayStop.releaseGatewayPortForStop("alpha", {
      listSandboxes: sandboxList([{ name: "alpha", gatewayPort: 8080 }]),
      releaseManagedGatewayPort: gatewayRelease(
        releaseResult({ port: null, released: false, scanned: false, skipped: true }),
      ),
      warn,
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("fails closed when a peer has an invalid gateway binding", () => {
    const release = gatewayRelease();
    const warn = vi.fn<(message: string) => void>();

    const outcome = gatewayStop.releaseGatewayPortForStop("alpha", {
      listSandboxes: sandboxList([
        { name: "alpha", gatewayPort: 8080 },
        { name: "beta", gatewayPort: 0 },
      ]),
      releaseManagedGatewayPort: release,
      warn,
    });

    expect(outcome).toBe("unconfirmed");
    expect(release).not.toHaveBeenCalled();
    const output = warn.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toContain("Invalid persisted sandbox gateway for peer 'beta'");
    expect(output).toContain("repair the sandbox registry and retry");
    expect(output).toContain("NODE_DEBUG=nemoclaw:gateway");
  });
});

describe("stopAll gateway-stop wiring", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("orders supervised-agent full stop as sandbox guard, forwards, then gateway release", () => {
    const pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-gateway-stop-wiring-"));
    vi.stubEnv("PATH", "");
    const order: string[] = [];
    const stopSandboxGateway = vi
      .spyOn(sandboxGatewayStop, "stopSandboxChannels")
      .mockImplementation((_sandboxName, deps) => {
        order.push("sandbox-guard");
        deps?.info?.(
          "Hermes Agent gateway is managed by the sandbox; leaving it running while host forwards stop.",
        );
      });
    const releaseForStop = vi
      .spyOn(gatewayStop, "releaseGatewayPortForStop")
      .mockImplementation(() => {
        order.push("gateway-release");
        return "attempted";
      });
    const stopAgentForwards = vi
      .spyOn(agentForwardStop, "stopAgentForwardPortsForStop")
      .mockImplementation(() => {
        order.push("host-forwards");
      });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      stopAll({
        pidDir,
        sandboxName: "alpha",
        releaseGatewayPort: true,
        unloadOllamaModels: neutralOllamaCleanup,
      });
    } finally {
      rmSync(pidDir, { recursive: true, force: true });
    }

    expect(stopSandboxGateway).toHaveBeenCalledWith("alpha", {
      info: expect.any(Function),
      warn: expect.any(Function),
    });
    expect(stopAgentForwards).toHaveBeenCalledWith("alpha", {
      info: expect.any(Function),
      warn: expect.any(Function),
    });
    expect(releaseForStop).toHaveBeenCalledWith("alpha", {
      info: expect.any(Function),
      warn: expect.any(Function),
    });
    expect(order).toEqual(["sandbox-guard", "host-forwards", "gateway-release"]);
    const output = logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(output).toContain("Hermes Agent gateway is managed by the sandbox");
    expect(output).toContain("All services stopped");
  });

  it("preserves the shared gateway for canonical tunnel-only stop", () => {
    const pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-tunnel-stop-wiring-"));
    vi.stubEnv("PATH", "");
    const releaseForStop = vi
      .spyOn(gatewayStop, "releaseGatewayPortForStop")
      .mockImplementation(() => "attempted");
    const stopAgentForwards = vi
      .spyOn(agentForwardStop, "stopAgentForwardPortsForStop")
      .mockImplementation(() => {});
    vi.spyOn(sandboxGatewayStop, "stopSandboxChannels").mockImplementation(() => {});

    try {
      stopAll({ pidDir, sandboxName: "alpha", unloadOllamaModels: neutralOllamaCleanup });
    } finally {
      rmSync(pidDir, { recursive: true, force: true });
    }

    expect(releaseForStop).not.toHaveBeenCalled();
    expect(stopAgentForwards).not.toHaveBeenCalled();
  });

  it("releases an explicit gateway port on full stop even without a sandbox name (#8952)", () => {
    const pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-orphan-gateway-stop-"));
    vi.stubEnv("PATH", "");
    const releaseForStop = vi
      .spyOn(gatewayStop, "releaseGatewayPortForStop")
      .mockImplementation(() => "attempted");
    const stopAgentForwards = vi
      .spyOn(agentForwardStop, "stopAgentForwardPortsForStop")
      .mockImplementation(() => {});
    vi.spyOn(sandboxGatewayStop, "stopSandboxChannels").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      stopAll({
        pidDir,
        releaseGatewayPort: true,
        unloadOllamaModels: neutralOllamaCleanup,
      });
    } finally {
      rmSync(pidDir, { recursive: true, force: true });
    }

    expect(stopAgentForwards).not.toHaveBeenCalled();
    expect(releaseForStop).toHaveBeenCalledWith(undefined, {
      info: expect.any(Function),
      warn: expect.any(Function),
    });
    expect(logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n")).toContain(
      "All services stopped",
    );
  });

  it("does not claim every service stopped when no gateway scope exists (#8952)", () => {
    const pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-unscoped-gateway-stop-"));
    vi.stubEnv("PATH", "");
    vi.spyOn(gatewayStop, "releaseGatewayPortForStop").mockImplementation(() => "not-scoped");
    vi.spyOn(agentForwardStop, "stopAgentForwardPortsForStop").mockImplementation(() => {});
    vi.spyOn(sandboxGatewayStop, "stopSandboxChannels").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      stopAll({
        pidDir,
        releaseGatewayPort: true,
        unloadOllamaModels: neutralOllamaCleanup,
      });
    } finally {
      rmSync(pidDir, { recursive: true, force: true });
    }

    const logged = logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(logged).not.toContain("All services stopped");
    expect(logged).toContain("managed gateway not released");
    expect(logged).toContain("NEMOCLAW_GATEWAY_PORT");
  });

  it("does not claim every service stopped when gateway release is unconfirmed (#8952)", () => {
    const pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-unconfirmed-gateway-stop-"));
    vi.stubEnv("PATH", "");
    vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "8814");
    vi.spyOn(gatewayStop, "releaseGatewayPortForStop").mockImplementation(() => "unconfirmed");
    vi.spyOn(agentForwardStop, "stopAgentForwardPortsForStop").mockImplementation(() => {});
    vi.spyOn(sandboxGatewayStop, "stopSandboxChannels").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      stopAll({
        pidDir,
        releaseGatewayPort: true,
        unloadOllamaModels: neutralOllamaCleanup,
      });
    } finally {
      rmSync(pidDir, { recursive: true, force: true });
    }

    const logged = logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(logged).not.toContain("All services stopped");
    expect(logged).toContain("managed gateway release was not confirmed");
  });
});
