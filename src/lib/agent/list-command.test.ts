// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("./defs", () => ({
  getAgentChoices: vi.fn(() => []),
}));

import { renderAgentRuntimeList } from "./list-command";

describe("agent runtime list command support", () => {
  it("renders available agent runtimes and descriptions in aligned columns", () => {
    expect(
      renderAgentRuntimeList([
        { name: "openclaw", description: "Gateway-based AI agent with plugin ecosystem" },
        { name: "hermes", description: "Self-improving AI agent with learning loop" },
        {
          name: "langchain-deepagents-code",
          description: "Terminal coding agent built on the Deep Agents SDK",
        },
      ]),
    ).toBe(
      [
        "openclaw                   Gateway-based AI agent with plugin ecosystem",
        "hermes                     Self-improving AI agent with learning loop",
        "langchain-deepagents-code  Terminal coding agent built on the Deep Agents SDK",
      ].join("\n"),
    );
  });

  it("prints a fallback message when no runtimes are installed", () => {
    expect(renderAgentRuntimeList([])).toBe("No agent runtimes are installed.");
  });
});
