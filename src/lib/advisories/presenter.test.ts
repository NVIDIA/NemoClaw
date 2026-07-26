// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  assertNoBlocking,
  BlockingAdvisoryError,
  blockingAdvisories,
  formatAdvisories,
} from "./presenter";
import type { Advisory } from "./types";

const warning: Advisory = {
  id: "runtime_resources",
  severity: "warning",
  phase: "preflight.host",
  title: "Runtime resources are low",
  reason: "The sandbox build may stall.",
  commands: ["colima start --cpu 4 --memory 8"],
  docsUrl: "https://docs.example.test/runtime-resources",
  resumeSafe: false,
  kind: "manual",
};

const fatal: Advisory = {
  id: "docker_unreachable",
  severity: "fatal",
  phase: "preflight.host",
  title: "Docker is unreachable",
  reason: "The daemon did not answer.",
  resumeSafe: false,
};

describe("advisory presenter", () => {
  it("formats deterministic console and JSON representations", () => {
    expect(formatAdvisories([warning], "console")).toBe(
      [
        "[WARNING] Runtime resources are low (runtime_resources)",
        "  The sandbox build may stall.",
        "  Run: colima start --cpu 4 --memory 8",
        "  More: https://docs.example.test/runtime-resources",
      ].join("\n"),
    );
    expect(JSON.parse(formatAdvisories([warning], "json"))).toEqual([warning]);
  });

  it("classifies only fatal and blocking severities as blockers", () => {
    expect(blockingAdvisories([warning, fatal])).toEqual([fatal]);
    expect(() => assertNoBlocking([warning])).not.toThrow();
  });

  it("raises one structured error for all blockers", () => {
    expect(() => assertNoBlocking([warning, fatal])).toThrow(BlockingAdvisoryError);
    try {
      assertNoBlocking([fatal]);
    } catch (error) {
      expect(error).toBeInstanceOf(BlockingAdvisoryError);
      expect((error as BlockingAdvisoryError).advisories).toEqual([fatal]);
    }
  });
});
