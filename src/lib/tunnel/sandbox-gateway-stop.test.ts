// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxExecResult } from "../adapters/openshell/sandbox-control";
import type { AgentDefinition } from "../agent/defs";
import type { SandboxEntry } from "../state/registry";
import { GATEWAY_STOP_SCRIPT } from "./gateway-stop-script";
import { type SandboxGatewayStopDeps, stopSandboxChannels } from "./sandbox-gateway-stop";

function execResult(status: number | null, stdout = "", stderr = ""): SandboxExecResult {
  return { status, stdout, stderr };
}

function registeredAgent(
  values: Partial<AgentDefinition> & Pick<AgentDefinition, "name" | "displayName">,
): AgentDefinition {
  return values as AgentDefinition;
}

function sandbox(values: Partial<SandboxEntry> = {}): SandboxEntry {
  return { name: "my-sandbox", ...values };
}

function harness() {
  const getSandbox = vi.fn<NonNullable<SandboxGatewayStopDeps["getSandbox"]>>(() => sandbox());
  const getRegisteredAgent = vi.fn<NonNullable<SandboxGatewayStopDeps["getRegisteredAgent"]>>(
    () => null,
  );
  const exec = vi.fn(async () => execResult(0));
  const close = vi.fn();
  const assertNoGatewayEndpointOverride = vi.fn();
  const selectControl = vi.fn<NonNullable<SandboxGatewayStopDeps["selectControl"]>>(() => ({
    control: { exec },
    transport: "grpc",
    close,
  }));
  const info = vi.fn<(message: string) => void>();
  const warn = vi.fn<(message: string) => void>();
  const deps: SandboxGatewayStopDeps = {
    assertNoGatewayEndpointOverride,
    getSandbox,
    getRegisteredAgent,
    selectControl,
    info,
    warn,
  };
  return {
    assertNoGatewayEndpointOverride,
    close,
    deps,
    exec,
    getRegisteredAgent,
    getSandbox,
    info,
    selectControl,
    warn,
  };
}

