// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { removeJobNeed } from "../../helpers/e2e-workflow-contract";

describe("E2E workflow test helpers", () => {
  it("refuses to remove a dependency from a later job", () => {
    const workflow = [
      "jobs:",
      "  owner:",
      "    needs:",
      "      [",
      "        present,",
      "      ]",
      "  later:",
      "    needs:",
      "      [",
      "        misplaced,",
      "      ]",
      "",
    ].join("\n");

    expect(() => removeJobNeed(workflow, "owner", "misplaced")).toThrow(
      "owner does not need misplaced",
    );
  });
});
