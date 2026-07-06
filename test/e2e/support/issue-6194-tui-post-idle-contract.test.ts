// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const LIVE_TUI_SOURCE = "test/e2e/live/openclaw-tui-chat-correlation.test.ts";

describe("live TUI post-idle coverage contract (#6194)", () => {
  it("drives the real terminal TUI after connected idle", () => {
    const source = readFileSync(LIVE_TUI_SOURCE, "utf8");

    expect(source).toContain('"#6194"');
    expect(source).toContain("openclaw-tui-terminal-after-connected-idle");
    expect(source).toContain("spawn openshell sandbox exec --name $sandbox --tty");
    expect(source).toContain("openclaw tui");
    expect(source).toContain("connected[^\\\\r\\\\n]*idle");
    expect(source).toContain("NEMOCLAW6194_CHAT_OK");
    expect(source).toContain("/nemoclaw status");
    expect(source).toContain('send "\\\\003"');
    expect(source).toContain("ISSUE6194_MARK clean_exit");
  });
});
