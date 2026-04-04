// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { parseAllowedChatIds, isChatAllowed } from "../../dist/lib/chat-filter";

describe("lib/chat-filter", () => {
  describe("parseAllowedChatIds", () => {
    it("returns null for undefined input", () => {
      expect(parseAllowedChatIds(undefined)).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(parseAllowedChatIds("")).toBeNull();
    });

    it("returns null for whitespace-only string", () => {
      expect(parseAllowedChatIds("  , , ")).toBeNull();
    });

    it("parses single chat ID", () => {
      expect(parseAllowedChatIds("12345")).toEqual(["12345"]);
    });

    it("parses comma-separated chat IDs with whitespace", () => {
      expect(parseAllowedChatIds("111, 222 ,333")).toEqual(["111", "222", "333"]);
    });
  });

  describe("isChatAllowed", () => {
    it("allows all chats when allowed list is null", () => {
      expect(isChatAllowed(null, "999")).toBe(true);
    });

    it("allows chat in the allowed list", () => {
      expect(isChatAllowed(["111", "222"], "111")).toBe(true);
    });

    it("rejects chat not in the allowed list", () => {
      expect(isChatAllowed(["111", "222"], "999")).toBe(false);
    });
  });
});
