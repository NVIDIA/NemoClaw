// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runWithEnv, testTimeoutOptions, writeSandboxRegistry } from "./helpers";

describe("unknown sandbox action guidance (#755)", () => {
  it("lists valid actions and a concrete example command", testTimeoutOptions(15_000), () => {
    // The unknown-action path only triggers once the first token resolves to
    // a registered sandbox; otherwise dispatch reports an unknown command.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-unknown-action-"));
    writeSandboxRegistry(home, "alpha");

    // `2>&1` folds stderr into the captured output; the guidance is written to
    // stderr before the command exits non-zero.
    const r = runWithEnv("alpha definitely-not-an-action 2>&1", { HOME: home });

    expect(r.code).not.toBe(0);
    expect(r.out).toContain("Unknown action: definitely-not-an-action");
    expect(r.out).toContain("Valid actions:");
    // The concrete example uses the sandbox name the user actually typed.
    expect(r.out).toContain("alpha connect");
  });
});
