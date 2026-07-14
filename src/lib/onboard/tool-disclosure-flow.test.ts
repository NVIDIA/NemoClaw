// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertDockerfileContract: vi.fn(),
  loadSession: vi.fn(),
  removeSandbox: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock("../state/onboard-session", () => ({
  loadSession: mocks.loadSession,
  updateSession: mocks.updateSession,
}));
vi.mock("../state/registry", () => ({
  removeSandbox: mocks.removeSandbox,
}));
vi.mock("./dockerfile-tool-disclosure-contract", () => ({
  assertToolDisclosureDockerfileContract: mocks.assertDockerfileContract,
}));

import {
  applyOnboardToolDisclosureRequest,
  prepareSandboxToolDisclosure,
} from "./tool-disclosure-flow";

const ENV_KEY = "NEMOCLAW_TOOL_DISCLOSURE";

function interceptExit() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`EXIT:${code}`);
  }) as never);
}

describe("onboard tool-disclosure flow", () => {
  beforeEach(() => {
    vi.stubEnv(ENV_KEY, undefined);
    mocks.assertDockerfileContract.mockReset();
    mocks.loadSession.mockReset();
    mocks.removeSandbox.mockReset();
    mocks.updateSession.mockReset();
    mocks.loadSession.mockReturnValue({ toolDisclosure: "progressive" });
    mocks.updateSession.mockImplementation(
      (mutator: (session: { toolDisclosure?: string }) => unknown) =>
        mutator({ toolDisclosure: "progressive" }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("resolves CLI before env and rejects an invalid request at the public boundary", () => {
    vi.stubEnv(ENV_KEY, "direct");
    expect(applyOnboardToolDisclosureRequest("progressive")).toBe("progressive");
    expect(process.env[ENV_KEY]).toBe("progressive");

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    interceptExit();
    expect(() => applyOnboardToolDisclosureRequest("sometimes")).toThrow("EXIT:1");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("must be one of"));
  });

  it("preserves an explicit mode and reports one-time migration for legacy live state", () => {
    const result = prepareSandboxToolDisclosure(
      "alpha",
      null,
      false,
      () => ({
        existingEntry: { name: "alpha", toolDisclosure: undefined },
        preservedMcpState: undefined,
        liveExists: true,
      }),
      "direct",
    );

    expect(result).toMatchObject({
      effectiveToolDisclosure: "direct",
      toolDisclosureMigrationNeeded: true,
      toolDisclosureMigrationNote: expect.stringContaining("apply direct tool disclosure"),
    });
    expect(mocks.updateSession).toHaveBeenCalledOnce();
    expect(mocks.removeSandbox).not.toHaveBeenCalled();
  });

  it("fails before session or registry mutation for invalid recorded state", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    interceptExit();

    expect(() =>
      prepareSandboxToolDisclosure(
        "alpha",
        null,
        false,
        () => ({
          existingEntry: { name: "alpha", toolDisclosure: "invalid" as never },
          preservedMcpState: undefined,
          liveExists: true,
        }),
        null,
      ),
    ).toThrow("EXIT:1");
    expect(mocks.updateSession).not.toHaveBeenCalled();
    expect(mocks.removeSandbox).not.toHaveBeenCalled();
  });

  it("fails before session or registry mutation when a custom Dockerfile violates the contract", () => {
    mocks.assertDockerfileContract.mockImplementation(() => {
      throw new Error("missing final-stage declaration");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    interceptExit();

    expect(() =>
      prepareSandboxToolDisclosure(
        "alpha",
        "/tmp/Dockerfile.custom",
        true,
        () => ({
          existingEntry: null,
          preservedMcpState: undefined,
          liveExists: false,
        }),
        "progressive",
      ),
    ).toThrow("EXIT:1");
    expect(mocks.updateSession).not.toHaveBeenCalled();
    expect(mocks.removeSandbox).not.toHaveBeenCalled();
  });

  it("keeps a pending route reservation for the current sandbox so a resumed onboard can recover", () => {
    const result = prepareSandboxToolDisclosure(
      "alpha",
      null,
      false,
      () => ({
        existingEntry: {
          name: "alpha",
          toolDisclosure: "progressive",
          pendingRouteReservation: true,
        },
        preservedMcpState: undefined,
        liveExists: false,
      }),
      "progressive",
    );

    expect(result).toMatchObject({ effectiveToolDisclosure: "progressive" });
    expect(mocks.updateSession).toHaveBeenCalledOnce();
    expect(mocks.removeSandbox).not.toHaveBeenCalled();
  });

  it("still clears a stale registry entry that has no live sandbox and no pending reservation", () => {
    prepareSandboxToolDisclosure(
      "beta",
      null,
      false,
      () => ({
        existingEntry: { name: "beta", toolDisclosure: "progressive" },
        preservedMcpState: undefined,
        liveExists: false,
      }),
      "progressive",
    );

    expect(mocks.removeSandbox).toHaveBeenCalledWith("beta");
  });
});
