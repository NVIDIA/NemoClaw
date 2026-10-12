// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";

import { validateConfigExportWithPinnedV1 } from "../../support/v1-config-consumer";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

it("retains terminal consumer failure output and removes its temporary workspace", () => {
  let consumer = "";
  vi.mocked(execFileSync)
    .mockReturnValueOnce(Buffer.from(""))
    .mockImplementationOnce((_command, args) => {
      consumer = String(args?.at(-1));
      fs.mkdirSync(path.join(consumer, "crates/nemoclaw-sdk/tests"), { recursive: true });
      return Buffer.from("");
    })
    .mockImplementationOnce((_command, _args, options) => {
      expect(options).toMatchObject({
        env: { CARGO_INCREMENTAL: "0", CARGO_PROFILE_DEV_DEBUG: "0" },
      });
      throw Object.assign(new Error("build progress".repeat(1_000)), {
        code: "ERR_CHILD_PROCESS",
        status: 101,
        signal: null,
        stdout: Buffer.from("progress\n".repeat(1_000) + "export must compile: invalid route"),
        stderr: Buffer.from("Downloading dependency\n".repeat(1_000) + "error: test failed"),
      });
    });

  let diagnostic = "";
  try {
    validateConfigExportWithPinnedV1("fixture export");
  } catch (error) {
    expect(error).not.toHaveProperty("cause");
    expect(error).not.toHaveProperty("stdout");
    expect(error).not.toHaveProperty("stderr");
    diagnostic = (error as Error).message;
  }
  expect(diagnostic).toContain("status=101, signal=none, code=ERR_CHILD_PROCESS");
  expect(diagnostic).toContain("export must compile: invalid route");
  expect(diagnostic).toContain("error: test failed");
  expect(diagnostic.length).toBeLessThan(2_048);
  expect(consumer).not.toBe("");
  expect(fs.existsSync(path.dirname(consumer))).toBe(false);
});
