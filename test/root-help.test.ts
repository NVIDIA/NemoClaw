// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { help as renderRootHelp } from "../src/lib/actions/root-help";

describe("root help", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("describes mutable-default config and host-side lockdown", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    renderRootHelp();

    const output = log.mock.calls.map(([line]) => String(line)).join("\n");
    expect(output).toContain("Agent config is writable in the default sandbox");
    expect(output).toContain("Use host-side commands or re-run onboard");
    expect(output).toContain("shields up");
    expect(output).not.toContain("Agent config is read-only inside the sandbox");
    expect(output).not.toContain("Landlock enforced");
  });
});
