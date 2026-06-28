// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  printAgentRuntimeList: vi.fn(),
}));

vi.mock("../../lib/agent/list-command", () => ({
  printAgentRuntimeList: mocks.printAgentRuntimeList,
}));

import AgentsListCommand from "./list";

const rootDir = process.cwd();

describe("agents list oclif command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prints available global agent runtimes", async () => {
    await AgentsListCommand.run([], rootDir);

    expect(mocks.printAgentRuntimeList).toHaveBeenCalledWith(expect.any(Function));
  });
});
