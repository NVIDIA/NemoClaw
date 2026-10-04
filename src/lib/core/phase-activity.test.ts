// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { currentPhaseActivityLabel, markPhaseActivity } from "./phase-activity";

describe("phase activity registry", () => {
  it("reports the label only between mark and release (#7156)", () => {
    expect(currentPhaseActivityLabel()).toBeNull();
    const release = markPhaseActivity("vLLM install");
    expect(currentPhaseActivityLabel()).toBe("vLLM install");
    release();
    expect(currentPhaseActivityLabel()).toBeNull();
  });

  it("reports the innermost label while sub-stages nest", () => {
    const releaseOuter = markPhaseActivity("outer setup");
    const releaseInner = markPhaseActivity("inner download");
    expect(currentPhaseActivityLabel()).toBe("inner download");
    releaseInner();
    expect(currentPhaseActivityLabel()).toBe("outer setup");
    releaseOuter();
    expect(currentPhaseActivityLabel()).toBeNull();
  });

  it("keeps the remaining label when spans release out of order", () => {
    const releaseOuter = markPhaseActivity("outer setup");
    const releaseInner = markPhaseActivity("inner download");
    releaseOuter();
    expect(currentPhaseActivityLabel()).toBe("inner download");
    releaseInner();
    expect(currentPhaseActivityLabel()).toBeNull();
  });

  it("ignores duplicate releases from defensive error paths", () => {
    const releaseFirst = markPhaseActivity("first sub-stage");
    releaseFirst();
    const releaseSecond = markPhaseActivity("second sub-stage");
    releaseFirst();
    expect(currentPhaseActivityLabel()).toBe("second sub-stage");
    releaseSecond();
    expect(currentPhaseActivityLabel()).toBeNull();
  });
});
