// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { destroyGatewayForReuse } from "./gateway-cleanup";

describe("destroyGatewayForReuse", () => {
  it("returns missing and logs the success message when cleanup succeeds", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await destroyGatewayForReuse(() => true, "cleaned", "failed")).toBe("missing");
      expect(log).toHaveBeenCalledWith("cleaned");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it("returns stale and warns when cleanup fails", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await destroyGatewayForReuse(() => false, "cleaned", "failed")).toBe("stale");
      expect(warn).toHaveBeenCalledWith("failed");
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });
});
