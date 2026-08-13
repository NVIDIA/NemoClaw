// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { allowRenderedOpenClawPlugins } from "./openclaw-plugin-allow";

describe("allowRenderedOpenClawPlugins", () => {
  it("adds an enabled rendered plugin to the existing allowlist (#8975)", () => {
    const config = { plugins: { allow: ["nemoclaw"], entries: {} } };

    allowRenderedOpenClawPlugins(config, [
      { path: "plugins.entries.telegram", value: { enabled: true } },
    ]);

    expect(config.plugins.allow).toEqual(["nemoclaw", "telegram"]);
  });

  it("does not allow a rendered plugin that remains disabled (#8975)", () => {
    const config = { plugins: { allow: ["nemoclaw"], entries: {} } };

    allowRenderedOpenClawPlugins(config, [
      { path: "plugins.entries.telegram", value: { enabled: false } },
    ]);

    expect(config.plugins.allow).toEqual(["nemoclaw"]);
  });

  it("rejects a non-array OpenClaw plugin allowlist (#8975)", () => {
    const config = { plugins: { allow: "nemoclaw", entries: {} } };

    expect(() =>
      allowRenderedOpenClawPlugins(config, [
        { path: "plugins.entries.telegram", value: { enabled: true } },
      ]),
    ).toThrow("OpenClaw plugins.allow must be an array.");
  });
});
