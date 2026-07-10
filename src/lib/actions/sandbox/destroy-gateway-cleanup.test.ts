// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { shouldCleanupGatewayAfterConfirmedFinalDestroy } from "./destroy-gateway-cleanup";

describe("shouldCleanupGatewayAfterConfirmedFinalDestroy", () => {
  it("defers live probes until the local registry is empty", () => {
    const liveSandboxProbe = vi.fn(() => true);

    expect(
      shouldCleanupGatewayAfterConfirmedFinalDestroy(
        {
          deleteSucceededOrAlreadyGone: true,
          removedRegistryEntry: true,
        },
        {
          listSandboxes: () => ({ sandboxes: [{}] }),
          liveSandboxProbe,
        },
      ),
    ).toBe(false);
    expect(liveSandboxProbe).not.toHaveBeenCalled();
  });

  it("requires confirmed delete, registry removal, and no live sandboxes", () => {
    expect(
      shouldCleanupGatewayAfterConfirmedFinalDestroy(
        {
          deleteSucceededOrAlreadyGone: true,
          removedRegistryEntry: true,
        },
        {
          listSandboxes: () => ({ sandboxes: [] }),
          liveSandboxProbe: () => true,
        },
      ),
    ).toBe(true);

    expect(
      shouldCleanupGatewayAfterConfirmedFinalDestroy(
        {
          deleteSucceededOrAlreadyGone: true,
          removedRegistryEntry: true,
        },
        {
          listSandboxes: () => ({ sandboxes: [] }),
          liveSandboxProbe: () => false,
        },
      ),
    ).toBe(false);
  });
});
