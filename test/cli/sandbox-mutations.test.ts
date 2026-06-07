// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runWithEnv, writeSandboxRegistry } from "./helpers";

describe("CLI dispatch", () => {
  it("connect help uses native oclif usage through the public sandbox route", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-inspection-help-"));
    writeSandboxRegistry(home);

    const connect = runWithEnv("alpha connect --help", { HOME: home });

    expect(connect.code).toBe(0);
    expect(connect.out).toContain("Usage: nemoclaw alpha connect");
    expect(connect.out).not.toContain("sandbox:connect");
  });

  it("sandbox channels start rejects a sandbox missing from the registry (#4584)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-channels-missing-"));
    writeSandboxRegistry(home);

    const startMissing = runWithEnv("sandbox channels start does-not-exist telegram", { HOME: home });
    const stopMissing = runWithEnv("sandbox channels stop does-not-exist telegram", { HOME: home });

    expect(startMissing.code).toBe(1);
    expect(startMissing.out).toContain("Sandbox 'does-not-exist' not found in the registry.");
    expect(stopMissing.code).toBe(1);
    expect(stopMissing.out).toContain("Sandbox 'does-not-exist' not found in the registry.");
  });
});
