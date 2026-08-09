// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  assertValidName,
  assertValidProviderName,
  isValidName,
  isValidProviderName,
  NAME_ALLOWED_FORMAT,
  NAME_MAX_LENGTH,
  NAME_VALID_PATTERN,
  PROVIDER_NAME_ALLOWED_FORMAT,
  PROVIDER_NAME_MAX_LENGTH,
  PROVIDER_NAME_VALID_PATTERN,
} from "./sandbox-name.cjs";

const REJECTED_DIAGNOSTIC_CASES: ReadonlyArray<readonly [string, string, string]> = [
  ["line feed and workflow command", "bad\n::error::forged", '"bad\\u000a::error::forged"'],
  ["carriage return", "bad\rforged", '"bad\\u000dforged"'],
  ["terminal escape", "bad\u001b[2Jforged", '"bad\\u001b[2Jforged"'],
  ["null byte", "bad\0forged", '"bad\\u0000forged"'],
  ["DEL control", "bad\u007fforged", '"bad\\u007fforged"'],
  ["C1 control", "bad\u0085forged", '"bad\\u0085forged"'],
  ["Unicode line separator", "bad\u2028forged", '"bad\\u2028forged"'],
  ["bidi override", "bad\u202eforged", '"bad\\u202eforged"'],
  ["non-ASCII surrogate pair", "bad😀forged", '"bad\\ud83d\\ude00forged"'],
  ["quote and backslash", 'bad"\\forged', '"bad\\"\\\\forged"'],
];

function errorMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("Expected validator to throw");
}

describe("sandbox and provider name canonical validators", () => {
  describe("isValidName", () => {
    it.each([
      "openclaw",
      "nvidia-router",
      "a",
      "a1",
      "my-sandbox-1",
      "a".repeat(NAME_MAX_LENGTH),
    ])("accepts the RFC 1035 label '%s'", (name) => {
      expect(isValidName(name)).toBe(true);
    });

    it.each([
      ["empty string", ""],
      ["leading dash (flag injection)", "-x"],
      ["flag-like", "--help"],
      ["trailing dash", "foo-"],
      ["leading digit", "1box"],
      ["uppercase", "Foo"],
      ["underscore", "my_box"],
      ["space", "a b"],
      ["command substitution", "$(id)"],
      ["semicolon", "mybox;id"],
      ["over length", "a".repeat(NAME_MAX_LENGTH + 1)],
    ])("rejects %s", (_label, name) => {
      expect(isValidName(name)).toBe(false);
    });

    it("rejects non-string input", () => {
      expect(isValidName(undefined)).toBe(false);
      expect(isValidName(123)).toBe(false);
      expect(isValidName(null)).toBe(false);
    });
  });

  describe("isValidProviderName", () => {
    it.each([
      "default",
      "Provider_1.prod",
      "a",
      `a${"b".repeat(PROVIDER_NAME_MAX_LENGTH - 1)}`,
    ])("accepts the supported provider name '%s'", (name) => {
      expect(isValidProviderName(name)).toBe(true);
      expect(PROVIDER_NAME_VALID_PATTERN.test(name)).toBe(true);
    });

    it.each([
      ["empty string", ""],
      ["leading dash", "-provider"],
      ["leading digit", "1provider"],
      ["space", "provider name"],
      ["slash", "provider/name"],
      ["command substitution", "$(id)"],
      ["over length", `a${"b".repeat(PROVIDER_NAME_MAX_LENGTH)}`],
    ])("rejects %s", (_label, name) => {
      expect(isValidProviderName(name)).toBe(false);
    });

    it("rejects non-string input", () => {
      expect(isValidProviderName(undefined)).toBe(false);
      expect(isValidProviderName(123)).toBe(false);
      expect(isValidProviderName(null)).toBe(false);
    });
  });

  describe("assertValidName", () => {
    it("returns the value unchanged for a valid name", () => {
      expect(assertValidName("openclaw", "sandbox name")).toBe("openclaw");
    });

    it("throws 'Invalid <label>' for a malformed name and uses the given label", () => {
      expect(() => assertValidName("--help", "sandbox name")).toThrow(/Invalid sandbox name/);
      expect(() => assertValidProviderName("--help")).toThrow(/Invalid provider name/);
    });

    it("names the canonical allowed format in the error message", () => {
      expect(() => assertValidName("Bad")).toThrow(NAME_ALLOWED_FORMAT);
      expect(() => assertValidProviderName("1provider")).toThrow(PROVIDER_NAME_ALLOWED_FORMAT);
    });

    it("bounds long rejected input and uses an ASCII truncation marker", () => {
      const longName = "a".repeat(200);
      const message = errorMessage(() => assertValidName(longName, "sandbox name"));
      expect(message).toContain(`"${"a".repeat(80)}..."`);
      expect(message).not.toContain(longName);
      expect(message).toMatch(/^[\x20-\x7e]+$/);
    });

    it.each(
      REJECTED_DIAGNOSTIC_CASES,
    )("escapes %s as printable ASCII", (_label, value, escaped) => {
      const message = errorMessage(() => assertValidName(value, "sandbox name"));
      expect(message).toContain(escaped);
      expect(message).toMatch(/^[\x20-\x7e]+$/);
      expect(message).not.toContain(value);
    });

    it("uses the same escaped diagnostic boundary for provider names", () => {
      const message = errorMessage(() => assertValidProviderName("bad\n::warning::forged"));
      expect(message).toContain('"bad\\u000a::warning::forged"');
      expect(message).toMatch(/^[\x20-\x7e]+$/);
    });

    it("never returns a value with a shell metacharacter or leading dash (property)", () => {
      fc.assert(
        fc.property(fc.string(), (candidate) => {
          let returned: string | null = null;
          try {
            returned = assertValidName(candidate);
          } catch {
            // Rejection is always acceptable, but assert it so the property
            // still records an expectation when every candidate is rejected
            // (the plugin project enables expect.requireAssertions).
            expect(isValidName(candidate)).toBe(false);
            return;
          }
          // If it returned, the accepted value must be a safe RFC 1035 label.
          expect(returned).toBe(candidate);
          expect(NAME_VALID_PATTERN.test(returned)).toBe(true);
          expect(returned.startsWith("-")).toBe(false);
          expect(/[^a-z0-9-]/.test(returned)).toBe(false);
        }),
      );
    });
  });
});
