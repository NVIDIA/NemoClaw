// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";

import {
  createPinnedV1Consumer,
  validateConfigExportWithPinnedV1,
} from "../../support/v1-config-consumer";

import { mockPinnedV1ConsumerBuilds } from "./fixtures/v1-config-consumer";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

it("reuses compilation while validating fresh exports after rejection or missing output", (context) => {
  const consumer = createPinnedV1Consumer();
  context.onTestFinished(consumer.dispose);
  const state = mockPinnedV1ConsumerBuilds();
  const { invocations, workspaces } = state;

  expect(() => consumer.validate("rejected")).toThrow("configuration violates schema");
  expect(consumer.validate('{"contextWindows":[4096]}')).toMatchObject({
    contextWindows: [4096],
  });
  expect(() => consumer.validate("missing-output")).toThrow(/ENOENT/u);
  expect(consumer.validate('{"contextWindows":[8192]}')).toMatchObject({
    contextWindows: [8192],
  });
  expect(state.builds).toBe(1);
  expect(new Set(invocations).size).toBe(4);
  expect(invocations.every((directory) => !fs.existsSync(directory))).toBe(true);
  expect([...workspaces].every((directory) => fs.existsSync(directory))).toBe(true);
  consumer.dispose();
  expect([...workspaces].every((directory) => !fs.existsSync(directory))).toBe(true);

  const next = createPinnedV1Consumer();
  context.onTestFinished(next.dispose);
  expect(next.validate('{"contextWindows":[16384]}')).toMatchObject({
    contextWindows: [16384],
  });
  expect(state.builds).toBe(2);
});

it("removes an incomplete checkout and prepares a new workspace after setup failure", (context) => {
  const consumer = createPinnedV1Consumer();
  context.onTestFinished(consumer.dispose);
  const roots: string[] = [];
  vi.mocked(execFileSync)
    .mockReturnValueOnce(Buffer.from(""))
    .mockImplementationOnce((_command, args) => {
      roots.push(path.dirname(String(args?.at(-1))));
      throw new Error("archive extraction failed");
    })
    .mockReturnValueOnce(Buffer.from(""))
    .mockImplementationOnce((_command, args) => {
      const checkout = String(args?.at(-1));
      roots.push(path.dirname(checkout));
      fs.mkdirSync(path.join(checkout, "crates/nemoclaw-sdk/tests"), { recursive: true });
      return Buffer.from("");
    })
    .mockReturnValueOnce(Buffer.from(""))
    .mockReturnValueOnce(Buffer.from('{"compiledSandboxes":1}'));

  expect(() => consumer.validate("first export")).toThrow("archive extraction failed");
  expect(roots).toHaveLength(1);
  expect(fs.existsSync(roots[0]!)).toBe(false);
  expect(consumer.validate("second export")).toMatchObject({ compiledSandboxes: 1 });
  expect(roots).toHaveLength(2);
  expect(roots[0]).not.toBe(roots[1]);
  consumer.dispose();
  expect(roots.every((directory) => !fs.existsSync(directory))).toBe(true);
});

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
