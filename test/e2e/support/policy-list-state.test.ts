// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parsePolicyPresetState } from "../live/policy-list-state.ts";

describe("policy-list state parser", () => {
  it("accepts the current user-added provenance row", () => {
    const output = [
      "  Policy presets for sandbox 'alpha':",
      "    ● telegram [user-added] — Telegram Bot API access",
      "    ○ tavily — Tavily web search API access (opt-in)",
      "",
    ].join("\n");

    expect(parsePolicyPresetState(output, "telegram")).toBe("active");
    expect(parsePolicyPresetState(output, "tavily")).toBe("inactive");
  });

  it("accepts bounded tier and agent provenance rows", () => {
    const output = [
      "    ● npm [from balanced tier] — npm and Yarn registry access",
      "    ● nous-web [from hermes agent] — Nous Portal web access",
    ].join("\r\n");

    expect(parsePolicyPresetState(output, "npm")).toBe("active");
    expect(parsePolicyPresetState(output, "nous-web")).toBe("active");
  });

  it("reports reconciled and unreachable states separately", () => {
    expect(
      parsePolicyPresetState(
        "    ● telegram [source unverified] — Telegram access (active on gateway, missing from local state)",
        "telegram",
      ),
    ).toBe("drift");
    expect(
      parsePolicyPresetState(
        "    ○ telegram — Telegram access (recorded locally, not active on gateway)",
        "telegram",
      ),
    ).toBe("drift");
    expect(
      parsePolicyPresetState(
        "  ⚠ Could not query gateway — showing local state only.\n    ● telegram [user-added] — Telegram access",
        "telegram",
      ),
    ).toBe("unverified");
    expect(
      parsePolicyPresetState(
        "    ● telegram [source unverified (gateway unreachable)] — Telegram access",
        "telegram",
      ),
    ).toBe("unverified");
    expect(parsePolicyPresetState("sandbox cannot be verified or started", "telegram")).toBe(
      "unverified",
    );
  });

  it.each([
    ["preset name prefix", "    ● telegram-extra [user-added] — Telegram access"],
    ["description-only name", "    ● slack [user-added] — includes telegram — access"],
    ["unknown provenance", "    ● telegram [restored somehow] — Telegram access"],
    ["unbounded provenance", `    ● telegram [from ${"a".repeat(65)} agent] — Telegram access`],
    ["provenance on an inactive row", "    ○ telegram [user-added] — Telegram access"],
    ["unreconciled source without drift", "    ● telegram [source unverified] — Telegram access"],
  ])("fails closed for %s", (_label, output) => {
    expect(parsePolicyPresetState(output, "telegram")).toBe("missing");
  });

  it("fails closed when the requested preset row is duplicated", () => {
    const row = "    ● telegram [user-added] — Telegram access";
    expect(parsePolicyPresetState(`${row}\n${row}`, "telegram")).toBe("missing");
  });

  it("rejects an out-of-contract requested preset name", () => {
    expect(
      parsePolicyPresetState("    ● telegram.* [user-added] — Telegram access", "telegram.*"),
    ).toBe("missing");
  });
});
