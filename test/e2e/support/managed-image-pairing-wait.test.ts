// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import { waitForLocalInferenceAgentPairing } from "../../../scripts/checks/managed-image-protected-runtime-contract";

const pending = { status: 1, stderr: "scope upgrade pending approval" };
it("waits for normal OpenClaw pairing before accepting completion", async () => {
  const success = { status: 0, stderr: "", stdout: "completion" };
  const run = vi.fn().mockReturnValueOnce(pending).mockReturnValueOnce(success);
  const sleep = vi.fn().mockResolvedValue(undefined);
  expect(await waitForLocalInferenceAgentPairing("openclaw", run, sleep)).toBe(success);
  expect(run).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledExactlyOnceWith(5_000);
});

it("returns the failure after four pending-approval attempts", async () => {
  const run = vi.fn().mockReturnValue(pending);
  const sleep = vi.fn().mockResolvedValue(undefined);
  expect(await waitForLocalInferenceAgentPairing("openclaw", run, sleep)).toBe(pending);
  expect(run).toHaveBeenCalledTimes(4);
  expect(sleep).toHaveBeenCalledTimes(3);
});

it.each([
  ["hermes", pending],
  ["langchain-deepagents-code", pending],
  ["openclaw", { status: 1, stderr: "inference request failed" }],
  ["openclaw", { status: null, stderr: pending.stderr }],
  ["openclaw", { ...pending, error: new Error("transport failed") }],
] as const)("does not retry unrelated failure for %s: %j", async (agent, result) => {
  const run = vi.fn().mockReturnValue(result);
  const sleep = vi.fn().mockResolvedValue(undefined);
  expect(await waitForLocalInferenceAgentPairing(agent, run, sleep)).toBe(result);
  expect(run).toHaveBeenCalledOnce();
  expect(sleep).not.toHaveBeenCalled();
});
