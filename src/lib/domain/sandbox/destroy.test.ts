// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  getSandboxDeleteOutcome,
  hasNoLiveSandboxes,
  hasRunningDockerSandboxContainer,
  isGatewayUnreachableDeleteOutput,
  isMissingSandboxDeleteOutput,
  resolveDestroyGatewayCleanupDecision,
  shouldCleanupGatewayAfterDestroy,
  shouldStopHostServicesAfterDestroy,
} from "./destroy";

describe("sandbox destroy helpers", () => {
  it("detects missing sandbox delete output", () => {
    expect(isMissingSandboxDeleteOutput("Error: sandbox alpha not found")).toBe(true);
    expect(isMissingSandboxDeleteOutput("\u001b[31mNotFound\u001b[0m: missing")).toBe(true);
    expect(isMissingSandboxDeleteOutput("permission denied")).toBe(false);
  });

  it("detects gateway transport errors vs real failures (#6046)", () => {
    expect(isGatewayUnreachableDeleteOutput("Connection refused (os error 61)")).toBe(true);
    expect(isGatewayUnreachableDeleteOutput("tcp connect error: Connection refused")).toBe(true);
    expect(isGatewayUnreachableDeleteOutput("error trying to connect to 127.0.0.1:8080")).toBe(
      true,
    );
    expect(isGatewayUnreachableDeleteOutput("permission denied")).toBe(false);
    expect(isGatewayUnreachableDeleteOutput("sandbox alpha not found")).toBe(false);
  });

  it("classifies delete outcomes", () => {
    expect(
      getSandboxDeleteOutcome({ status: 1, stderr: "Error: sandbox alpha not found" }),
    ).toEqual({
      output: "Error: sandbox alpha not found",
      alreadyGone: true,
      gatewayUnreachable: false,
    });
    expect(getSandboxDeleteOutcome({ status: 1, stdout: "boom" })).toEqual({
      output: "boom",
      alreadyGone: false,
      gatewayUnreachable: false,
    });
    expect(getSandboxDeleteOutcome({ status: 0, stdout: "deleted" })).toEqual({
      output: "deleted",
      alreadyGone: false,
      gatewayUnreachable: false,
    });
    expect(
      getSandboxDeleteOutcome({ status: 1, stderr: "tcp connect error: Connection refused" }),
    ).toEqual({
      output: "tcp connect error: Connection refused",
      alreadyGone: false,
      gatewayUnreachable: true,
    });
  });

  it("decides when host services should stop before final registry removal", () => {
    expect(
      shouldStopHostServicesAfterDestroy({
        deleteSucceededOrAlreadyGone: true,
        registeredSandboxCount: 1,
        sandboxStillRegistered: true,
      }),
    ).toBe(true);
    expect(
      shouldStopHostServicesAfterDestroy({
        deleteSucceededOrAlreadyGone: true,
        registeredSandboxCount: 2,
        sandboxStillRegistered: true,
      }),
    ).toBe(false);
  });

  it("decides when gateway cleanup should run after destroy", () => {
    expect(
      shouldCleanupGatewayAfterDestroy({
        deleteSucceededOrAlreadyGone: true,
        removedRegistryEntry: true,
        noRegisteredSandboxes: true,
        noLiveSandboxes: true,
      }),
    ).toBe(true);
    expect(
      shouldCleanupGatewayAfterDestroy({
        deleteSucceededOrAlreadyGone: true,
        removedRegistryEntry: true,
        noRegisteredSandboxes: true,
        noLiveSandboxes: false,
      }),
    ).toBe(false);
  });

  it("resolves final-gateway cleanup defaults without prompting when unattended (#4662)", () => {
    expect(
      resolveDestroyGatewayCleanupDecision(
        { cleanupGateway: true },
        { nonInteractive: false, platform: "linux" },
      ),
    ).toBe("cleanup");
    expect(
      resolveDestroyGatewayCleanupDecision(
        { cleanupGateway: false },
        { nonInteractive: true, platform: "darwin" },
      ),
    ).toBe("preserve");
    expect(
      resolveDestroyGatewayCleanupDecision(
        { yes: true },
        { nonInteractive: false, platform: "darwin" },
      ),
    ).toBe("cleanup");
    expect(
      resolveDestroyGatewayCleanupDecision(
        { force: true },
        { nonInteractive: false, platform: "linux" },
      ),
    ).toBe("preserve");
    expect(
      resolveDestroyGatewayCleanupDecision({}, { nonInteractive: true, platform: "win32" }),
    ).toBe("preserve");
    expect(
      resolveDestroyGatewayCleanupDecision({}, { nonInteractive: false, platform: "darwin" }),
    ).toBe("prompt");
  });

  it("treats only terminal OpenShell rows without Docker containers as no live sandboxes (#4662)", () => {
    const liveListOutput =
      "NAME              CREATED              PHASE\nnpmtest           2026-06-01 00:00:00  Error\n";
    expect(
      hasNoLiveSandboxes({
        captureOpenshell: () => ({ status: 0, output: liveListOutput }),
        dockerCapture: () => "",
        timeoutMs: 1_000,
      }),
    ).toBe(true);
    expect(
      hasNoLiveSandboxes({
        captureOpenshell: () => ({ status: 0, output: liveListOutput }),
        dockerCapture: () => "openshell-npmtest-e487d1bd\n",
        timeoutMs: 1_000,
      }),
    ).toBe(false);
    expect(
      hasNoLiveSandboxes({
        captureOpenshell: () => ({
          status: 0,
          output:
            "NAME              CREATED              PHASE\nnpmtest           now                  Ready\n",
        }),
        dockerCapture: () => "",
        timeoutMs: 1_000,
      }),
    ).toBe(false);
  });

  it("fails closed when the Docker live-container probe cannot run (#4662)", () => {
    expect(
      hasRunningDockerSandboxContainer(
        "npmtest",
        () => {
          throw new Error("docker unavailable");
        },
        1_000,
      ),
    ).toBe(true);
    expect(
      hasNoLiveSandboxes({
        captureOpenshell: () => ({
          status: 0,
          output:
            "NAME              CREATED              PHASE\nnpmtest           now                  Failed\n",
        }),
        dockerCapture: () => {
          throw new Error("docker unavailable");
        },
        timeoutMs: 1_000,
      }),
    ).toBe(false);
  });
});
