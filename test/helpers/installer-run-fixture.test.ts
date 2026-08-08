// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { runInstallerSourcedBody } from "./installer-run-fixture";

describe("runInstallerSourcedBody", () => {
  it("leaves a caller-provided home caller-owned on remove", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-caller-home-"));
    onTestFinished(() => fs.rmSync(home, { recursive: true, force: true }));
    const sentinel = path.join(home, "sentinel.txt");
    fs.writeFileSync(sentinel, "keep");

    const run = runInstallerSourcedBody("true", { home });
    run.remove();

    expect(fs.existsSync(home)).toBe(true);
    expect(fs.readFileSync(sentinel, "utf-8")).toBe("keep");
  });

  it("removes a helper-created home on remove", () => {
    const run = runInstallerSourcedBody("true", { homePrefix: "nemoclaw-fixture-home-" });
    onTestFinished(() => run.remove());

    expect(fs.existsSync(run.home)).toBe(true);
    run.remove();
    expect(fs.existsSync(run.home)).toBe(false);
  });
});
