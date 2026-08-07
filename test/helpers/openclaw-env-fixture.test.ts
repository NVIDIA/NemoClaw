// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { baseOpenClawGenerationEnv, buildOpenClawTestEnv } from "./openclaw-env-fixture";

describe("baseOpenClawGenerationEnv", () => {
  it("returns an independent object per call", () => {
    const first = baseOpenClawGenerationEnv();
    const second = baseOpenClawGenerationEnv();

    expect(first).not.toBe(second);

    first.NEMOCLAW_MODEL = "mutated-model";
    first.EXTRA_KEY = "added";

    expect(second.NEMOCLAW_MODEL).toBe("test-model");
    expect(second.EXTRA_KEY).toBeUndefined();
  });
});

describe("buildOpenClawTestEnv", () => {
  it("composes without mutating the base entries or the overrides", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-env-fixture-"));
    onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
    const base = baseOpenClawGenerationEnv();
    const overrides = { NEMOCLAW_MODEL: "override-model", HOME: "/elsewhere" };

    const env = buildOpenClawTestEnv(dir, base, overrides);

    expect(env.NEMOCLAW_MODEL).toBe("override-model");
    expect(env.HOME).toBe(dir);
    expect(env.PATH.startsWith(`${dir}:`)).toBe(true);
    expect(fs.existsSync(path.join(dir, "openclaw"))).toBe(true);

    env.NEMOCLAW_MODEL = "mutated";
    expect(base.NEMOCLAW_MODEL).toBe("test-model");
    expect(overrides.NEMOCLAW_MODEL).toBe("override-model");
  });
});
