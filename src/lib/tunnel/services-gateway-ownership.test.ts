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

vi.mock("../adapters/docker", () => ({
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

  it("warns without failing stop when gateway release throws", () => {
    const release = vi.fn(() => {
      throw new Error("registry boom");
    });
    const warn = vi.fn<(message: string) => void>();

    expect(() =>
      gatewayStop.releaseGatewayPortForStop("alpha", {
        listSandboxes: sandboxList([{ name: "alpha", gatewayPort: 8080 }]),
        releaseManagedGatewayPort: release,
        warn,
      }),
    ).not.toThrow();

    const output = warn.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toContain("Could not release the NemoClaw gateway port: registry boom");
    expect(output).toContain("repair the sandbox registry and retry");
    expect(output).toContain("NODE_DEBUG=nemoclaw:gateway");
  });

  it("uses inspect-only guidance when release cannot confirm the port is free", () => {
    const warn = vi.fn<(message: string) => void>();

    gatewayStop.releaseGatewayPortForStop("alpha", {
      listSandboxes: sandboxList([{ name: "alpha", gatewayPort: 8080 }]),
      releaseManagedGatewayPort: gatewayRelease(
        releaseResult({ released: false, remaining: [4242] }),
      ),
      warn,
    });

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

    gatewayStop.releaseGatewayPortForStop("alpha", {
      listSandboxes: sandboxList([
        { name: "alpha", gatewayPort: 8080 },
        { name: "beta", gatewayPort: 0 },
      ]),
      releaseManagedGatewayPort: release,
      warn,
    });

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
      });
    const stopAgentForwards = vi
      .spyOn(agentForwardStop, "stopAgentForwardPortsForStop")
      .mockImplementation(() => {
        order.push("host-forwards");
      });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      stopAll({ pidDir, sandboxName: "alpha", releaseGatewayPort: true });
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
      .mockImplementation(() => {});
    const stopAgentForwards = vi
      .spyOn(agentForwardStop, "stopAgentForwardPortsForStop")
      .mockImplementation(() => {});
    vi.spyOn(sandboxGatewayStop, "stopSandboxChannels").mockImplementation(() => {});

    try {
      stopAll({ pidDir, sandboxName: "alpha" });
    } finally {
      rmSync(pidDir, { recursive: true, force: true });
    }

    expect(releaseForStop).not.toHaveBeenCalled();
    expect(stopAgentForwards).not.toHaveBeenCalled();
  });
});
