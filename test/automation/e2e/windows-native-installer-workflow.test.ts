// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  readOpenedRegularFile,
  resolveBrokerUpstreamUrl,
  validatedChatMessages,
} from "../../../packaging/windows/runtime/native-security.mts";

describe("native Windows runtime security boundaries", () => {
  it("keeps broker request targets on the configured provider origin", () => {
    expect(
      resolveBrokerUpstreamUrl(
        "https://provider.example/v1",
        "/v1/chat/completions?stream=false",
      ).toString(),
    ).toBe("https://provider.example/v1/chat/completions?stream=false");
    expect(() =>
      resolveBrokerUpstreamUrl("https://provider.example/v1", "/v1//attacker.example/steal"),
    ).toThrow(/escape the configured provider origin/u);
    expect(() =>
      resolveBrokerUpstreamUrl("https://provider.example/v1", "/v1/\\attacker.example\\steal"),
    ).toThrow(/escape the configured provider origin/u);
    expect(() => resolveBrokerUpstreamUrl("http://provider.example/v1", "/v1/models")).toThrow(
      /provider endpoint violates/u,
    );
    expect(resolveBrokerUpstreamUrl("http://127.0.0.1:8000/v1", "/v1/models").origin).toBe(
      "http://127.0.0.1:8000",
    );
  });

  it("opens relay files once and rejects non-files or oversized content", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-security-"));
    try {
      const file = path.join(directory, "token");
      fs.writeFileSync(file, "bounded", "utf8");
      expect(readOpenedRegularFile(file, { encoding: "utf8", maxBytes: 7 })).toBe("bounded");
      expect(() => readOpenedRegularFile(file, { encoding: "utf8", maxBytes: 6 })).toThrow(
        /exceeds its limit/u,
      );
      expect(() => readOpenedRegularFile(directory, { encoding: "utf8" })).toThrow(
        /not a regular file/u,
      );
      expect(
        readOpenedRegularFile(path.join(directory, "missing"), { encoding: "utf8" }),
      ).toBeNull();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("projects NemoCUA model requests through a bounded message schema", () => {
    expect(
      validatedChatMessages({
        messages: [{ role: "user", content: "observe the bounded page" }],
        tools: [{ type: "untrusted" }],
      }),
    ).toEqual([{ role: "user", content: "observe the bounded page" }]);
    expect(() =>
      validatedChatMessages({ messages: [{ role: "tool", content: "secret" }] }),
    ).toThrow(/invalid message/u);
    expect(() =>
      validatedChatMessages({ messages: [{ role: "user", content: "x".repeat(64 * 1024 + 1) }] }),
    ).toThrow(/exceeds its limit/u);
  });
});
