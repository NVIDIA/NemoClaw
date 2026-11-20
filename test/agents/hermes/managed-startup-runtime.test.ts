// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("rebuilds the committed Hermes artifact from its shared runtime and cleanup binding", () => {
  const checked = spawnSync(
    process.execPath,
    ["agents/hermes/build-managed-startup-runtime.ts", "--check"],
    {
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  expect(checked.status, checked.stderr).toBe(0);
});

it("executes the isolated Hermes runtime entrypoint", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-startup-"));
  try {
    const executable = path.join(directory, "runtime.cjs");
    fs.copyFileSync("agents/hermes/managed-startup-image-runtime.bundle", executable);
    const result = spawnSync(process.execPath, [executable], { encoding: "utf8", timeout: 10_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage: managed-startup-image-runtime");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
