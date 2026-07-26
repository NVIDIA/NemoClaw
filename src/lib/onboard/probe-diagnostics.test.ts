// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { summarizeProbeForDisplay } from "./probe-diagnostics";

describe("summarizeProbeForDisplay", () => {
  it("summarizes HTTP statuses without raw response bodies", () => {
    const summary = summarizeProbeForDisplay({
      message: "Chat Completions API: HTTP 429: raw provider body with secret-key",
      failures: [
        {
          name: "Chat Completions API",
          httpStatus: 429,
          curlStatus: 0,
          message: "HTTP 429: raw provider body with secret-key",
          body: "raw provider body with secret-key",
        },
      ],
    });

    expect(summary).toBe("Chat Completions API: HTTP 429");
    expect(summary).not.toContain("secret-key");
    expect(summary).not.toContain("raw provider body");
  });

  it("summarizes curl/timeout failures without raw stderr", () => {
    const summary = summarizeProbeForDisplay({
      message: "curl failed (exit 28): operation timed out with token secret-key",
      failures: [
        {
          name: "Chat Completions API",
          httpStatus: 0,
          curlStatus: 28,
          message: "curl failed (exit 28): operation timed out with token secret-key",
          diagnosticCodes: ["anthropic-streaming-missing-message-stop"],
        },
      ],
    });

    expect(summary).toBe("Chat Completions API: curl exit 28");
    expect(summary).not.toContain("secret-key");
    expect(summary).not.toContain("operation timed out with token");
  });

  it("surfaces allowlisted streaming diagnostics without raw provider text (#6289)", () => {
    const summary = summarizeProbeForDisplay({
      message: "raw provider response with secret-key",
      failures: [
        {
          name: "Anthropic Messages API (streaming)",
          httpStatus: 200,
          curlStatus: 0,
          message: "raw provider response with secret-key",
          diagnosticCodes: [
            "anthropic-streaming-duplicate-message-start",
            "provider-controlled-diagnostic",
          ],
        },
      ],
    });

    expect(summary).toBe("Anthropic Messages API (streaming): duplicate message_start");
    expect(summary).not.toContain("secret-key");
    expect(summary).not.toContain("provider-controlled-diagnostic");
  });

  it("preserves streaming timeout recovery when a partial HTTP 200 stream times out", () => {
    const summary = summarizeProbeForDisplay({
      message: "partial stream with secret-key",
      failures: [
        {
          name: "Anthropic Messages API (streaming)",
          httpStatus: 200,
          curlStatus: 28,
          message: "partial stream with secret-key",
          diagnosticCodes: ["anthropic-streaming-missing-message-stop"],
        },
      ],
    });

    expect(summary).toBe("Anthropic Messages API (streaming): curl exit 28");
    expect(summary).not.toContain("secret-key");
    expect(summary).not.toContain("partial stream");
  });

  it("falls back to coarse message classification", () => {
    expect(summarizeProbeForDisplay({ message: "HTTP 404: not found for secret-key" })).toBe(
      "HTTP 404",
    );
    expect(summarizeProbeForDisplay({ message: "request timed out with secret-key" })).toBe(
      "timeout",
    );
  });
});
