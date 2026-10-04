// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  parsePolicyPresetState,
  parseVerifiedActivePolicyPresets,
} from "../live/policy-list-state.ts";

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
    ["active row without provenance", "    ● telegram — Telegram access"],
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

describe("verified policy-list parser (#7617)", () => {
  const header = "  Policy presets for sandbox 'alpha':";
  const active = "    ● telegram [user-added] — Telegram Bot API access";
  const inactive = "    ○ tavily — Tavily web search API access (opt-in)";
  const expected = ["telegram", "tavily"];

  it("returns only active presets from a verified listing", () => {
    expect(
      parseVerifiedActivePolicyPresets([header, active, inactive, ""].join("\n"), expected),
    ).toEqual(["telegram"]);
  });

  it.each([
    ["a missing header", [active, inactive].join("\n")],
    ["an empty listing", header],
    ["a malformed row", [header, active, "    ○ tavily (opt-in)"].join("\n")],
    [
      "a malformed conflicting bullet",
      [header, inactive, "    ●telegram [user-added] — contradictory active row"].join("\n"),
    ],
    ["a duplicate row", [header, active, active, inactive].join("\n")],
    ["a truncated listing", [header, inactive].join("\n")],
    [
      "an unreachable gateway",
      [header, "  ⚠ Could not query gateway — showing local state only.", active, inactive].join(
        "\n",
      ),
    ],
    [
      "an unverified source",
      [
        header,
        "    ● telegram [source unverified (gateway unreachable)] — Telegram Bot API access",
        inactive,
      ].join("\n"),
    ],
  ])("fails closed for %s", (_label, output) => {
    expect(parseVerifiedActivePolicyPresets(output, expected)).toBeNull();
  });

  it("fails closed when the expected preset contract is empty, duplicated, or invalid", () => {
    const output = [header, active, inactive].join("\n");
    expect(parseVerifiedActivePolicyPresets(output, [])).toBeNull();
    expect(parseVerifiedActivePolicyPresets(output, ["telegram", "telegram"])).toBeNull();
    expect(parseVerifiedActivePolicyPresets(output, ["telegram", "bad preset"])).toBeNull();
  });
});
