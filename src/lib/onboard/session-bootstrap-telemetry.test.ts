// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  verify: vi.fn(async () => ({ verified: true, status: "reported", metadataErrors: [] })),
}));
vi.mock("../actions/telemetry/operation", () => ({
  finishTelemetryOperation: vi.fn(),
  isTelemetryOperationActive: () => true,
  recordTelemetryTarget: mocks.record,
}));
vi.mock("../actions/sandbox/agents/telemetry-verification", () => ({
  verifySelectedAgentsManifest: mocks.verify,
}));

import { createOnboardOperationCompletion } from "./session-bootstrap";

it("keeps a registry collection error after selection verification succeeds (#12859)", async () => {
  const completion = createOnboardOperationCompletion({
    sandboxName: "selected",
    pending: false,
    getSandbox: () => null,
    updateSandbox: () => true,
  });
  completion.captureExisting(() => {
    throw new Error("registry unavailable");
  });

  await completion.accept(true);
  completion.record(true, "nemoclaw");

  expect(mocks.verify).toHaveBeenCalledOnce();
  expect(mocks.record).toHaveBeenCalledWith(
    expect.objectContaining({
      sandboxName: "selected",
      outcome: "completed",
      verificationStatus: "collection_error",
    }),
  );
});