describe("stopSandboxChannels", () => {
  it("selects the persisted gateway and sends one bounded stdin request", async () => {
    const h = harness();
    h.getSandbox.mockReturnValue(sandbox({ gatewayName: "nemoclaw-18080", gatewayPort: 18080 }));

    await stopSandboxChannels("my-sandbox", h.deps);

    expect(h.assertNoGatewayEndpointOverride).toHaveBeenCalledTimes(1);
    expect(h.selectControl).toHaveBeenCalledOnce();
    expect(h.selectControl).toHaveBeenCalledWith("nemoclaw-18080");
    expect(h.exec).toHaveBeenCalledOnce();
    expect(h.exec).toHaveBeenCalledWith({
      sandboxName: "my-sandbox",
      command: ["sh", "-s"],
      stdin: GATEWAY_STOP_SCRIPT,
      timeoutMs: 20_000,
      maxOutputBytes: 64 * 1024,
    });
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.assertNoGatewayEndpointOverride.mock.invocationCallOrder[0]).toBeLessThan(
      h.selectControl.mock.invocationCallOrder[0],
    );
    expect(h.selectControl.mock.invocationCallOrder[0]).toBeLessThan(
      h.exec.mock.invocationCallOrder[0],
    );
    expect(h.exec.mock.invocationCallOrder[0]).toBeLessThan(h.close.mock.invocationCallOrder[0]);
  });

  it.each([
    [0, "OpenClaw gateway stopped inside sandbox."],
    [1, "OpenClaw gateway was not running inside sandbox."],
  ])("reports stop script exit %i as success", async (status, message) => {
    const h = harness();
    h.exec.mockResolvedValueOnce(execResult(status));

    await stopSandboxChannels("my-sandbox", h.deps);

    expect(h.info).toHaveBeenCalledWith(message);
    expect(h.warn).not.toHaveBeenCalled();
  });

  it("closes the selected control after an exec failure without replaying", async () => {
    const h = harness();
    h.exec.mockRejectedValueOnce(new Error("connection closed"));

    await stopSandboxChannels("my-sandbox", h.deps);

    expect(h.selectControl).toHaveBeenCalledOnce();
    expect(h.exec).toHaveBeenCalledOnce();
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining("connection closed"));
  });

  it("reports bounded exec failures and closes the selected control", async () => {
    const h = harness();
    h.exec.mockResolvedValueOnce({
      ...execResult(null, "stdout detail", "stderr detail"),
      error: new Error("deadline exceeded"),
    });

    await stopSandboxChannels("my-sandbox", h.deps);

    expect(h.exec).toHaveBeenCalledOnce();
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining("exit unknown"));
    const output = h.warn.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toContain("deadline exceeded");
    expect(output).toContain("stderr detail");
    expect(output).toContain("stdout detail");
    expect(output).toContain("gateway may still be running");
  });

  it.each([
    [0, { error: new Error("stream reset") }, "stream reset"],
    [1, { signal: "SIGTERM" as NodeJS.Signals }, "signal SIGTERM"],
  ])("does not treat exit %i with transport failure state as success", async (status, failure, detail) => {
    const h = harness();
    h.exec.mockResolvedValueOnce({ ...execResult(status), ...failure });

    await stopSandboxChannels("my-sandbox", h.deps);

    expect(h.info).not.toHaveBeenCalledWith(expect.stringMatching(/stopped|not running/u));
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining(detail));
  });

  it("does not select a control when the endpoint guard rejects overrides", async () => {
    const h = harness();
    h.assertNoGatewayEndpointOverride.mockImplementationOnce(() => {
      throw new Error("endpoint override is forbidden");
    });

    await stopSandboxChannels("my-sandbox", h.deps);

    expect(h.selectControl).not.toHaveBeenCalled();
    expect(h.exec).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining("endpoint override is forbidden"));
  });

  it("fails closed before dispatch when mutation control selection fails", async () => {
    const h = harness();
    h.selectControl.mockImplementationOnce(() => {
      throw new Error("direct gRPC configuration unavailable");
    });

    await stopSandboxChannels("my-sandbox", h.deps);

    expect(h.exec).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining("direct gRPC configuration unavailable"),
    );
  });

  it("does not transiently kill a supervisor-managed Hermes gateway (#6392)", async () => {
    const h = harness();
    const hermes = registeredAgent({
      name: "hermes",
      displayName: "Hermes Agent",
      gateway_command: "hermes gateway run",
      forward_ports: [18789, 8642],
    });
    h.getSandbox.mockReturnValue(sandbox({ agent: "hermes" }));
    h.getRegisteredAgent.mockReturnValue(hermes);

    await stopSandboxChannels("my-sandbox", h.deps);

    expect(h.selectControl).not.toHaveBeenCalled();
    expect(h.info.mock.calls.map((call) => call[0]).join("\n")).toContain(
      "Hermes Agent gateway is managed by the sandbox",
    );
  });

  it("does not treat a terminal agent command as a gateway process", async () => {
    const h = harness();
    const terminal = registeredAgent({
      name: "langchain-deepagents-code",
      displayName: "LangChain Deep Agents Code",
      runtime: {
        kind: "terminal",
        interactive_command: "dcode",
        headless_command: "dcode -n",
      },
    });
    h.getSandbox.mockReturnValue(sandbox({ agent: "langchain-deepagents-code" }));
    h.getRegisteredAgent.mockReturnValue(terminal);

    await stopSandboxChannels("dcode-sandbox", h.deps);

    expect(h.selectControl).not.toHaveBeenCalled();
    expect(h.info).toHaveBeenCalledWith(
      "LangChain Deep Agents Code has no gateway runtime; skipping in-sandbox gateway stop.",
    );
  });

  it("requires an exact persisted sandbox record", async () => {
    const h = harness();
    h.getSandbox.mockReturnValue(null);

    await stopSandboxChannels("openclaw-target", h.deps);

    expect(h.getRegisteredAgent).not.toHaveBeenCalled();
    expect(h.selectControl).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(
      "Sandbox 'openclaw-target' is not registered; skipping in-sandbox gateway stop.",
    );
  });

  it("fails closed when the sandbox registry cannot be read", async () => {
    const h = harness();
    h.getSandbox.mockImplementation(() => {
      throw new Error("invalid registry data");
    });

    await expect(stopSandboxChannels("my-sandbox", h.deps)).resolves.toBeUndefined();

    expect(h.getRegisteredAgent).not.toHaveBeenCalled();
    expect(h.selectControl).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not read the sandbox registry for 'my-sandbox'"),
    );
  });

  it("fails closed when the persisted gateway binding is invalid", async () => {
    const h = harness();
    h.getSandbox.mockReturnValue(sandbox({ agent: "openclaw", gatewayPort: 0 }));

    await stopSandboxChannels("my-sandbox", h.deps);

    expect(h.selectControl).not.toHaveBeenCalled();
    expect(h.warn.mock.calls.map((call) => call[0]).join("\n")).toContain(
      "Invalid persisted sandbox gateway binding",
    );
  });

  it("fails closed when a registered non-OpenClaw agent cannot be loaded", async () => {
    const h = harness();
    h.getSandbox.mockReturnValue(sandbox({ agent: "missing-agent" }));

    await stopSandboxChannels("my-sandbox", h.deps);

    expect(h.selectControl).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not resolve registered agent 'missing-agent'"),
    );
  });

  it("warns when sandbox exec reports the gateway may still be running", async () => {
    const h = harness();
    h.exec.mockResolvedValueOnce(execResult(2, "", "205"));

    await stopSandboxChannels("my-sandbox", h.deps);

    const output = h.warn.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toContain("Could not stop OpenClaw gateway inside sandbox");
    expect(output).toContain("gateway may still be running");
    expect(output).toContain("205");
  });

  it("rejects malformed sandbox names before selecting a control", async () => {
    const h = harness();

    await expect(stopSandboxChannels("../escape", h.deps)).rejects.toThrow("Invalid sandbox name");
    expect(h.getSandbox).not.toHaveBeenCalled();
    expect(h.selectControl).not.toHaveBeenCalled();
  });
});
