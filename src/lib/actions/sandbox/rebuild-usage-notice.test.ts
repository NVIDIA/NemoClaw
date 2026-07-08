// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { NOTICE_ACCEPT_ENV } from "../../onboard/usage-notice";
import { ensureRebuildUsageNoticeAccepted } from "./rebuild-usage-notice";

describe("ensureRebuildUsageNoticeAccepted", () => {
  it("does not treat rebuild confirmation as notice acceptance", async () => {
    const ensureConsent = vi.fn().mockResolvedValue(false);

    await expect(
      ensureRebuildUsageNoticeAccepted({ ensureConsent, env: {}, stdinIsTty: false }),
    ).resolves.toBe(false);
    expect(ensureConsent).toHaveBeenCalledWith(
      expect.objectContaining({ nonInteractive: true, acceptedByFlag: false }),
    );
  });

  it("honors only the dedicated non-interactive acceptance env", async () => {
    const ensureConsent = vi.fn().mockResolvedValue(true);

    await ensureRebuildUsageNoticeAccepted({
      ensureConsent,
      env: { [NOTICE_ACCEPT_ENV]: "1" },
      stdinIsTty: false,
    });
    expect(ensureConsent).toHaveBeenCalledWith(
      expect.objectContaining({ nonInteractive: true, acceptedByFlag: true }),
    );
  });

  it("keeps an attached terminal interactive unless explicitly configured otherwise", async () => {
    const ensureConsent = vi.fn().mockResolvedValue(true);

    await ensureRebuildUsageNoticeAccepted({ ensureConsent, env: {}, stdinIsTty: true });
    expect(ensureConsent).toHaveBeenCalledWith(
      expect.objectContaining({ nonInteractive: false, acceptedByFlag: false }),
    );
  });
});
