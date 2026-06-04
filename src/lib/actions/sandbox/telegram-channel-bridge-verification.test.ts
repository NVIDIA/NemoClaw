// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  getDefaultChannelAccount,
  printTelegramDirectMessageAllowlistWarning,
} from "./telegram-channel-bridge-verification";

describe("telegram channel bridge verification", () => {
  it("selects the default account when present", () => {
    const account = { dmPolicy: "allowlist", allowFrom: ["123"] };

    expect(getDefaultChannelAccount({ accounts: { other: {}, default: account } })).toBe(account);
  });

  it("falls back to the first account when default is absent", () => {
    const account = { dmPolicy: "allowlist", allowFrom: ["123"] };

    expect(getDefaultChannelAccount({ accounts: { main: account } })).toBe(account);
  });

  it("warns only when allowlist mode is active and no senders are configured", () => {
    const log = vi.fn();

    const emitted = printTelegramDirectMessageAllowlistWarning(
      { accounts: { default: { dmPolicy: "allowlist", allowFrom: [] } } },
      log,
      "WARN",
    );

    expect(emitted).toBe(true);
    expect(log.mock.calls.map(([line]) => line).join("\n")).toContain(
      "Telegram direct-message allowlist is empty",
    );
  });

  it("does not warn for pairing/default policy accounts", () => {
    const log = vi.fn();

    const emitted = printTelegramDirectMessageAllowlistWarning(
      { accounts: { default: { allowFrom: [] } } },
      log,
    );

    expect(emitted).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it("does not warn when allowlist mode has senders", () => {
    const log = vi.fn();

    const emitted = printTelegramDirectMessageAllowlistWarning(
      { accounts: { default: { dmPolicy: "allowlist", allowFrom: ["8388960805"] } } },
      log,
    );

    expect(emitted).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });
});
