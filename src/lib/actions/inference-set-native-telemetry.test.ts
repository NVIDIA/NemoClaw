// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const telemetry = vi.hoisted(() => ({
  targets: [] as Array<{ sandboxName?: string; outcome: string; state: string }>,
}));

vi.mock("./telemetry/operation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./telemetry/operation")>()),
  recordTelemetryTarget: (receipt: (typeof telemetry.targets)[number]) => {
    telemetry.targets.push(receipt);
  },
  getTelemetryTarget: (sandboxName: string) =>
    [...telemetry.targets].reverse().find((receipt) => receipt.sandboxName === sandboxName) ?? null,
}));
vi.mock("../onboard/experimental/portable-agent-lifecycle", async (importOriginal) => ({
  ...(await importOriginal()),
  assertHermesPortableCommandUnavailable: vi.fn(),
}));

import type { SandboxEntry } from "../state/registry";
import { runInferenceSet } from "./inference-set";
import {
  baseSession,
  createDeps,
  HERMES_TARGET,
  OPENCLAW_TARGET,
} from "../../../test/helpers/inference-set";

const AUTHORITY = {
  schemaVersion: 1 as const,
  profileId: "nemoclaw-nvidia-inference-v1" as const,
  providerName: "nemoclaw-nvidia-prod-v1" as const,
  providerId: "provider-id",
};

function nativeDeps(agent: "hermes" | "openclaw") {
  return createDeps({
    config: {},
    entry: {
      name: agent,
      agent,
      gatewayName: "nemoclaw",
      provider: "nvidia-prod",
      model: "nvidia/test-model",
      nativeNvidiaProviderAttachment: AUTHORITY,
    },
    getNativeNvidiaProviderAuthority: () => AUTHORITY,
    defaultSandbox: agent,
    target: agent === "hermes" ? HERMES_TARGET : OPENCLAW_TARGET,
    session: baseSession({ agent, sandboxName: agent }),
  });
}

describe("inference set telemetry for native NVIDIA selections (#13598)", () => {
  beforeEach(() => {
    telemetry.targets.length = 0;
  });

  it.each(["hermes", "openclaw"] as const)(
    "reports no_change when %s repeats the active native selection",
    async (agent) => {
      const deps = nativeDeps(agent);
      const request = { provider: "nvidia-prod", model: "nvidia/test-model", sandboxName: agent };
      await runInferenceSet({ ...request, noVerify: true }, deps);
      telemetry.targets.length = 0;
      deps.calls.restartSandboxGateway.mockClear();

      await runInferenceSet({ ...request, noVerify: true }, deps);

      expect(telemetry.targets.at(-1)).toMatchObject({
        sandboxName: agent,
        outcome: "no_change",
        state: "unchanged",
      });
      expect(deps.calls.restartSandboxGateway).not.toHaveBeenCalled();
    },
  );

  it("reports completed when a repeated native selection repairs its attachment", async () => {
    const deps = nativeDeps("openclaw");
    const adapter = deps.providerAdapter;
    let attached = false;
    deps.providerAdapter = {
      ...adapter,
      listProviderAttachments: vi.fn(async () => ({
        ok: true as const,
        value: { names: attached ? [AUTHORITY.providerName] : [] },
      })),
      attachProvider: vi.fn(async () => {
        attached = true;
        return { ok: true as const };
      }),
    };

    await runInferenceSet(
      {
        provider: "nvidia-prod",
        model: "nvidia/test-model",
        sandboxName: "openclaw",
        noVerify: true,
      },
      deps,
    );

    expect(telemetry.targets.at(-1)).toMatchObject({
      sandboxName: "openclaw",
      outcome: "completed",
      state: "applied",
    });
  });

  it("restarts Hermes on retry after an interrupted attachment repair", async () => {
    const entry: SandboxEntry = {
      name: "hermes",
      agent: "hermes",
      gatewayName: "nemoclaw",
      provider: "nvidia-prod",
      model: "nvidia/test-model",
      nativeNvidiaProviderAttachment: AUTHORITY,
    };
    let registryWrites = 0;
    let attached = false;
    const deps = createDeps({
      config: {},
      entry,
      // The second registry write follows the attachment commit; fail it like a stopped process.
      updateSandbox: (_name, updates) => {
        registryWrites += 1;
        const interrupted = registryWrites === 2;
        Object.assign(entry, interrupted ? {} : updates);
        return !interrupted;
      },
      getNativeNvidiaProviderAuthority: () => AUTHORITY,
      defaultSandbox: "hermes",
      target: HERMES_TARGET,
      session: baseSession({ agent: "hermes", sandboxName: "hermes" }),
    });
    deps.providerAdapter = {
      ...deps.providerAdapter,
      listProviderAttachments: vi.fn(async () => ({
        ok: true as const,
        value: { names: attached ? [AUTHORITY.providerName] : [] },
      })),
      attachProvider: vi.fn(async () => {
        attached = true;
        return { ok: true as const };
      }),
    };
    const request = {
      provider: "nvidia-prod",
      model: "nvidia/test-model",
      sandboxName: "hermes",
      noVerify: true,
    };

    await expect(runInferenceSet(request, deps)).rejects.toThrow(/registry/);
    expect(attached).toBe(true);
    expect(entry.hermesGatewayRestartPending).toBe(true);
    expect(deps.calls.restartSandboxGateway).not.toHaveBeenCalled();

    await runInferenceSet(request, deps);

    expect(deps.calls.restartSandboxGateway).toHaveBeenCalledTimes(1);
    expect(entry.hermesGatewayRestartPending).toBeUndefined();
  });

  it("reports completed when a native selection changes the model", async () => {
    const deps = nativeDeps("hermes");
    await runInferenceSet(
      {
        provider: "nvidia-prod",
        model: "nvidia/test-model",
        sandboxName: "hermes",
        noVerify: true,
      },
      deps,
    );
    telemetry.targets.length = 0;

    await runInferenceSet(
      {
        provider: "nvidia-prod",
        model: "nvidia/other-model",
        sandboxName: "hermes",
        noVerify: true,
      },
      deps,
    );

    expect(telemetry.targets.at(-1)).toMatchObject({
      sandboxName: "hermes",
      outcome: "completed",
      state: "applied",
    });
  });
});
