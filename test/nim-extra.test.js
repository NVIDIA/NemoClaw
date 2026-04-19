// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import * as nim from "../src/lib/nim.js";

describe("nim — extended coverage", () => {
  describe("getImageForModel edge cases", () => {
    it("returns null for empty string", () => {
      expect(nim.getImageForModel("")).toBe(null);
    });

    it("returns null for undefined", () => {
      expect(nim.getImageForModel(undefined)).toBe(null);
    });

    it("returns null for partial model name", () => {
      expect(nim.getImageForModel("nvidia/nemotron")).toBe(null);
    });

    it("is case-sensitive", () => {
      expect(nim.getImageForModel("NVIDIA/NEMOTRON-3-NANO-30B-A3B")).toBe(null);
    });
  });

  describe("listModels content checks", () => {
    it("includes nemotron-3-super model", () => {
      const models = nim.listModels();
      const superModel = models.find((m) => m.name.includes("nemotron-3-super"));
      expect(superModel).toBeTruthy();
      expect(superModel.image).toContain("nvcr.io");
    });

    it("all images point to nvcr.io/nim registry", () => {
      for (const m of nim.listModels()) {
        expect(m.image, `${m.name} image should start with nvcr.io/nim/`).toMatch(
          /^nvcr\.io\/nim\//,
        );
      }
    });

    it("no duplicate model names", () => {
      const names = nim.listModels().map((m) => m.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it("no duplicate images", () => {
      const images = nim.listModels().map((m) => m.image);
      expect(new Set(images).size).toBe(images.length);
    });
  });

  describe("containerName variations", () => {
    it("handles hyphenated names", () => {
      expect(nim.containerName("my-sandbox")).toBe("nemoclaw-nim-my-sandbox");
    });

    it("handles underscored names", () => {
      expect(nim.containerName("my_sandbox")).toBe("nemoclaw-nim-my_sandbox");
    });

    it("handles single character name", () => {
      expect(nim.containerName("x")).toBe("nemoclaw-nim-x");
    });

    it("handles empty string", () => {
      expect(nim.containerName("")).toBe("nemoclaw-nim-");
    });
  });
});
