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
  const portableEnv = "NEMOCLAW_EXPERIMENTAL_PROFILE";

  it("prints the --resume recovery guidance through the injected logger", () => {
    const lines: string[] = [];
    printOnboardResumeHint(false, (message) => lines.push(message));
    const text = lines.join("\n");
    expect(text).toContain("onboard --resume");
    expect(text).toContain("--fresh");
  });

  it("prints the portable-profile recovery guidance when the portable env is set (#8873)", () => {
    const prev = process.env[portableEnv];
    process.env[portableEnv] = "portable";
    try {
      const lines: string[] = [];
      printOnboardResumeHint(undefined, (message) => lines.push(message));
      const text = lines.join("\n");
      expect(text).toContain("onboard --experimental-profile portable");
      expect(text).not.toContain("--resume");
    } finally {
      prev === undefined ? delete process.env[portableEnv] : (process.env[portableEnv] = prev);
    }
  });

  it("uses an explicit portable profile after the environment is restored (#8873)", () => {
    const prev = process.env[portableEnv];
    delete process.env[portableEnv];
    try {
      const lines: string[] = [];
      printOnboardResumeHint(true, (message) => lines.push(message));
      const text = lines.join("\n");
      expect(text).toContain("onboard --experimental-profile portable");
      expect(text).not.toContain("--resume");
    } finally {
      prev === undefined ? delete process.env[portableEnv] : (process.env[portableEnv] = prev);
    }
  });

  it("prints at most once per process", () => {
    const lines: string[] = [];
    printOnboardResumeHint(false, (message) => lines.push(message));
    printOnboardResumeHint(false, (message) => lines.push(message));
    expect(lines.filter((line) => line.includes("onboard --resume"))).toHaveLength(1);
  });

  it("stays silent once a tailored hint was noted", () => {
    const lines: string[] = [];
    noteOnboardResumeHintShown();
    printOnboardResumeHint(false, (message) => lines.push(message));
    expect(lines).toHaveLength(0);
  });
});
