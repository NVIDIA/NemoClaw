// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("../adapters/openshell/client.js", () => {
  const asComparable = (value: string): string =>
    String(value)
      .split(".")
      .map((part) => part.padStart(6, "0"))
      .join(".");
  return {
    versionGte: (left = "0.0.0", right = "0.0.0") => asComparable(left) >= asComparable(right),
  };
});

import {
  CALENDAR_VERSION_PATTERN,
  classifyExpectedVersion,
  classifyObservedVersion,
  classifyVersionShape,
  evaluateStaleness,
  versionsComparable,
} from "./version-scheme";

describe("classifyVersionShape", () => {
  it.each([
    ["2026.5.27", "calendar"],
    ["2026.6.19", "calendar"],
    ["2099.12.31", "calendar"],
    ["9999.12.31", "calendar"],
    ["3000.1.1", "calendar"],
  ])("classifies %s as calendar", (value, expected) => {
    expect(classifyVersionShape(value)).toBe(expected);
  });

  it.each([
    ["0.17.0", "semver"],
    ["1.2.3", "semver"],
    ["1000.0.0", "semver"],
    ["2000.0.0", "semver"],
    ["2019.12.31", "semver"],
    ["999.9.9", "semver"],
  ])("classifies %s as semver", (value, expected) => {
    expect(classifyVersionShape(value)).toBe(expected);
  });

  it("uses the exported regex directly", () => {
    expect(CALENDAR_VERSION_PATTERN.test("2026.5.27")).toBe(true);
    expect(CALENDAR_VERSION_PATTERN.test("2000.0.0")).toBe(false);
  });
});

describe("classifyExpectedVersion", () => {
  it("prefers the declared manifest scheme", () => {
    expect(classifyExpectedVersion("semver", "2026.5.27")).toBe("semver");
    expect(classifyExpectedVersion("calendar", "0.17.0")).toBe("calendar");
  });

  it("falls back to shape when no scheme is declared", () => {
    expect(classifyExpectedVersion(null, "2026.5.27")).toBe("calendar");
    expect(classifyExpectedVersion(null, "0.17.0")).toBe("semver");
  });
});

describe("classifyObservedVersion", () => {
  it("ignores manifest scheme so a legacy cache surfaces as its actual shape", () => {
    expect(classifyObservedVersion("0.17.0")).toBe("semver");
    expect(classifyObservedVersion("2026.6.19")).toBe("calendar");
  });
});

describe("versionsComparable", () => {
  it("returns true when observed shape matches the declared or heuristic scheme", () => {
    expect(versionsComparable("semver", "0.17.0", "0.17.0")).toBe(true);
    expect(versionsComparable(null, "2026.5.27", "2026.6.19")).toBe(true);
  });

  it("returns false when the observed shape disagrees with the declared scheme", () => {
    expect(versionsComparable("semver", "2026.5.27", "0.17.0")).toBe(false);
    expect(versionsComparable("calendar", "0.17.0", "2026.6.19")).toBe(false);
  });
});

describe("evaluateStaleness", () => {
  it("returns not stale when versions match under a shared scheme", () => {
    expect(evaluateStaleness("openclaw-sb", "calendar", "2026.5.27", "2026.5.27")).toEqual({
      isStale: false,
      schemeMismatch: false,
    });
  });

  it("flags a stale same-scheme version behind the expected pin", () => {
    expect(evaluateStaleness("openclaw-sb", "calendar", "2026.3.11", "2026.5.27")).toEqual({
      isStale: true,
      schemeMismatch: false,
    });
  });

  it("fails closed on scheme mismatch so the rebuild flow realigns runtime and manifest", () => {
    expect(evaluateStaleness("hermes-sb", "semver", "2026.6.19", "0.17.0")).toEqual({
      isStale: true,
      schemeMismatch: true,
    });
  });

  it("flags a calendar-scheme agent (OpenClaw) running a semver runtime as scheme-mismatched", () => {
    expect(evaluateStaleness("openclaw-sb", "calendar", "1.2.3", "2026.5.27")).toEqual({
      isStale: true,
      schemeMismatch: true,
    });
  });

  it("falls back to shape classification when no manifest scheme is declared", () => {
    expect(evaluateStaleness("sb", null, "0.17.0", "0.17.0")).toEqual({
      isStale: false,
      schemeMismatch: false,
    });
    expect(evaluateStaleness("sb", null, "2026.5.27", "2026.5.27")).toEqual({
      isStale: false,
      schemeMismatch: false,
    });
    expect(evaluateStaleness("sb", null, "0.17.0", "2026.5.27")).toEqual({
      isStale: true,
      schemeMismatch: true,
    });
  });

  it("emits a structured JSON payload to stderr on scheme mismatch", () => {
    const stderr: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      evaluateStaleness("hermes-warn-sb", "semver", "2026.7.4", "0.18.0");
    } finally {
      process.stderr.write = originalWrite;
    }
    const line = stderr.join("");
    const jsonStart = line.indexOf("{");
    const payload = JSON.parse(line.slice(jsonStart).trim());
    expect(payload).toEqual({
      event: "sandbox_version_scheme_mismatch",
      sandbox: "hermes-warn-sb",
      sandboxVersion: "2026.7.4",
      expectedVersion: "0.18.0",
      action: "flagged_as_stale",
    });
  });
});
