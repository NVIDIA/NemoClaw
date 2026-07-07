// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { deniedReasonLogProof, pollDeniedReasonLog } from "../live/network-policy-denied-log.ts";

const ENDPOINT = "nemoclaw-prr-repro-long-hostname-for-truncation-test.example.invalid:443";
const COMPLETE_LINE = `[policy:-] [NET:OPEN] DENIED [reason:${ENDPOINT} is not allowed by any policy]`;

describe("network-policy denied-log proof", () => {
  it("extracts the complete denied endpoint and policy disposition", () => {
    expect(deniedReasonLogProof(`prefix\n${COMPLETE_LINE}\nsuffix`, ENDPOINT)).toEqual({
      line: COMPLETE_LINE,
      reason: `${ENDPOINT} is not allowed by any policy`,
    });
  });

  it("does not accept a truncated endpoint", () => {
    expect(
      deniedReasonLogProof(
        "[policy:-] [NET:OPEN] DENIED [reason:nemoclaw-prr-repro-long-hostname...]",
        ENDPOINT,
      ),
    ).toBeNull();
  });

  it("polls until the complete denied event is visible", async () => {
    const readLogs = vi
      .fn()
      .mockResolvedValueOnce("unrelated")
      .mockResolvedValueOnce(COMPLETE_LINE);
    const settle = vi.fn().mockResolvedValue(undefined);

    await expect(
      pollDeniedReasonLog({ attempts: 3, endpoint: ENDPOINT, readLogs, settle }),
    ).resolves.toEqual({
      line: COMPLETE_LINE,
      reason: `${ENDPOINT} is not allowed by any policy`,
    });
    expect(readLogs).toHaveBeenCalledTimes(2);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("reports the latest log tail when the event never settles", async () => {
    const readLogs = vi
      .fn()
      .mockResolvedValueOnce("first tail")
      .mockResolvedValueOnce("latest tail");
    const settle = vi.fn().mockResolvedValue(undefined);

    await expect(
      pollDeniedReasonLog({ attempts: 2, endpoint: ENDPOINT, readLogs, settle }),
    ).rejects.toThrow(
      `denied egress audit event for ${ENDPOINT} did not settle into nemoclaw logs --tail 50:\nlatest tail`,
    );
    expect(settle).toHaveBeenCalledTimes(2);
  });
});
