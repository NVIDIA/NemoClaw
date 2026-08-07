// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createRunnerFsStore, inMemoryFsMethods } from "./runner-mock-fixtures.js";

describe("blueprint runner mock fixtures", () => {
  it("uses direct filesystem methods when no spy wrapper is supplied", () => {
    const { store } = createRunnerFsStore();
    const memory = inMemoryFsMethods(store);

    expect(memory.existsSync("/sandbox")).toBe(false);
    memory.mkdirSync("/sandbox");
    expect(memory.existsSync("/sandbox")).toBe(true);
  });
});
