// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  noteOnboardResumeHintShown,
  printOnboardResumeHint,
  resetOnboardResumeHintForTests,
} from "./resume-hint";

beforeEach(() => resetOnboardResumeHintForTests());
afterEach(() => resetOnboardResumeHintForTests());

describe("onboard resume hint", () => {
  it("prints the --resume recovery guidance through the injected logger", () => {
    const lines: string[] = [];
    printOnboardResumeHint((message) => lines.push(message));
    const text = lines.join("\n");
    expect(text).toContain("onboard --resume");
    expect(text).toContain("--fresh");
  });

  it("prints at most once per process", () => {
    const lines: string[] = [];
    printOnboardResumeHint((message) => lines.push(message));
    printOnboardResumeHint((message) => lines.push(message));
    expect(lines.filter((line) => line.includes("onboard --resume"))).toHaveLength(1);
  });

  it("stays silent once a tailored hint was noted", () => {
    const lines: string[] = [];
    noteOnboardResumeHintShown();
    printOnboardResumeHint((message) => lines.push(message));
    expect(lines).toHaveLength(0);
  });
});
