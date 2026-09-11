// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fullE2eGateway } from "../fixtures/full-e2e-gateway.ts";

const directories: string[] = [];
const disposables: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposables.splice(0).reverse()) await dispose();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true });
  vi.unstubAllEnvs();
});

const captured = vi.hoisted(() => ({ test: vi.fn() }));
vi.mock("../fixtures/e2e-test.ts", async () => ({
  expect: (await import("vitest")).expect,
  test: captured.test,
}));
vi.mock("../fixtures/runtime-provider.ts", () => ({
  ensureConfiguredRuntimeProviderAvailable: vi.fn(),
}));
vi.mock("../fixtures/hosted-inference.ts", () => ({
  requireHostedInferenceConfig: () => ({
    apiKey: "fixture-key",
    endpointUrl: "https://example.com/v1",
    model: "fixture-model",
    env: {},
  }),
  buildHostedInferenceModelsProbe: vi.fn(),
  stagePortableHostedInferenceDescriptor: vi.fn(),
}));
function declaration(
  value: unknown = {
    version: 1,
    mode: "externally-supervised",
    endpoint: "https://127.0.0.1:18080",
    stateDir: "/var/lib/brev/openshell-gateway",
    supervisor: {
      kind: "systemd-system",
      serviceName: "openshell-gateway.service",
      execPath: "/usr/local/bin/openshell-gateway",
    },
    requiredCapabilities: ["gateway.health", "sandbox.create", "sandbox.exec"],
  },
  endpoint?: string,
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "full-e2e-gateway-"));
  directories.push(directory);
  const file = path.join(directory, "gateway.json");
  fs.writeFileSync(
    file,
    JSON.stringify(endpoint === undefined ? value : { ...(value as object), endpoint }),
  );
  return { NEMOCLAW_GATEWAY_MANAGEMENT: file };
}

describe("full E2E gateway ownership", () => {
  it.each([
    { preinstalled: true, targetId: "staging-brev-launchable", measuresColdOnboard: false },
    { preinstalled: false, targetId: "staging-brev-launchable", measuresColdOnboard: false },
    { preinstalled: false, targetId: "full-e2e", measuresColdOnboard: true },
  ])(
    "respects cleanup and budget contracts for $targetId (preinstalled=$preinstalled) (#9851)",
    async ({ preinstalled, targetId, measuresColdOnboard }) => {
      vi.resetModules();
      captured.test.mockClear();
      vi.stubEnv(
        "NEMOCLAW_E2E_SETUP_MODE",
        preinstalled ? "preinstalled-launchable" : "source-install",
      );
      vi.stubEnv("E2E_TARGET_ID", targetId);
      vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "");
      vi.stubEnv("NEMOCLAW_GATEWAY_MANAGEMENT", declaration().NEMOCLAW_GATEWAY_MANAGEMENT);
      const result = { exitCode: 0, stdout: "", stderr: "", timedOut: false, signal: null };
      const host = {
        command: vi.fn(async (command: string) => ({
          ...result,
          exitCode: command === "brev-quickstart" || command === "bash" ? 42 : 0,
        })),
      };
      const sandbox = { openshell: vi.fn(async () => result), cleanupSandbox: vi.fn() };
      const cleanup = {
        trackGateway: vi.fn(),
        trackDisposable: vi.fn((_name: string, dispose: () => Promise<void>) => {
          disposables.push(dispose);
        }),
        trackSandbox: vi.fn(),
      };
      const lifecycle = { trackInstallerGatewayUserService: vi.fn() };
      const declare = vi.fn();
      await import("../live/full-e2e.test.ts");
      const run = captured.test.mock.calls[0]![2] as (input: object) => Promise<void>;
      await expect(
        run({
          host,
          sandbox,
          cleanup,
          lifecycle,
          artifacts: { target: { declare } },
          progress: { phase: vi.fn() },
        }),
      ).rejects.toThrow();
      expect(host.command.mock.calls.map((call) => call[0])).toContain(
        preinstalled ? "brev-quickstart" : "bash",
      );
      expect(cleanup.trackGateway).toHaveBeenCalledTimes(preinstalled ? 0 : 1);
      expect(lifecycle.trackInstallerGatewayUserService).toHaveBeenCalledTimes(
        preinstalled ? 0 : 1,
      );
      const calls = sandbox.openshell.mock.calls as unknown as [
        string[],
        { env: NodeJS.ProcessEnv },
      ][];
      expect(calls.some(([args]) => args[0] === "gateway")).toBe(!preinstalled);
      expect(calls[0]![1].env.OPENSHELL_GATEWAY).toBe(preinstalled ? "nemoclaw-18080" : "nemoclaw");
      expect(
        declare.mock.calls[0]![0].contracts.includes(
          "cold onboarding stays within the checked-in full-E2E performance budgets",
        ),
      ).toBe(measuresColdOnboard);
    },
    20_000,
  );

  it.each(["https://127.0.0.1:18080", "http://127.0.0.1:18080", "https://[::1]:18080"])(
    "targets the declared Launchable gateway at %s without cleanup ownership (#9851)",
    (endpoint) => {
      const env = declaration(undefined, endpoint);
      expect(fullE2eGateway(true, env)).toEqual({
        owned: false,
        env: {
          ...env,
          NEMOCLAW_GATEWAY_PORT: "18080",
          OPENSHELL_GATEWAY: "nemoclaw-18080",
        },
      });
    },
  );
  it.each(["https://127.0.0.1", "http://127.0.0.1", "https://127.0.0.1:1023"])(
    "preserves the CLI port restriction for the declared endpoint %s (#9851)",
    (endpoint) => {
      expect(() => fullE2eGateway(true, declaration(undefined, endpoint))).toThrow("Invalid port");
    },
  );
  it("retains source-install gateway ownership and respects its selected port (#9851)", () => {
    expect(fullE2eGateway(false, {})).toEqual({
      owned: true,
      env: { OPENSHELL_GATEWAY: "nemoclaw" },
    });
    expect(fullE2eGateway(false, { NEMOCLAW_GATEWAY_PORT: "19090" })).toEqual({
      owned: true,
      env: { OPENSHELL_GATEWAY: "nemoclaw-19090" },
    });
  });
  it("refuses conflicting Launchable ports before cleanup can be registered (#9851)", () => {
    expect(() => fullE2eGateway(true, { ...declaration(), NEMOCLAW_GATEWAY_PORT: "8080" })).toThrow(
      "conflicts with its declaration",
    );
  });
  it("rejects malformed explicit port overrides before registering cleanup (#9851)", () => {
    expect(() =>
      fullE2eGateway(true, { ...declaration(), NEMOCLAW_GATEWAY_PORT: "0x46a0" }),
    ).toThrow("Invalid port");
  });
  it("refuses absent or malformed Launchable declarations (#9851)", () => {
    expect(() =>
      fullE2eGateway(true, { NEMOCLAW_GATEWAY_MANAGEMENT: "/nonexistent/gateway.json" }),
    ).toThrow("could not be read");
    expect(() => fullE2eGateway(true, declaration({ version: 99 }))).toThrow(
      "unsupported gateway-management contract version",
    );
  });
  it("does not interpret a managed declaration as Launchable cleanup authority (#9851)", () => {
    expect(() =>
      fullE2eGateway(true, declaration({ version: 1, mode: "nemoclaw-managed" })),
    ).toThrow("externally supervised gateway");
  });
});
