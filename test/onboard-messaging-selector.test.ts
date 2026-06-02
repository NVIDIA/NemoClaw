// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

const onboard = require("../dist/lib/onboard.js") as {
  applyMessagingSelectorKey: (
    key: string,
    enabled: Set<string>,
    availableChannels: Array<{ name: string; description: string }>,
  ) => string;
  normalizeMessagingSelectorInput: (text: string) => string;
};

const channels = [
  { name: "telegram", description: "Telegram bot messaging" },
  { name: "discord", description: "Discord bot messaging" },
  { name: "wechat", description: "WeChat bot messaging" },
];

describe("messaging channel selector key handling", () => {
  it("toggles numeric raw keypresses before Enter confirms", () => {
    const enabled = new Set<string>();

    expect(onboard.applyMessagingSelectorKey("1", enabled, channels)).toBe("redraw");
    expect([...enabled]).toEqual(["telegram"]);
    expect(onboard.applyMessagingSelectorKey("2", enabled, channels)).toBe("redraw");
    expect([...enabled]).toEqual(["telegram", "discord"]);
    expect(onboard.applyMessagingSelectorKey("\r", enabled, channels)).toBe("finish");
  });

  it("normalizes terminal keypad and extended numeric sequences", () => {
    expect(onboard.normalizeMessagingSelectorInput("\x1bOq")).toBe("1");
    expect(onboard.normalizeMessagingSelectorInput("\x1b[49;5u")).toBe("1");
  });
});
