// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { isAnyPromptActive, markPromptActive } from "./prompt-activity";

describe("prompt activity registry", () => {
  it("reports activity only between mark and release (#6651)", () => {
    expect(isAnyPromptActive()).toBe(false);
    const release = markPromptActive();
    expect(isAnyPromptActive()).toBe(true);
    release();
    expect(isAnyPromptActive()).toBe(false);
  });

  it("stays active until every overlapping prompt releases", () => {
    const releaseFirst = markPromptActive();
    const releaseSecond = markPromptActive();
    releaseFirst();
    expect(isAnyPromptActive()).toBe(true);
    releaseSecond();
    expect(isAnyPromptActive()).toBe(false);
  });

  it("ignores duplicate releases from defensive error paths", () => {
    const releaseFirst = markPromptActive();
    releaseFirst();
    releaseFirst();
    const releaseSecond = markPromptActive();
    expect(isAnyPromptActive()).toBe(true);
    releaseSecond();
    expect(isAnyPromptActive()).toBe(false);
  });
});
