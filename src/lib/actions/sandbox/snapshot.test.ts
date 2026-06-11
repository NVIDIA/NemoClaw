// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backupSandboxStateMock = vi.fn();
const captureOpenshellMock = vi.fn(() => ({ status: 0, output: "alpha Ready\n" }));
const dockerInspectMock = vi.fn(() => ({ status: 0, stdout: "true\n" }));
const getSandboxMock = vi.fn(() => null);
const isGatewayHealthyMock = vi.fn(() => true);
const parseLiveSandboxNamesMock = vi.fn(() => new Set(["alpha"]));

vi.mock("../../adapters/docker", () => ({
  dockerCapture: vi.fn(() => ""),
  dockerInspect: dockerInspectMock,
}));

vi.mock("../../adapters/openshell/runtime", () => ({
  captureOpenshell: captureOpenshellMock,
  getOpenshellBinary: vi.fn(() => "openshell"),
  runOpenshell: vi.fn(() => ({ status: 0, output: "" })),
}));

vi.mock("../../credentials/store", () => ({
  prompt: vi.fn(),
}));

vi.mock("../../domain/sandbox/destroy", () => ({
  getSandboxDeleteOutcome: vi.fn(() => ({ alreadyGone: false })),
}));

vi.mock("../../policy", () => ({}));

vi.mock("../../runner", () => ({
  ROOT: "/repo",
  run: vi.fn(() => ({ status: 0 })),
  shellQuote: (value: string) => `'${value}'`,
  validateName: vi.fn(),
}));

vi.mock("../../runtime-recovery", () => ({
  parseLiveSandboxNames: parseLiveSandboxNamesMock,
}));

vi.mock("../../shields", () => ({
  isShieldsDown: undefined,
}));

vi.mock("../../state/gateway", () => ({
  isGatewayHealthy: isGatewayHealthyMock,
}));

vi.mock("../../state/registry", () => ({
  getSandbox: getSandboxMock,
  registerSandbox: vi.fn(),
  removeSandbox: vi.fn(),
}));

vi.mock("../../state/sandbox", () => ({
  backupSandboxState: backupSandboxStateMock,
  findBackup: vi.fn(),
  listBackups: vi.fn(() => []),
}));

vi.mock("./destroy", () => ({
  cleanupShieldsDestroyArtifacts: vi.fn(),
  removeSandboxRegistryEntry: vi.fn(),
}));

describe("runSandboxSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captureOpenshellMock.mockReturnValue({ status: 0, output: "alpha Ready\n" });
    dockerInspectMock.mockReturnValue({ status: 0, stdout: "true\n" });
    getSandboxMock.mockReturnValue(null);
    isGatewayHealthyMock.mockReturnValue(true);
    parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses snapshot creation before backup when the shields gate helper is unavailable", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "create" })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(backupSandboxStateMock).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "Cannot verify shields state. Refusing to create snapshot.",
    );
  });
});
