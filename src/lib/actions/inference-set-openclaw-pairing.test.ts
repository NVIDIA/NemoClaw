// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  completeInferencePostCommit,
  finalizeInferenceMutation,
  type InferenceSetOpenClawPairingDeps,
  type InferenceSetOpenClawPairingTarget,
  settleInferenceSetOpenClawPairing,
} from "./inference-set-gateway-restart";

const TARGET: InferenceSetOpenClawPairingTarget = {
  sandboxName: "alpha",
  gatewayName: "nemoclaw-8080",
  openclawVersion: "2026.7.1",
  stateDirectory: "/sandbox/.openclaw",
};
const DEVICE_IDENTITY_SHA256 = "a".repeat(64);

function observation(state: "settled" | "pairing-only") {
  return { state, deviceIdentitySha256: DEVICE_IDENTITY_SHA256 } as const;
}

function pairingDeps(
  options: {
    observePairing?: InferenceSetOpenClawPairingDeps["observePairing"];
    approval?: ReturnType<InferenceSetOpenClawPairingDeps["approveScopeRequest"]>;
  } = {},
): InferenceSetOpenClawPairingDeps {
  return {
    observePairing: vi.fn(options.observePairing ?? (() => observation("settled"))),
    publishScopeRequest: vi.fn(),
    approveScopeRequest: vi.fn(() => options.approval ?? "approved"),
  };
}

describe("settleInferenceSetOpenClawPairing", () => {
  it("accepts exact settled scope state without publishing a request (#9527)", () => {
    const deps = pairingDeps();

    expect(settleInferenceSetOpenClawPairing(TARGET, deps)).toEqual({
      ok: true,
    });
    expect(deps.publishScopeRequest).not.toHaveBeenCalled();
    expect(deps.approveScopeRequest).not.toHaveBeenCalled();
  });

  it("approves one device-bound request and requires final settled state (#9527)", () => {
    const order: string[] = [];
    const deps = pairingDeps();
    vi.mocked(deps.observePairing).mockImplementation(() => {
      order.push("observe");
      const state = order.length === 1 ? "pairing-only" : "settled";
      return { state, deviceIdentitySha256: DEVICE_IDENTITY_SHA256 };
    });
    vi.mocked(deps.publishScopeRequest).mockImplementation(() => order.push("publish"));
    vi.mocked(deps.approveScopeRequest).mockImplementation(() => {
      order.push("approve");
      return "approved";
    });

    expect(settleInferenceSetOpenClawPairing(TARGET, deps)).toEqual({
      ok: true,
    });
    expect(deps.publishScopeRequest).toHaveBeenCalledWith(TARGET);
    expect(deps.approveScopeRequest).toHaveBeenCalledWith(TARGET, DEVICE_IDENTITY_SHA256);
    expect(order).toEqual(["observe", "publish", "approve", "observe"]);
  });

  it("accepts an ambiguous approval only when final state is settled (#9527)", () => {
    const deps = pairingDeps({
      observePairing: vi
        .fn()
        .mockReturnValueOnce(observation("pairing-only"))
        .mockReturnValueOnce(observation("settled")),
      approval: "ambiguous",
    });

    expect(settleInferenceSetOpenClawPairing(TARGET, deps)).toEqual({
      ok: true,
    });
  });

  it("rejects an ambiguous approval when final state stays pairing-only (#9527)", () => {
    const deps = pairingDeps({
      observePairing: vi.fn(() => observation("pairing-only")),
      approval: "ambiguous",
    });

    expect(settleInferenceSetOpenClawPairing(TARGET, deps)).toEqual({
      ok: false,
      failureLayer: "approval-ambiguous",
    });
  });

  it("rejects unavailable initial state without exposing observer output (#9527)", () => {
    const deps = pairingDeps({
      observePairing: vi.fn(() => {
        throw new Error("token=do-not-report");
      }),
    });

    const result = settleInferenceSetOpenClawPairing(TARGET, deps);

    expect(result).toEqual({
      ok: false,
      failureLayer: "initial-state-unavailable",
    });
    expect(JSON.stringify(result)).not.toContain("do-not-report");
    expect(deps.publishScopeRequest).not.toHaveBeenCalled();
    expect(deps.approveScopeRequest).not.toHaveBeenCalled();
  });

  it("reports approval-rejected when scope state stays pairing-only (#9527)", () => {
    const deps = pairingDeps({
      observePairing: vi.fn(() => observation("pairing-only")),
      approval: "rejected",
    });

    expect(settleInferenceSetOpenClawPairing(TARGET, deps)).toEqual({
      ok: false,
      failureLayer: "approval-rejected",
    });
  });

  it("rejects approved scope state that does not settle (#9527)", () => {
    const deps = pairingDeps({
      observePairing: vi.fn(() => observation("pairing-only")),
    });

    expect(settleInferenceSetOpenClawPairing(TARGET, deps)).toEqual({
      ok: false,
      failureLayer: "final-state-unsettled",
    });
  });

  it("collapses request publication errors into a credential-free classification (#9527)", () => {
    const deps = pairingDeps({
      observePairing: vi.fn(() => observation("pairing-only")),
    });
    vi.mocked(deps.publishScopeRequest).mockImplementation(() => {
      throw new Error("credential=do-not-report");
    });

    const result = settleInferenceSetOpenClawPairing(TARGET, deps);

    expect(result).toEqual({
      ok: false,
      failureLayer: "pairing-operation-failed",
    });
    expect(JSON.stringify(result)).not.toContain("do-not-report");
    expect(deps.approveScopeRequest).not.toHaveBeenCalled();
  });

  it("rejects unavailable final state after one approval attempt (#9527)", () => {
    const deps = pairingDeps({
      observePairing: vi
        .fn()
        .mockReturnValueOnce(observation("pairing-only"))
        .mockImplementationOnce(() => {
          throw new Error("raw paired state");
        }),
    });

    expect(settleInferenceSetOpenClawPairing(TARGET, deps)).toEqual({
      ok: false,
      failureLayer: "final-state-unavailable",
    });
    expect(deps.approveScopeRequest).toHaveBeenCalledOnce();
  });

  it("fails closed when required convergence has no pairing target (#9527)", () => {
    const appendAuditEntry = vi.fn();
    const log = vi.fn();
    const settleOpenClawPairing = vi.fn(() => ({ ok: true }) as const);
    const mutation = finalizeInferenceMutation(
      {
        agentName: "openclaw",
        configChanged: true,
        nextApi: "openai-completions",
        previousApi: "openai-completions",
        result: {
          sandboxName: "alpha",
          provider: "nvidia-prod",
          model: "nvidia/model-b",
          primaryModelRef: "inference/nvidia/model-b",
          inSandboxConfigSynced: true,
        },
      },
      { appendAuditEntry, log },
    );

    expect(() =>
      completeInferencePostCommit(mutation, {
        appendAuditEntry,
        log,
        restartSandboxGateway: vi.fn(
          () =>
            ({
              ok: true,
              restarted: true,
              healthPassed: true,
              forwardRecovered: true,
            }) as const,
        ),
        settleOpenClawPairing,
      }),
    ).toThrow("OpenClaw gateway pairing did not converge (pairing-target-unavailable)");
    expect(settleOpenClawPairing).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join("\n")).not.toContain("Inference route synced");
    expect(appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "inference_set",
        sandbox: "alpha",
        reason: "inference set openclaw:nvidia-prod:nvidia/model-b (pairing convergence pending)",
      }),
    );
    expect(JSON.stringify(appendAuditEntry.mock.calls)).not.toContain("credential=");
  });
});
