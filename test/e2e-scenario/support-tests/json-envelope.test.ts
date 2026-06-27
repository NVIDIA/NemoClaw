// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parseJsonFromText } from "../live/json-envelope.ts";

describe("E2E JSON envelope parsing", () => {
  it("parses pretty JSON followed by diagnostic stderr warnings", () => {
    expect(
      parseJsonFromText(
        [
          "banner before JSON",
          "{",
          '  "sessions": [',
          '    { "key": "agent:main:main" }',
          "  ]",
          "}",
          "(node:123) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental",
        ].join("\n"),
      ),
    ).toEqual({ sessions: [{ key: "agent:main:main" }] });
  });

  it("throws when only warning-shaped output is present", () => {
    expect(() => parseJsonFromText("(node:123) [UNDICI-EHPA] Warning")).toThrow(
      /no JSON object or array found/,
    );
  });
});
