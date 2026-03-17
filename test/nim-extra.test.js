// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const nim = require("../bin/lib/nim");

describe("nim — extended coverage", () => {
  describe("getImageForModel edge cases", () => {
    it("returns null for empty string", () => {
      assert.equal(nim.getImageForModel(""), null);
    });

    it("returns null for undefined", () => {
      assert.equal(nim.getImageForModel(undefined), null);
    });

    it("returns null for partial model name", () => {
      assert.equal(nim.getImageForModel("nvidia/nemotron"), null);
    });

    it("is case-sensitive", () => {
      assert.equal(nim.getImageForModel("NVIDIA/NEMOTRON-3-NANO-30B-A3B"), null);
    });
  });

  describe("listModels content checks", () => {
    it("includes nemotron-3-super model", () => {
      const models = nim.listModels();
      const superModel = models.find((m) => m.name.includes("nemotron-3-super"));
      assert.ok(superModel, "should list nemotron-3-super model");
      assert.ok(superModel.image.includes("nvcr.io"), "image should be from nvcr.io");
    });

    it("all images point to nvcr.io/nim registry", () => {
      for (const m of nim.listModels()) {
        assert.ok(
          m.image.startsWith("nvcr.io/nim/"),
          `${m.name} image should start with nvcr.io/nim/, got: ${m.image}`,
        );
      }
    });

    it("no duplicate model names", () => {
      const names = nim.listModels().map((m) => m.name);
      assert.equal(new Set(names).size, names.length, "duplicate model names found");
    });

    it("no duplicate images", () => {
      const images = nim.listModels().map((m) => m.image);
      assert.equal(new Set(images).size, images.length, "duplicate images found");
    });
  });

  describe("containerName variations", () => {
    it("handles hyphenated names", () => {
      assert.equal(nim.containerName("my-sandbox"), "nemoclaw-nim-my-sandbox");
    });

    it("handles underscored names", () => {
      assert.equal(nim.containerName("my_sandbox"), "nemoclaw-nim-my_sandbox");
    });

    it("handles single character name", () => {
      assert.equal(nim.containerName("x"), "nemoclaw-nim-x");
    });

    it("handles empty string", () => {
      assert.equal(nim.containerName(""), "nemoclaw-nim-");
    });
  });
});
