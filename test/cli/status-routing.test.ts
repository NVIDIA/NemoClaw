// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { run, runWithEnv, writeSandboxRegistry } from "./helpers";

describe("CLI status routing", () => {
  it("status --help exits 0 and shows status usage", () => {
    const r = run("status --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("status [--json]");
    expect(r.out).toContain("Show sandbox list and service status");
  });

  it("sandbox status --help advertises --json flag", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-sandbox-status-help-json-"));
    writeSandboxRegistry(home);
    const r = runWithEnv("sandbox status alpha --help", { HOME: home });
    expect(r.code).toBe(0);
    expect(r.out).toContain("--json");
    expect(r.out).toContain("$ nemoclaw sandbox status <name> [--json]");
    expect(r.out).toContain("$ nemoclaw sandbox status alpha --json");

    const alias = runWithEnv("alpha status --help", { HOME: home });
    expect(alias.code).toBe(0);
    expect(alias.out).toContain("--json");
  });

  it("status rejects unknown flags through current dispatch path", () => {
    const r = run("status --bogus");
    expect(r.code).toBe(2);
    expect(r.out).toContain("Nonexistent flag: --bogus");
  });

  it("status rejects unexpected positional arguments through current dispatch path", () => {
    const r = run("status bogus");
    expect(r.code).toBe(2);
    expect(r.out).toContain("Unexpected argument: bogus");
  });

  it("sandbox-first status rejects unexpected positional arguments through command-id dispatch", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-sandbox-status-extra-"));
    writeSandboxRegistry(home);

    const r = runWithEnv("alpha status extra", { HOME: home });

    expect(r.code).toBe(2);
    expect(r.out).toContain("Unexpected argument: extra");
  });
});
