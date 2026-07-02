// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { warnIfCleanupFailed } from "./docker-driver-gateway-cleanup";

describe("warnIfCleanupFailed", () => {
  it("does not warn when standalone gateway cleanup succeeds", () => {
    const warn = vi.fn();

    warnIfCleanupFailed(() => true, warn);

    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when standalone gateway cleanup fails", () => {
    const warn = vi.fn();

    warnIfCleanupFailed(() => false, warn);

    expect(warn).toHaveBeenCalledWith(
      "  ⚠ Gateway cleanup after sandbox-bridge failure failed: Docker-driver gateway cleanup did not stop the process.",
    );
  });
});
