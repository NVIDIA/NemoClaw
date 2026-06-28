// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  API_KEY_SHAPE_PATTERN,
  apiKeyShapeCommand,
} from "../live/hermes-inference-switch-helpers.ts";

describe("Hermes inference switch command shape", () => {
  function matchesApiKeyShape(line: string): boolean {
    return (
      spawnSync("grep", ["-Eq", API_KEY_SHAPE_PATTERN], {
        encoding: "utf8",
        input: `${line}\n`,
      }).status === 0
    );
  }

  it("uses direct single-line argv for the in-sandbox API-key probe", () => {
    const command = apiKeyShapeCommand();

    expect(command).toEqual(["grep", "-Eq", API_KEY_SHAPE_PATTERN, "/sandbox/.hermes/config.yaml"]);
    expect(command.every((argument) => !/[\r\n]/u.test(argument))).toBe(true);
  });

  it("accepts only complete sk-prefixed YAML scalars", () => {
    expect(
      ["  api_key: sk-value", '  api_key: "sk-value"', "  api_key: 'sk-value'"].every(
        matchesApiKeyShape,
      ),
    ).toBe(true);
    expect(
      [
        "  api_key: not-sk-value",
        "  api_key: sk-value trailing",
        '  api_key: "sk-value',
        '  api_key: sk-value"',
      ].some(matchesApiKeyShape),
    ).toBe(false);
  });
});
