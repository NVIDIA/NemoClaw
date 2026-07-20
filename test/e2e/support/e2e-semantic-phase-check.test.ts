// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import { validateTestScopedPhaseCalls } from "../../../tools/e2e/check-semantic-phases.mts";

describe("semantic E2E phase checker", () => {
  test("rejects phase transitions that belong to sibling tests", () => {
    const failures = validateTestScopedPhaseCalls(
      [
        { name: "GitHub download", phases: ["prepare GitHub", "download with GitHub"] },
        { name: "curl fallback", phases: ["prepare curl", "download with curl"] },
      ],
      [
        {
          file: "test/e2e/live/example.test.ts",
          line: 10,
          phaseCalls: [
            { file: "test/e2e/live/example.test.ts", line: 12, label: "download with curl" },
          ],
        },
        {
          file: "test/e2e/live/example.test.ts",
          line: 20,
          phaseCalls: [
            { file: "test/e2e/live/example.test.ts", line: 22, label: "download with GitHub" },
          ],
        },
      ],
    );

    expect(failures).toEqual([
      "test/e2e/live/example.test.ts:12: semantic phase is not declared by its test (GitHub download): download with curl",
      "test/e2e/live/example.test.ts:22: semantic phase is not declared by its test (curl fallback): download with GitHub",
    ]);
  });

  test("accepts transitions declared by their own tests", () => {
    expect(
      validateTestScopedPhaseCalls(
        [
          { name: "GitHub download", phases: ["prepare GitHub", "download with GitHub"] },
          { name: "curl fallback", phases: ["prepare curl", "download with curl"] },
        ],
        [
          {
            file: "test/e2e/live/example.test.ts",
            line: 10,
            phaseCalls: [
              { file: "test/e2e/live/example.test.ts", line: 12, label: "download with GitHub" },
            ],
          },
          {
            file: "test/e2e/live/example.test.ts",
            line: 20,
            phaseCalls: [
              { file: "test/e2e/live/example.test.ts", line: 22, label: "download with curl" },
            ],
          },
        ],
      ),
    ).toEqual([]);
  });
});
