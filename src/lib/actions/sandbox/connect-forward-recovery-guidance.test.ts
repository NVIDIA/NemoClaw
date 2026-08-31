// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import { createConnectHarness } from "../../../../test/support/connect-flow-test-harness";
import * as registry from "../../state/registry";
import { primaryForwardRecoveryGuidance } from "./process-recovery";

describe("connect forward recovery guidance", () => {
  let exitSpy: MockInstance;

  beforeEach(() => {
    vi.stubEnv("NEMOCLAW_TEST_NO_SLEEP", "1");
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    [
      "readiness retry exhaustion",
      "forward-readiness-retry-limit",
      "openshell sandbox get -g 'nemoclaw' 'alpha'` can report Ready or Running before forwarding is ready. Run `openshell forward list --gateway 'nemoclaw'`. If port 18789 has no owner, run `openshell forward start --background 18789 'alpha' --gateway 'nemoclaw'` to read the current OpenShell error",
      true,
    ],
    [
      "port ownership conflict",
      "port-ownership-conflict",
      "identify the current owner of port 18789 before you change either sandbox",
      false,
    ],
    [
      "unavailable forward state",
      "forward-state-unavailable",
      "After OpenShell reports forward state",
      false,
    ],
    [
      "unverified forward ownership",
      "forward-ownership-unverified",
      "confirm that 'alpha' owns port 18789",
      false,
    ],
    [
      "listener retry exhaustion",
      "forward-listener-retry-limit",
      "If port 18789 has no owner",
      true,
    ],
    [
      "rejected forward start",
      "forward-start-failure",
      "to read the OpenShell error. Correct the error",
      true,
    ],
  ] as const)(
    "prints recovery guidance for %s (#10640)",
    async (_caseName, reason, expectedGuidance, includesManualStart) => {
      const processCheck = {
        checked: true,
        wasRunning: true,
        recovered: false,
        forwardRecovered: false,
        forwardRecoveryFailed: true,
        forwardRecoveryFailureDetail: `classified ${reason}`,
      };
      const harness = createConnectHarness({ processCheck });
      harness.checkAndRecoverSpy.mockImplementation((_sandboxName: unknown, options: unknown) => {
        (
          options as {
            onForwardRecoveryFailure?: (failure: {
              port: number;
              reason: typeof reason;
              sandboxName: string;
            }) => void;
          }
        ).onForwardRecoveryFailure?.({ port: 18789, reason, sandboxName: "alpha" });
        return processCheck;
      });

      await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
        "process.exit(1)",
      );

      const errorOutput = harness.errorSpy.mock.calls
        .map((call) => String(call[0] ?? ""))
        .join("\n");
      expect(errorOutput).toContain(expectedGuidance);
      expect(errorOutput.includes("openshell forward start --background 18789")).toBe(
        includesManualStart,
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    },
  );

  it("scopes recovery commands to the sandbox gateway (#10640)", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      gatewayPort: 18080,
      name: "alpha",
    } as NonNullable<ReturnType<typeof registry.getSandbox>>);

    const guidance = primaryForwardRecoveryGuidance(
      "alpha",
      18789,
      "forward-readiness-retry-limit",
    );

    expect(guidance).toContain("openshell sandbox get -g 'nemoclaw-18080' 'alpha'");
    expect(guidance).toContain("openshell forward list --gateway 'nemoclaw-18080'");
    expect(guidance).toContain(
      "openshell forward start --background 18789 'alpha' --gateway 'nemoclaw-18080'",
    );
  });

  it("uses inspection guidance for an auxiliary forward failure (#10640)", async () => {
    const harness = createConnectHarness({
      processCheck: {
        checked: true,
        wasRunning: true,
        recovered: false,
        forwardRecovered: false,
        forwardRecoveryFailed: true,
        forwardRecoveryFailureDetail: "the messaging webhook host forward failed",
        forwardRecoveryFailureScope: "auxiliary",
      },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain("the messaging webhook host forward failed");
    expect(errorOutput).toContain("openshell forward list --gateway 'nemoclaw'");
    expect(errorOutput).not.toContain("openshell forward start");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
