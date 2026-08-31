// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import { createConnectHarness } from "../../../../test/support/connect-flow-test-harness";

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
      "openshell sandbox status alpha` reports Ready",
      false,
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
    "gives safe guidance for %s (#10640)",
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
      expect(errorOutput.includes("openshell forward start --background 18789 alpha")).toBe(
        includesManualStart,
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    },
  );
});
