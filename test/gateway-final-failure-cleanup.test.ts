// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

type FinalGatewayStartFailureOptions = {
  retries: number;
  collectDiagnostics?: () => string | null | undefined;
  cleanupGateway?: () => void;
  exitProcess?: (code: number) => never;
  printError?: (message?: string) => void;
};

type OnboardGatewayFailureInternals = {
  handleFinalGatewayStartFailure: (options: FinalGatewayStartFailureOptions) => never;
};

function isOnboardGatewayFailureInternals(
  value: object | null,
): value is OnboardGatewayFailureInternals {
  return (
    value !== null &&
    typeof Reflect.get(value, "handleFinalGatewayStartFailure") === "function"
  );
}

const loadedOnboardInternals = require("../dist/lib/onboard");
const onboardInternals =
  typeof loadedOnboardInternals === "object" && loadedOnboardInternals !== null
    ? loadedOnboardInternals
    : null;
if (!isOnboardGatewayFailureInternals(onboardInternals)) {
  throw new Error("Expected onboard internals to expose handleFinalGatewayStartFailure");
}
const { handleFinalGatewayStartFailure } = onboardInternals;

describe("final gateway startup failure cleanup", () => {
  it("collects diagnostics before cleanup, then exits", () => {
    const calls: string[] = [];
    const errors: string[] = [];

    expect(() =>
      handleFinalGatewayStartFailure({
        retries: 2,
        collectDiagnostics: () => {
          calls.push("diagnostics");
          return "gateway log line\n";
        },
        cleanupGateway: () => {
          calls.push("cleanup");
        },
        exitProcess: (code: number): never => {
          calls.push(`exit:${code}`);
          throw new Error(`exit ${code}`);
        },
        printError: (message = "") => {
          errors.push(message);
        },
      }),
    ).toThrow("exit 1");

    expect(calls).toEqual(["diagnostics", "cleanup", "exit:1"]);
    expect(errors).toContain("  Gateway failed to start after 3 attempts.");
    expect(errors).toContain("  Gateway logs:");
    expect(errors).toContain("    gateway log line");
    expect(errors).toContain("  Cleanup attempted.");
    expect(errors).toContain("    openshell gateway destroy -g nemoclaw");
    expect(errors).toContain(
      '    docker volume ls -q --filter "name=openshell-cluster-nemoclaw" | xargs -r docker volume rm',
    );
    expect(errors).toContain("    nemoclaw onboard --resume");
  });

  it("still cleans up after the diagnostic command is attempted and fails", () => {
    const calls: string[] = [];
    const errors: string[] = [];

    expect(() =>
      handleFinalGatewayStartFailure({
        retries: 0,
        collectDiagnostics: () => {
          calls.push("diagnostics");
          throw new Error("doctor unavailable");
        },
        cleanupGateway: () => {
          calls.push("cleanup");
        },
        exitProcess: (code: number): never => {
          calls.push(`exit:${code}`);
          throw new Error(`exit ${code}`);
        },
        printError: (message = "") => {
          errors.push(message);
        },
      }),
    ).toThrow("exit 1");

    expect(calls).toEqual(["diagnostics", "cleanup", "exit:1"]);
    expect(errors).toContain("  Gateway failed to start after 1 attempts.");
    expect(errors).toContain("  Diagnostic command attempted before cleanup:");
    expect(errors).toContain("    openshell doctor logs --name nemoclaw");
    expect(errors).toContain("  If gateway cleanup did not complete, run:");
  });
});
