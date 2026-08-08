// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  dockerSandboxContainerNamePrefix,
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
      resolveDestroyGatewayCleanupDecision({}, { nonInteractive: true, platform: "darwin" }),
    ).toBe("cleanup");
    expect(
      resolveDestroyGatewayCleanupDecision({}, { nonInteractive: true, platform: "linux" }),
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
        liveList: { status: 0, output: liveListOutput },
        dockerContainersBySandboxName: new Map([["npmtest", { output: "" }]]),
      }),
    ).toBe(true);
    expect(
      hasNoLiveSandboxes({
        liveList: { status: 0, output: liveListOutput },
        dockerContainersBySandboxName: new Map([
          ["npmtest", { output: "openshell-npmtest-e487d1bd\n" }],
        ]),
      }),
    ).toBe(false);
    expect(
      hasNoLiveSandboxes({
        liveList: {
          status: 0,
          output:
            "NAME              CREATED              PHASE\nnpmtest           now                  Ready\n",
        },
        dockerContainersBySandboxName: new Map([["npmtest", { output: "" }]]),
      }),
    ).toBe(false);
  });

  it("fails closed when a Docker live-container probe snapshot is missing or failed (#4662)", () => {
    expect(hasRunningDockerSandboxContainer("npmtest", undefined)).toBe(true);
    expect(hasRunningDockerSandboxContainer("npmtest", { output: "", probeFailed: true })).toBe(
      true,
    );
    expect(
      hasNoLiveSandboxes({
        liveList: {
          status: 0,
          output:
            "NAME              CREATED              PHASE\nnpmtest           now                  Failed\n",
        },
        dockerContainersBySandboxName: new Map([["npmtest", { output: "", probeFailed: true }]]),
      }),
    ).toBe(false);
  });

  it("fails closed when OpenShell cannot report live sandbox state (#4662)", () => {
    expect(
      hasNoLiveSandboxes({
        liveList: { status: 1, output: "" },
        dockerContainersBySandboxName: new Map(),
      }),
    ).toBe(false);
  });

  it("matches Docker sandbox containers with a literal name prefix (#4662)", () => {
    expect(dockerSandboxContainerNamePrefix("npmtest")).toBe("openshell-npmtest-");
    expect(
      hasRunningDockerSandboxContainer("npmtest", {
        output: "prefix-openshell-npmtest-e487d1bd\nopenshell-npmtest-e487d1bd\n",
      }),
    ).toBe(true);
    expect(
      hasRunningDockerSandboxContainer("npmtest[", {
        output: "openshell-npmtest[-e487d1bd\n",
      }),
    ).toBe(true);
    expect(
      hasRunningDockerSandboxContainer(
        "npmtest",
        { output: "prefix-openshell-npmtest-e487d1bd\nopenshell-npmtest-extra-e487d1bd\n" },
        ["npmtest", "npmtest-extra"],
      ),
    ).toBe(false);
  });
});
