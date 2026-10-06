// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ConfigObject } from "../security/credential-filter";
import type { SandboxEntry } from "../state/registry/types";
import { runInferenceSet } from "./inference-set";
import {
  completeInferencePostCommit,
  type InferenceMutation,
} from "./inference-set-gateway-restart";
import { baseSession, createDeps } from "./inference-set.test-support";

const model = "Qwen/Qwen3.6-27B-FP8";
const options = { sandboxName: "alpha", provider: "nvidia-prod", model, noVerify: true };
const committedWithoutPairing: InferenceMutation<{
  sandboxName: string;
  provider: string;
  model: string;
  primaryModelRef: string;
  inSandboxConfigSynced: boolean;
}> = {
  result: {
    sandboxName: "alpha",
    provider: "nvidia-prod",
    model,
    primaryModelRef: `inference/${model}`,
    inSandboxConfigSynced: true,
  },
  openClawConfigSyncPending: true,
  openClawGatewayRestartRequired: false,
  openClawPairing: { state: "not-required" },
};

function configuration(): ConfigObject {
  return {
    agents: { defaults: { model: { primary: "inference/nvidia/old-model" } } },
    models: {
      providers: {
        inference: {
          api: "openai-completions",
          models: [{ id: "nvidia/old-model", name: "inference/nvidia/old-model" }],
        },
      },
    },
  };
}

function setup() {
  // This target intentionally is not the default, and its old omitted agent
  // needs the successful command's explicit OpenClaw config target as proof.
  const target: SandboxEntry = {
    name: "alpha",
    agent: null,
    provider: "nvidia-prod",
    model: "nvidia/old-model",
    endpointUrl: "https://private.example.invalid/v1",
    credentialEnv: "PRIVATE_CREDENTIAL_KEY",
  };
  const other: SandboxEntry = {
    name: "beta",
    agent: "hermes",
    model: "private/default-model",
    gatewayName: "nemoclaw-9091",
    gatewayPort: 9091,
  };
  const order: string[] = [];
  const deps = createDeps({
    config: configuration(),
    entries: [target, other],
    defaultSandbox: "beta",
    session: baseSession(),
    updateSandbox: (name, updates) => {
      expect(name).toBe("alpha");
      order.push("registry-update");
      Object.assign(target, updates);
      return true;
    },
    restartSandboxGateway: async () => {
      order.push("restart");
      return { ok: true, restarted: true, healthPassed: true, forwardRecovered: true };
    },
    settleOpenClawPairing: () => {
      order.push("pairing");
      return { ok: true };
    },
    sendConfigurationTelemetry: async (_operation, loadSnapshot) => {
      order.push("telemetry");
      expect(target.openClawConfigSyncPending).toBeUndefined();
      const snapshot = loadSnapshot();
      expect(snapshot).toMatchObject({
        agentHarnessId: "openclaw",
        agentHarnessStatus: "reported",
        modelId: model,
        modelStatus: "reported",
        providerProfile: "nvidia",
        apiFamily: "openai-completions",
        sandboxOS: "unknown",
      });
      const serialized = JSON.stringify(snapshot);
      expect(serialized).not.toContain("alpha");
      expect(serialized).not.toContain("beta");
      expect(serialized).not.toContain("private");
      expect(serialized).not.toContain("PRIVATE_CREDENTIAL_KEY");
      return "delivered";
    },
  });
  return { deps, order, target, other };
}

type TelemetryTestDeps = ReturnType<typeof setup>["deps"];
const postSelectionFailures: readonly {
  name: string;
  arrange: (deps: TelemetryTestDeps) => void;
}[] = [
  {
    name: "config",
    arrange: (deps) => {
      deps.calls.setOpenClawConfigValues.mockImplementationOnce(() => {
        throw new Error("config failure");
      });
    },
  },
  {
    name: "session",
    arrange: (deps) => {
      deps.calls.updateSession.mockImplementationOnce(() => {
        throw new Error("session failure");
      });
    },
  },
  {
    name: "restart",
    arrange: (deps) => {
      deps.calls.restartSandboxGateway.mockImplementationOnce(async () => {
        throw new Error("restart failure");
      });
    },
  },
  {
    name: "pairing",
    arrange: (deps) => {
      deps.calls.settleOpenClawPairing.mockReturnValueOnce({
        ok: false,
        failureLayer: "final-state-unsettled",
      });
    },
  },
  {
    name: "pending-clear",
    arrange: (deps) => {
      const update = deps.calls.updateSandbox.getMockImplementation()!;
      deps.calls.updateSandbox.mockImplementation((name, updates) =>
        Object.hasOwn(updates, "openClawConfigSyncPending") &&
        updates.openClawConfigSyncPending === undefined
          ? false
          : update(name, updates),
      );
    },
  },
];

