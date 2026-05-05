// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  getSandboxDeleteOutcome,
  isMissingSandboxDeleteOutput,
  shouldCleanupGatewayAfterDestroy,
  shouldStopHostServicesAfterDestroy,
} from "./sandbox-destroy-helpers";

describe("sandbox destroy helpers", () => {
  it("detects missing sandbox delete output", () => {
    expect(isMissingSandboxDeleteOutput("Error: sandbox alpha not found")).toBe(true);
    expect(isMissingSandboxDeleteOutput("\u001b[31mNotFound\u001b[0m: missing")).toBe(true);
    expect(isMissingSandboxDeleteOutput("permission denied")).toBe(false);
  });

  it("classifies delete outcomes", () => {
    expect(getSandboxDeleteOutcome({ status: 1, stderr: "Error: sandbox alpha not found" })).toEqual({
      output: "Error: sandbox alpha not found",
      alreadyGone: true,
    });
    expect(getSandboxDeleteOutcome({ status: 1, stdout: "boom" })).toEqual({
      output: "boom",
      alreadyGone: false,
    });
    expect(getSandboxDeleteOutcome({ status: 0, stdout: "deleted" })).toEqual({
      output: "deleted",
      alreadyGone: false,
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
});
