// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { stateFileKeyMergeSpec } from "./state-file-key-merge";

describe("stateFileKeyMergeSpec", () => {
  it("maps declarative ownership to the python merge spec", () => {
    expect(
      stateFileKeyMergeSpec({
        merge: "key-allowlist",
        userKeys: [
          { key: "a.b", type: "boolean" },
          { key: "c", type: "enum", values: ["x"] },
          { key: "n", type: "integer", min: 1, max: 2 },
          { key: "s", type: "string", maxLength: 5 },
        ],
        requireFreshTables: ["t.u"],
        requireFreshHeaders: [{ match: "exact", value: "# h" }],
      }),
    ).toEqual({
      user_keys: [
        { path: ["a", "b"], type: "boolean" },
        { path: ["c"], type: "enum", values: ["x"] },
        { path: ["n"], type: "integer", min: 1, max: 2 },
        { path: ["s"], type: "string", max_length: 5 },
      ],
      require_fresh_tables: [["t", "u"]],
      require_fresh_headers: [{ match: "exact", value: "# h" }],
    });
  });
});
