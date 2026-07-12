// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const START_SCRIPT = path.resolve(HERE, "..", "scripts", "nemoclaw-start.sh");

function requireNonNegative(value: number, message: string): number {
  return value >= 0
    ? value
    : (() => {
        throw new Error(message);
      })();
}

function extractShellFunction(scriptPath: string, name: string): string {
  const body = readFileSync(scriptPath, "utf8");
  const startMarker = `${name}() {`;
  const start = requireNonNegative(
    body.indexOf(startMarker),
    `function ${name} not found in ${scriptPath}`,
  );
  const lines = body.slice(start).split("\n");
  const endIndex = requireNonNegative(
    lines.findIndex((line, index) => index > 0 && line === "}"),
    `function ${name} missing closing brace in ${scriptPath}`,
  );
  return lines.slice(0, endIndex + 1).join("\n");
}

function runGuard(value: string): number {
  const functionBody = extractShellFunction(START_SCRIPT, "gateway_watchdog_positive_int_ok");
  const harness = `
${functionBody}
gateway_watchdog_positive_int_ok "$1"
`;
  const result = spawnSync("bash", ["-c", harness, "bash", value], {
    encoding: "utf-8",
    timeout: 10_000,
  });
  return result.status ?? -1;
}

describe("gateway watchdog numeric env guard", () => {
  it.each([
    ["1", 0],
    ["12", 0],
    ["30", 0],
    ["999", 0],
  ])("accepts positive integer %s", (input, expected) => {
    expect(runGuard(input)).toBe(expected);
  });

  it.each([
    ["", 1],
    ["0", 1],
    ["00", 1],
    ["12x", 1],
    ["30abc", 1],
    ["-5", 1],
    [" 5 ", 1],
    ["5.0", 1],
    ["one", 1],
  ])("rejects non-positive-integer %j", (input, expected) => {
    expect(runGuard(input)).toBe(expected);
  });
});
