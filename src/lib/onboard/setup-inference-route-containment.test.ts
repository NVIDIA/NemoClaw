// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createSetupInference, type SetupInferenceDeps } from "./setup-inference";

describe("onboard shared gateway route containment", () => {
  it("rejects a conflict before selecting the gateway or mutating provider state (#6315)", async () => {
    const events: string[] = [];
    const runOpenshell = vi.fn(() => {
      events.push("openshell");
      return { status: 0 };
    });
    const updateSandbox = vi.fn(() => true);
    const upsertProvider = vi.fn(() => ({ ok: true }));
    const verifyInferenceRoute = vi.fn();
    const verifyOnboardInferenceSmoke = vi.fn();
    const getGatewayName = vi.fn(() => "nemoclaw-9090");
    const error = vi.fn((message: string) => events.push(`error:${message}`));
    const exitProcess = vi.fn((code: number): never => {
      events.push(`exit:${code}`);
      throw new Error(`exit ${code}`);
    });
    const checkGatewayRouteCompatibility = vi.fn(() => {
      events.push("guard");
      return {
        ok: false as const,
        gatewayName: "nemoclaw-9090",
        sandboxName: "new-sandbox",
        route: { provider: "anthropic-prod", model: "claude-new" },
        conflicts: [{ sandboxName: "stopped-sandbox", reason: "provider-model" as const }],
      };
    });
    const setupInference = createSetupInference({
      checkGatewayRouteCompatibility,
      step: () => events.push("step"),
      getGatewayName,
      runOpenshell,
      updateSandbox,
      upsertProvider,
      verifyInferenceRoute,
      verifyOnboardInferenceSmoke,
      error,
      exitProcess,
    } as unknown as SetupInferenceDeps);

    await expect(
      setupInference(
        "new-sandbox",
        "claude-new",
        "anthropic-prod",
        "https://api.anthropic.com",
        "ANTHROPIC_API_KEY",
      ),
    ).rejects.toThrow("exit 1");

    expect(events[0]).toBe("guard");
    expect(getGatewayName).toHaveBeenCalledOnce();
    expect(checkGatewayRouteCompatibility).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayName: "nemoclaw-9090" }),
    );
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(upsertProvider).not.toHaveBeenCalled();
    expect(verifyInferenceRoute).not.toHaveBeenCalled();
    expect(verifyOnboardInferenceSmoke).not.toHaveBeenCalled();
    expect(updateSandbox).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("stopped-sandbox"));
    expect(exitProcess).toHaveBeenCalledWith(1);
  });
});