describe("inference set configuration telemetry", () => {
  it("completes pending clearance and reporting when pairing is not required (#10448)", async () => {
    const { deps, target, order } = setup();
    Object.assign(target, {
      model,
      preferredInferenceApi: "openai-completions",
      openClawConfigSyncPending: true,
    });
    await completeInferencePostCommit(committedWithoutPairing, deps, {
      sandboxName: "alpha",
      configurationChanged: true,
      agentName: "openclaw",
      getSandbox: deps.getSandbox,
      updateSandbox: deps.updateSandbox,
    });
    expect(order).toEqual(["registry-update", "telemetry"]);
    expect(deps.calls.restartSandboxGateway).not.toHaveBeenCalled();
    expect(deps.calls.settleOpenClawPairing).not.toHaveBeenCalled();
  });

  it("does not clear or report for standalone convergence without committed-target authority (#10448)", async () => {
    const { deps } = setup();
    await completeInferencePostCommit(committedWithoutPairing, deps);
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.sendConfigurationTelemetry).not.toHaveBeenCalled();
  });

  it("rejects a completion target that differs from the lifecycle-locked target (#10448)", async () => {
    const { deps } = setup();
    await expect(
      completeInferencePostCommit(committedWithoutPairing, deps, {
        sandboxName: "beta",
        configurationChanged: true,
        agentName: "openclaw",
        getSandbox: deps.getSandbox,
        updateSandbox: deps.updateSandbox,
      }),
    ).rejects.toThrow("does not match its lifecycle lock");
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.sendConfigurationTelemetry).not.toHaveBeenCalled();
  });

  it("reports the exact committed target after restart, pairing, and pending clearance (#10448)", async () => {
    const { deps, order, other } = setup();
    const result = await runInferenceSet(options, deps);
    expect(order).toEqual([
      "registry-update",
      "registry-update",
      "restart",
      "pairing",
      "registry-update",
      "telemetry",
    ]);
    expect(deps.calls.sendConfigurationTelemetry).toHaveBeenCalledExactlyOnceWith(
      "inference_set",
      expect.any(Function),
    );
    expect(result).toMatchObject({ sandboxName: "alpha", model, inSandboxConfigSynced: true });
    expect(other).toEqual({
      name: "beta",
      agent: "hermes",
      model: "private/default-model",
      gatewayName: "nemoclaw-9091",
      gatewayPort: 9091,
    });
  });

  it.each(postSelectionFailures)(
    "does not report success when $name fails after route selection (#10448)",
    async ({ arrange }) => {
      const { deps } = setup();
      arrange(deps);
      await expect(runInferenceSet(options, deps)).rejects.toThrow();
      expect(deps.calls.sendConfigurationTelemetry).not.toHaveBeenCalled();
    },
  );

  it("leaves the additional committed-target read behind sender gating (#10448)", async () => {
    const { deps } = setup();
    const getSandbox = deps.getSandbox;
    let collectionStarted = false;
    deps.calls.sendConfigurationTelemetry.mockImplementation(async () => {
      collectionStarted = true;
      return "disabled";
    });
    deps.getSandbox = (name) => {
      expect(collectionStarted).toBe(false);
      return getSandbox(name);
    };
    await runInferenceSet(options, deps);
    expect(collectionStarted).toBe(true);
  });

  it("does not report a repeated command that makes no configuration change (#10448)", async () => {
    const { deps } = setup();
    await runInferenceSet(options, deps);
    deps.calls.sendConfigurationTelemetry.mockClear();
    const result = await runInferenceSet(options, deps);
    expect(result.configChanged).toBe(false);
    expect(deps.calls.sendConfigurationTelemetry).not.toHaveBeenCalled();
  });

  it("reports a real route commit even when the sandbox config already matches (#10448)", async () => {
    const { deps, target } = setup();
    await runInferenceSet(options, deps);
    target.model = "nvidia/previous-route-model";
    deps.calls.sendConfigurationTelemetry.mockClear();
    const result = await runInferenceSet(options, deps);
    expect(result.configChanged).toBe(false);
    expect(deps.calls.sendConfigurationTelemetry).toHaveBeenCalledExactlyOnceWith(
      "inference_set",
      expect.any(Function),
    );
  });

  it("keeps the command successful when delivery fails (#10448)", async () => {
    const { deps } = setup();
    deps.calls.sendConfigurationTelemetry.mockRejectedValueOnce(new Error("delivery failure"));
    await expect(runInferenceSet(options, deps)).resolves.toMatchObject({
      sandboxName: "alpha",
      model,
      inSandboxConfigSynced: true,
    });
  });
});
