// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  receipts: [] as Array<{
    gatewayName: string;
    sandboxIdentityFingerprint: string;
    sandboxName: string;
  }>,
  pendingReceipts: [] as Array<{
    gatewayName: string;
    sandboxIdentityFingerprint: string;
    sandboxName: string;
  }>,
  stopAll: vi.fn(),
}));

vi.mock("../../adapters/openshell/forward-service-controller", () => ({
  createForwardServiceController: () => ({ stopAll: mocks.stopAll }),
}));

vi.mock("../../adapters/openshell/forward-service-state", () => ({
  listForwardServicePendingReceipts: () => mocks.pendingReceipts,
  listForwardServiceReceipts: () => mocks.receipts,
}));

import { stopForwardServicesForUninstall } from "./hermes-uninstall-cleanup";

const registration = {
  alpha: {
    name: "alpha",
    gatewayName: "nemoclaw",
    gatewayPort: 8_080,
    lifecycleLiveIdentityFingerprint: "c".repeat(64),
  },
};

describe("ForwardTcp uninstall cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.receipts = [];
    mocks.pendingReceipts = [];
    mocks.stopAll.mockReturnValue(2);
  });

  it("retires exact selected-sandbox receipts before state removal", () => {
    const runtime = { log: vi.fn(), warn: vi.fn() };

    expect(
      stopForwardServicesForUninstall(registration, "/private/state", runtime, () => "nemoclaw"),
    ).toBe(true);
    expect(mocks.stopAll).toHaveBeenCalledWith({
      gatewayName: "nemoclaw",
      sandboxIdentityFingerprint: "c".repeat(64),
      sandboxName: "alpha",
    });
    expect(runtime.log).toHaveBeenCalledWith("Stopped 2 ForwardTcp services for sandbox 'alpha'.");
  });

  it("preserves uninstall state when receipt authority is ambiguous", () => {
    const runtime = { log: vi.fn(), warn: vi.fn() };
    mocks.stopAll.mockImplementation(() => {
      throw new Error("receipt changed");
    });

    expect(
      stopForwardServicesForUninstall(registration, "/private/state", runtime, () => "nemoclaw"),
    ).toBe(false);
    expect(runtime.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not safely stop ForwardTcp services"),
    );
  });

  it("refuses to orphan a receipt without selected registry authority", () => {
    const runtime = { log: vi.fn(), warn: vi.fn() };
    mocks.receipts = [
      {
        gatewayName: "nemoclaw",
        sandboxIdentityFingerprint: "e".repeat(64),
        sandboxName: "orphaned",
      },
    ];

    expect(
      stopForwardServicesForUninstall(registration, "/private/state", runtime, () => "nemoclaw"),
    ).toBe(false);
    expect(mocks.stopAll).not.toHaveBeenCalled();
    expect(runtime.warn).toHaveBeenCalledWith(
      expect.stringContaining("has no matching selected registry authority"),
    );
  });

  it("refuses to orphan pending authority without a selected registry row", () => {
    const runtime = { log: vi.fn(), warn: vi.fn() };
    mocks.pendingReceipts = [
      {
        gatewayName: "nemoclaw",
        sandboxIdentityFingerprint: "f".repeat(64),
        sandboxName: "pending-orphan",
      },
    ];

    expect(
      stopForwardServicesForUninstall(registration, "/private/state", runtime, () => "nemoclaw"),
    ).toBe(false);
    expect(mocks.stopAll).not.toHaveBeenCalled();
  });
});
