// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  hasNoLiveSandboxes,
  hasRunningDockerSandboxContainer,
  resolveDestroyGatewayCleanupDecision,
  shouldCleanupGatewayAfterDestroy,
  shouldStopHostServicesAfterDestroy,
} from "./destroy";

describe("sandbox destroy helpers", () => {
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
    expect(
      hasRunningDockerSandboxContainer("npmtest", {
        output: "openshell-default--npmtest-e487d1bd\n",
      }),
    ).toBe(true);
    expect(
      hasRunningDockerSandboxContainer("npmtest", {
        output: "openshell-review--npmtest-e487d1bd\n",
      }),
    ).toBe(false);
    expect(
      hasRunningDockerSandboxContainer(
        "npmtest",
        { output: "openshell-default--npmtest-extra-e487d1bd\n" },
        ["npmtest", "npmtest-extra"],
      ),
    ).toBe(false);
  });
});
