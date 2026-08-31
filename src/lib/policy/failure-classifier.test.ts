// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { PolicyContext } from "./context-builder";
import { classifyAccessFailure } from "./failure-classifier";

function context(verification: "verified" | "gateway-unavailable" = "verified"): PolicyContext {
  return {
    sandboxName: "alpha",
    tier: null,
    activePresets: [
      {
        name: "slack",
        description: "Slack",
        allowedHostCategories: ["slack.com"],
        redactedHostCount: 0,
        source: "builtin",
        verification,
      },
    ],
    knownUnappliedPresets: [],
    approvalPath: {
      inspect: "nemoclaw alpha policy list",
      add: "nemoclaw alpha policy add <preset>",
      remove: "nemoclaw alpha policy remove <preset>",
      excludeBaseline: "nemoclaw alpha policy exclude <key> --dry-run",
      restoreBaseline: "nemoclaw alpha policy restore <key>",
      documentation: "docs/network-policy/customize-network-policy.mdx",
    },
    supportBoundaries: [],
    generatedAt: "2026-08-27T00:00:00.000Z",
  };
}

describe("access failure classification", () => {
  it("uses live verified preset state for a high-confidence missing approval", () => {
    expect(
      classifyAccessFailure({
        sandboxName: "alpha",
        host: "api.slack.com",
        error: { status: 401 },
        context: context(),
      }),
    ).toEqual(expect.objectContaining({ kind: "missing-approval", confidence: "high" }));
  });

  it("keeps an unavailable live observation advisory", () => {
    expect(
      classifyAccessFailure({
        sandboxName: "alpha",
        host: "api.slack.com",
        error: { code: "ETIMEDOUT" },
        context: context("gateway-unavailable"),
      }),
    ).toEqual(expect.objectContaining({ kind: "blocked-by-policy", confidence: "low" }));
  });

  it("classifies an undeclared host as blocked by policy", () => {
    expect(
      classifyAccessFailure({
        sandboxName: "alpha",
        host: "unknown.example",
        error: { code: "ENETUNREACH" },
        context: context(),
      }).kind,
    ).toBe("blocked-by-policy");
  });

  it("reports unsupported capabilities before network heuristics", () => {
    expect(
      classifyAccessFailure({
        sandboxName: "alpha",
        host: "api.slack.com",
        capability: { supported: false, reason: "not available" },
        context: context(),
      }).kind,
    ).toBe("unsupported");
  });

  it("treats a network error on a live verified preset as upstream-unknown", () => {
    expect(
      classifyAccessFailure({
        sandboxName: "alpha",
        host: "api.slack.com",
        error: { code: "EHOSTUNREACH" },
        context: context(),
      }),
    ).toEqual(expect.objectContaining({ kind: "unknown", confidence: "high" }));
  });

  it("keeps HTTP 403 on an active host ambiguous", () => {
    expect(
      classifyAccessFailure({
        sandboxName: "alpha",
        host: "api.slack.com",
        error: { status: 403 },
        context: context(),
      }),
    ).toEqual(expect.objectContaining({ kind: "missing-approval", confidence: "low" }));
  });

  it("reports a known but live-unapplied host as blocked by policy", () => {
    const ctx = context();
    ctx.activePresets = [];
    ctx.knownUnappliedPresets = [
      {
        name: "github",
        description: "GitHub",
        allowedHostCategories: ["github.com"],
        redactedHostCount: 0,
        source: "builtin",
        verification: "gateway-unavailable",
      },
    ];
    expect(
      classifyAccessFailure({
        sandboxName: "alpha",
        host: "api.github.com",
        error: { status: 403 },
        context: ctx,
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "blocked-by-policy",
        matchedPreset: "github",
        confidence: "high",
      }),
    );
  });

  it("falls back to unknown when there is no policy or approval signal", () => {
    expect(
      classifyAccessFailure({
        sandboxName: "alpha",
        host: "unknown.example",
        error: { message: "application failed" },
        context: context(),
      }).kind,
    ).toBe("unknown");
  });
});
