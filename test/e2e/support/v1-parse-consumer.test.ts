// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { expect, it, vi } from "vitest";

import { createV1ParseConsumer } from "../../support/v1-parse-consumer";
import { mockV1ParseBuilds } from "./fixtures/v1-parse-consumer";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

it("reuses one build, parses each export in a fresh directory, and disposes its checkout", (context) => {
  const consumer = createV1ParseConsumer();
  context.onTestFinished(consumer.dispose);
  const state = mockV1ParseBuilds();

  expect(() => consumer.parse("rejected")).toThrow("configuration violates schema");
  expect(consumer.parse('{"spec":{"a":1}}').document).toEqual({ spec: { a: 1 } });
  expect(() => consumer.parse("missing-output")).toThrow(/ENOENT/u);
  expect(consumer.parse('{"spec":{"a":2}}').document).toEqual({ spec: { a: 2 } });
  expect(state.builds).toBe(1);
  expect(new Set(state.invocations).size).toBe(4);
  expect(state.invocations.every((directory) => !fs.existsSync(directory))).toBe(true);
  expect([...state.workspaces].every((directory) => fs.existsSync(directory))).toBe(true);
  consumer.dispose();
  expect([...state.workspaces].every((directory) => !fs.existsSync(directory))).toBe(true);
});
