// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { run, runWithEnv, writeSandboxRegistry } from "./helpers";

describe("CLI status routing process contracts", () => {
  it("status --help exits 0 and shows status usage", () => {
    const result = run("status --help");

    expect(result.code).toBe(0);
    expect(result.out).toContain("status [--json]");
    expect(result.out).toContain("Show global sandbox and host service status");
    expect(result.out).toContain("Use `<name> status` for one sandbox");
  });

  it("sandbox-first status rejects unexpected positional arguments through command-id dispatch", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-sandbox-status-extra-"));
    writeSandboxRegistry(home);

    const result = runWithEnv("alpha status extra", { HOME: home });

    expect(result.code).toBe(2);
    expect(result.out).toContain("Unexpected argument: extra");
  });

  it("never emits an unsafe sandbox token in a copy-paste status command", () => {
    const result = run("status 'alpha;echo pwned'");

    expect(result.code).toBe(2);
    expect(result.out).toContain("Unexpected argument: alpha;echo pwned");
    expect(result.out).not.toContain("Run:");
  });
});
