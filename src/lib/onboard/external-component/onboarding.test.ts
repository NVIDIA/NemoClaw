// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { ExternalComponentContractError } from "./index";
import { assertExternalComponentFreshSandbox, prepareExternalComponent } from "./onboarding";

describe("external component onboarding lifecycle", () => {
  it("accepts an explicit sandbox name when the sandbox is absent (#11340)", () => {
    const inspectSandboxForCreate = vi.fn(() => ({
      existingEntry: null,
      preservedMcpState: undefined,
      liveExists: false,
    }));

    expect(() =>
      assertExternalComponentFreshSandbox("new-sandbox", inspectSandboxForCreate),
    ).not.toThrow();
    expect(inspectSandboxForCreate).toHaveBeenCalledWith("new-sandbox");
  });

  it("requires an explicit sandbox name before gateway changes (#11340)", () => {
    const inspectSandboxForCreate = vi.fn();

    expect(() => assertExternalComponentFreshSandbox(null, inspectSandboxForCreate)).toThrowError(
      expect.objectContaining<Partial<ExternalComponentContractError>>({
        code: "lifecycle_unsupported",
      }),
    );
    expect(inspectSandboxForCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["a registered sandbox", { existingEntry: {} as never, liveExists: false }],
    ["a live sandbox", { existingEntry: null, liveExists: true }],
  ])("rejects %s before gateway changes (#11340)", (_title, inspected) => {
    const inspectSandboxForCreate = vi.fn(() => ({
      ...inspected,
      preservedMcpState: undefined,
    }));

    expect(() =>
      assertExternalComponentFreshSandbox("existing-sandbox", inspectSandboxForCreate),
    ).toThrowError(
      expect.objectContaining<Partial<ExternalComponentContractError>>({
        code: "lifecycle_unsupported",
      }),
    );
  });

  it("does not retry an incomplete activation automatically (#11340)", () => {
    expect(() =>
      prepareExternalComponent({
        externalComponentActivation: {
          schemaVersion: 1,
          resultClass: "ambiguous",
        },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ExternalComponentContractError>>({
        code: "lifecycle_unsupported",
      }),
    );
  });
});
