// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { deniedReasonLogProof, pollDeniedReasonLog } from "../live/network-policy-denied-log.ts";

const ENDPOINT = "nemoclaw-prr-repro-long-hostname-for-truncation-test.example.invalid:443";
const COMPLETE_LINE = `[policy:-] [NET:OPEN] DENIED [reason:${ENDPOINT} is not allowed by any policy]`;
const ENCODED_SLASH_ENDPOINT = "openclaw.ai:443";
const ENCODED_SLASH_REASON =
  "request-target contains an encoded '/' (%2F) which is not allowed on this endpoint";
const GENERIC_OPENCLAW_LINE = `[NET:OPEN] DENIED node -> ${ENCODED_SLASH_ENDPOINT} [policy:- engine:opa] [reason:endpoint ${ENCODED_SLASH_ENDPOINT} is not allowed by any policy]`;
const ENCODED_SLASH_LINE = `[NET:OPEN] DENIED node -> ${ENCODED_SLASH_ENDPOINT} [policy:openclaw_api engine:l7] [reason:${ENCODED_SLASH_REASON}]`;

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

  it("does not accept the right endpoint with the wrong denial reason", () => {
    expect(
      deniedReasonLogProof(GENERIC_OPENCLAW_LINE, ENCODED_SLASH_ENDPOINT, ENCODED_SLASH_REASON),
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

  it("polls past an earlier generic denial for the same endpoint", async () => {
    const readLogs = vi
      .fn()
      .mockResolvedValueOnce(GENERIC_OPENCLAW_LINE)
      .mockResolvedValueOnce(`${GENERIC_OPENCLAW_LINE}\n${ENCODED_SLASH_LINE}`);
    const settle = vi.fn().mockResolvedValue(undefined);

    await expect(
      pollDeniedReasonLog({
        attempts: 3,
        endpoint: ENCODED_SLASH_ENDPOINT,
        reasonIncludes: ENCODED_SLASH_REASON,
        readLogs,
        settle,
      }),
    ).resolves.toEqual({
      line: ENCODED_SLASH_LINE,
      reason: ENCODED_SLASH_REASON,
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
