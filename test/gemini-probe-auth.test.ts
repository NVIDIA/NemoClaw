// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { getProbeAuthMode } from "../dist/lib/onboard";

describe("Gemini dual-auth credential fix (issue #1960)", () => {
  describe("getProbeAuthMode", () => {
    it("returns 'query-param' for gemini-api provider", () => {
      expect(getProbeAuthMode("gemini-api")).toBe("query-param");
    });

    it("returns undefined for non-Gemini providers", () => {
      expect(getProbeAuthMode("openai-api")).toBeUndefined();
      expect(getProbeAuthMode("nvidia-prod")).toBeUndefined();
      expect(getProbeAuthMode("anthropic-prod")).toBeUndefined();
      expect(getProbeAuthMode("compatible-endpoint")).toBeUndefined();
      expect(getProbeAuthMode("")).toBeUndefined();
    });
  });

  describe("compiled probe uses ?key= for Gemini instead of Bearer header", () => {
    const onboardSrc = fs.readFileSync(
      path.join(import.meta.dirname, "..", "dist", "lib", "onboard.js"),
      "utf-8",
    );

    it("contains query-param auth mode logic in probeOpenAiLikeEndpoint", () => {
      // The probe function must check for authMode === "query-param"
      expect(onboardSrc).toMatch(/authMode.*===.*"query-param"/);
    });

    it("appends ?key= to the URL when using query-param auth", () => {
      // The compiled code must build URLs with ?key= for query-param mode
      expect(onboardSrc).toMatch(/\?key=/);
    });

    it("getProbeAuthMode returns query-param for gemini-api", () => {
      expect(onboardSrc).toMatch(/gemini-api.*\?.*query-param|query-param.*gemini-api/);
    });
  });
});
