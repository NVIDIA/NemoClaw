// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  takeManifest: vi.fn(),
  readEntry: vi.fn(),
  updateSelections: vi.fn(),
  readNative: vi.fn(),
}));

vi.mock("../../../onboard/agents-manifest", () => ({
  takeSelectedAgentsManifest: mocks.takeManifest,
}));
vi.mock("../../../state/registry/telemetry-selections", () => ({
  readSandboxTelemetryEntry: mocks.readEntry,
  updateSandboxTelemetrySelections: mocks.updateSelections,
}));
vi.mock("../../telemetry/operation", () => ({
  isTelemetryOperationActive: () => true,
  withTelemetryEvidence: (read: (remainingMs: number, signal: AbortSignal) => Promise<unknown>) =>
    read(1_000, new AbortController().signal),
}));
vi.mock("../../telemetry/native-reader", () => ({
  createSupervisedSandboxCommandReader: () => ({
    read: mocks.readNative,
    dispose: vi.fn(),
  }),
}));
vi.mock("../mcp-bridge-provider-inspection", () => ({
  resolveSandboxConfigRuntimeSelection: () => ({ gatewayName: "nemoclaw" }),
}));

import { verifySelectedAgentsManifest } from "./telemetry-verification";

beforeEach(() => {
  mocks.takeManifest.mockReturnValue({ agents: [{ id: "worker", model: "vendor/model" }] });
  mocks.readEntry.mockReturnValue({ name: "selected", agent: "openclaw" });
  mocks.updateSelections.mockReturnValue(true);
});

it("persists a verified model source when the selected manifest matches native config (#12859)", async () => {
  mocks.readNative.mockResolvedValue(
    JSON.stringify({ agents: { entries: { worker: { model: "vendor/model" }, main: {} } } }),
  );

  const result = await verifySelectedAgentsManifest("selected", {
    kind: "named",
    gatewayName: "nemoclaw",
  });

  expect(result).toEqual({ verified: true, status: "reported" });
  expect(mocks.updateSelections).toHaveBeenCalledWith(
    { name: "selected", agent: "openclaw" },
    {
      modelAssignmentSelections: [
        expect.objectContaining({
          agentId: "worker",
          assignment: "override",
          reference: "vendor/model",
          modelSource: "custom",
        }),
      ],
    },
  );
});

it("rejects a selected model that differs from native config without saving its source (#12859)", async () => {
  mocks.readNative.mockResolvedValue(
    JSON.stringify({ agents: { entries: { worker: { model: "vendor/other" }, main: {} } } }),
  );

  const result = await verifySelectedAgentsManifest("selected", {
    kind: "named",
    gatewayName: "nemoclaw",
  });

  expect(result).toEqual({ verified: false, status: "reported" });
  expect(mocks.updateSelections).not.toHaveBeenCalled();
});
