// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CleanupRegistry } from "../fixtures/cleanup.ts";
import { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { prepareOnboardSandboxes } from "../fixtures/onboard-precleanup.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const state = vi.hoisted(() => ({
  registered: new Set<string>(),
  bindings: new Map<string, string>(),
}));
vi.mock("../../../src/lib/state/registry.ts", () => ({
  getSandbox: (name: string) =>
    state.registered.has(name) ? { name, gatewayName: state.bindings.get(name) } : null,
}));
const names = ["e2e-repair", "e2e-repair-other"] as const;
const response = (patch: Partial<ShellProbeResult> = {}): ShellProbeResult => ({
  command: [],
  exitCode: 0,
  stdout: "",
  stderr: "",
  signal: null,
  timedOut: false,
  artifacts: { stdout: "", stderr: "", result: "" },
  ...patch,
});
function fixture(present = false, gatewayName = "nemoclaw") {
  const calls: string[] = [];
  const gateway = { present };
  const sandbox = new SandboxClient({ run: vi.fn() });
  const inspect = vi.fn(() =>
    gateway.present
      ? response({ stdout: JSON.stringify({ gateway: gatewayName }) })
      : response({
          exitCode: 1,
          stderr:
            "No gateway configured.\n│ Register a gateway with: openshell gateway add <endpoint>",
        }),
  );
  const removeProvider = vi.fn(() => response());
  const handlers: Record<string, () => ShellProbeResult> = {
    gateway: inspect,
    sandbox: () => response(),
    provider: removeProvider,
  };
  const openshell = vi
    .spyOn(sandbox, "openshell")
    .mockImplementation(async (args = [], options) => {
      expect(options?.env?.OPENSHELL_GATEWAY).toBe(gatewayName);
      calls.push(args.slice(0, 2).join(" "));
      return handlers[args[0]]!();
    });
  const host = {
    cleanupSandbox: vi.fn(async (name: string) => {
      calls.push(`destroy ${name}`);
      state.registered.delete(name);
    }),
    command: vi.fn(async (_command?: string, _args?: string[], _options?: unknown) => {
      calls.push("recover gateway");
      gateway.present = true;
      return response();
    }),
    cleanupForward: vi.fn(async () => {
      calls.push("stop forward");
    }),
  };
  const cleanup = new CleanupRegistry();
  const prepare = (selectedNames: readonly string[] = names) =>
    prepareOnboardSandboxes(host, sandbox, cleanup, selectedNames, "e2e-live-extra-provider", {
      artifactName: "precleanup-gateway-inspection",
      env: {
        OPENSHELL_GATEWAY: gatewayName,
        NEMOCLAW_GATEWAY_RUNTIME: "podman",
      },
    });
  return {
    calls,
    host,
    sandbox,
    openshell,
    inspect,
    removeProvider,
    cleanup,
    prepare,
  };
}
beforeEach(() => {
  state.registered.clear();
  state.bindings.clear();
  vi.stubEnv("OPENSHELL_GATEWAY", "nemoclaw");
});
afterEach(() => vi.unstubAllEnvs());

it("does not acquire a gateway or mutate OpenShell resources for fresh unregistered names", async () => {
  const f = fixture();
  await f.prepare();
  expect(f.calls).toEqual(["gateway info", "gateway info", "gateway info"]);
  expect(f.host.command).not.toHaveBeenCalled();
  expect(f.host.cleanupSandbox).not.toHaveBeenCalled();
  expect(f.host.cleanupForward).not.toHaveBeenCalled();
  expect(f.removeProvider).not.toHaveBeenCalled();
});

it("clears retained owned sandboxes before verified gateway ancillary cleanup", async () => {
  const f = fixture(true);
  names.forEach((name) => state.registered.add(name));
  await f.prepare();
  expect(f.calls).toEqual([
    "gateway info",
    "sandbox delete",
    "destroy e2e-repair",
    "gateway info",
    "sandbox delete",
    "destroy e2e-repair-other",
    "gateway info",
    "stop forward",
    "provider delete",
  ]);
  expect(f.host.command).not.toHaveBeenCalled();
  expect(f.openshell).toHaveBeenLastCalledWith(
    ["provider", "delete", "-g", "nemoclaw", "e2e-live-extra-provider"],
    expect.objectContaining({
      env: expect.objectContaining({ NEMOCLAW_GATEWAY_RUNTIME: "podman" }),
    }),
  );
  expect(state.registered.size).toBe(0);
});

it("recovers a retained registration through the existing cleanup owner", async () => {
  const f = fixture();
  state.registered.add(names[0]!);
  await f.prepare();
  expect(f.host.command).toHaveBeenCalledOnce();
  expect(f.calls.slice(0, 5)).toEqual([
    "gateway info",
    "recover gateway",
    "gateway info",
    "sandbox delete",
    "destroy e2e-repair",
  ]);
  expect(f.host.cleanupForward).toHaveBeenCalledOnce();
});

