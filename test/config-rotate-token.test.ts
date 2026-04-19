// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";

// Import pure helpers from the compiled output
const { validateUrlValue, extractDotpath, setDotpath } = require("../dist/lib/sandbox-config");

describe("config rotate-token helpers", () => {
  describe("readStdin export", () => {
    it("exports readStdin as a function", () => {
      const { readStdin } = require("../dist/lib/sandbox-config");
      expect(typeof readStdin).toBe("function");
    });
  });

  describe("configSet export", () => {
    it("exports configSet as a function", () => {
      const { configSet } = require("../dist/lib/sandbox-config");
      expect(typeof configSet).toBe("function");
    });
  });

  describe("configRotateToken export", () => {
    it("exports configRotateToken as a function", () => {
      const { configRotateToken } = require("../dist/lib/sandbox-config");
      expect(typeof configRotateToken).toBe("function");
    });
  });

  describe("URL validation edge cases for config set", () => {
    it("accepts NVIDIA build endpoint", () => {
      expect(() => validateUrlValue("https://integrate.api.nvidia.com/v1")).not.toThrow();
    });

    it("accepts OpenAI endpoint", () => {
      expect(() => validateUrlValue("https://api.openai.com/v1")).not.toThrow();
    });

    it("accepts Anthropic endpoint", () => {
      expect(() => validateUrlValue("https://api.anthropic.com/v1")).not.toThrow();
    });

    it("rejects 169.254.x.x (link-local)", () => {
      expect(() => validateUrlValue("http://169.254.1.1:80")).toThrow(/private/i);
    });

    it("rejects 0.x.x.x", () => {
      expect(() => validateUrlValue("http://0.0.0.0:80")).toThrow(/private/i);
    });

    it("passes through non-URL values without error", () => {
      expect(() => validateUrlValue("my-model-name")).not.toThrow();
      expect(() => validateUrlValue("true")).not.toThrow();
      expect(() => validateUrlValue("")).not.toThrow();
    });
  });

  describe("dotpath round-trip for config set", () => {
    it("set then extract returns the new value", () => {
      const config = { inference: { provider: "nvidia", model: "llama-3.3-70b" } };
      setDotpath(config, "inference.model", "gemini-2.5-flash");
      expect(extractDotpath(config, "inference.model")).toBe("gemini-2.5-flash");
      // Other fields preserved
      expect(extractDotpath(config, "inference.provider")).toBe("nvidia");
    });

    it("set preserves sibling keys at all levels", () => {
      const config = {
        a: { b: 1, c: 2 },
        d: 3,
      };
      setDotpath(config, "a.b", 99);
      expect(config).toEqual({ a: { b: 99, c: 2 }, d: 3 });
    });
  });
});
