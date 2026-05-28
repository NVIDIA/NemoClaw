// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
// Import from compiled dist/ so coverage is attributed correctly.
import { promptOrDefault } from "../../../dist/lib/onboard/prompt-helpers";

function makeDeps(promptReply: string) {
  return {
    isNonInteractive: () => false,
    note: vi.fn(),
    prompt: vi.fn().mockResolvedValue(promptReply),
  };
}

describe("promptOrDefault interactive default fallback (#4387)", () => {
  it("returns defaultValue when the user just presses Enter (empty reply)", async () => {
    const deps = makeDeps("");
    expect(await promptOrDefault(deps, "  Choose [6]: ", null, "6")).toBe("6");
  });

  it("treats a whitespace-only reply as the default", async () => {
    const deps = makeDeps("   ");
    expect(await promptOrDefault(deps, "  Choose [6]: ", null, "6")).toBe("6");
  });

  it("returns the user's reply verbatim when non-empty", async () => {
    const deps = makeDeps("3");
    expect(await promptOrDefault(deps, "  Choose [6]: ", null, "6")).toBe("3");
  });
});