it.each([0, 1, 2, 3, 4])(
  "uses the caller runtime environment for owned cleanup call %s",
  async (index) => {
    vi.stubEnv("NEMOCLAW_GATEWAY_RUNTIME", "docker");
    const f = fixture();
    state.registered.add(names[0]!);
    await prepareOnboardSandboxes(
      f.host,
      f.sandbox,
      f.cleanup,
      [names[0]!],
      "e2e-live-extra-provider",
      {
        env: {
          PATH: "/caller/bin",
          OPENSHELL_GATEWAY: "nemoclaw",
          NEMOCLAW_GATEWAY_RUNTIME: "podman",
          OPENSHELL_PODMAN_SOCKET: "/caller/podman.sock",
          NVIDIA_API_KEY: "excluded-test-secret",
        },
      },
    );
    await f.cleanup.runAll();
    const ownedCalls = f.openshell.mock.calls.filter(([, options]) =>
      options?.artifactName?.includes("delete-openshell-sandbox"),
    );
    expect(ownedCalls).toHaveLength(5);
    expect(ownedCalls[index]?.[1]?.env).toEqual({
      PATH: "/caller/bin",
      NEMOCLAW_GATEWAY_RUNTIME: "podman",
      OPENSHELL_PODMAN_SOCKET: "/caller/podman.sock",
      OPENSHELL_GATEWAY: "nemoclaw",
    });
    expect(f.host.command).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({ NEMOCLAW_GATEWAY_RUNTIME: "podman" }),
      }),
    );
  },
);

it("refuses ambiguous gateway evidence before any resource mutation", async () => {
  const f = fixture();
  f.inspect.mockReturnValue(response({ stdout: JSON.stringify({ gateway: "unrelated" }) }));
  await expect(f.prepare()).rejects.toThrow();
  expect(f.calls).toEqual(["gateway info"]);
  expect(f.host.command).not.toHaveBeenCalled();
  expect(f.host.cleanupForward).not.toHaveBeenCalled();
  expect(f.removeProvider).not.toHaveBeenCalled();
});

it("reports an ancillary provider cleanup failure instead of starting onboarding", async () => {
  const f = fixture(true);
  f.removeProvider.mockReturnValue(response({ exitCode: 1, stderr: "permission denied" }));
  await expect(f.prepare()).rejects.toThrow("cleanup provider e2e-live-extra-provider");
});

it("rejects missing gateway identity before touching retained sandbox state", async () => {
  const f = fixture(true);
  state.registered.add(names[0]!);
  await expect(
    prepareOnboardSandboxes(f.host, f.sandbox, f.cleanup, names, "e2e-live-extra-provider", {}),
  ).rejects.toThrow("requires a named gateway");
  expect(f.calls).toEqual([]);
  expect(f.host.cleanupSandbox).not.toHaveBeenCalled();
  expect(f.host.command).not.toHaveBeenCalled();
});

it("prepares the resume scenario's single owned sandbox", async () => {
  const f = fixture(true);
  state.registered.add(names[0]!);
  await f.prepare([names[0]!]);
  expect(f.calls).toEqual([
    "gateway info",
    "sandbox delete",
    "destroy e2e-repair",
    "gateway info",
    "stop forward",
    "provider delete",
  ]);
  expect(f.host.cleanupSandbox).toHaveBeenCalledOnce();
});

it("uses the caller's nondefault gateway for unregistered orphan cleanup in both phases", async () => {
  const f = fixture(true, "nemoclaw-8888");
  await f.prepare();
  await f.cleanup.runAll();
  expect(f.openshell.mock.calls.filter(([args]) => args?.[0] === "sandbox")).toHaveLength(4);
  expect(f.host.command).not.toHaveBeenCalled();
  expect(f.host.cleanupSandbox).not.toHaveBeenCalled();
});

it("uses retained gateway authority for orphan and ancillary cleanup", async () => {
  const f = fixture(true, "nemoclaw-8111");
  state.registered.add(names[0]);
  state.bindings.set(names[0], "nemoclaw-8111");
  await prepareOnboardSandboxes(f.host, f.sandbox, f.cleanup, names, "e2e-live-extra-provider", {
    env: {
      OPENSHELL_GATEWAY: "nemoclaw-8222",
      NEMOCLAW_GATEWAY_RUNTIME: "podman",
    },
  });
  expect(f.host.cleanupForward).toHaveBeenCalledWith(
    18789,
    expect.objectContaining({
      env: expect.objectContaining({
        OPENSHELL_GATEWAY: "nemoclaw-8111",
        NEMOCLAW_GATEWAY_RUNTIME: "podman",
      }),
    }),
  );
  expect(f.openshell).toHaveBeenLastCalledWith(
    ["provider", "delete", "-g", "nemoclaw-8111", "e2e-live-extra-provider"],
    expect.objectContaining({
      env: expect.objectContaining({ OPENSHELL_GATEWAY: "nemoclaw-8111" }),
    }),
  );
});

it.each(["nemoclaw-8333", "../invalid"])(
  "rejects inconsistent or invalid retained gateway %s before mutation",
  async (second) => {
    const f = fixture(true, "nemoclaw-8111");
    names.forEach((name) => state.registered.add(name));
    state.bindings.set(names[0], "nemoclaw-8111");
    state.bindings.set(names[1], second);
    await expect(f.prepare()).rejects.toThrow();
    expect(f.calls).toEqual([]);
  },
);
