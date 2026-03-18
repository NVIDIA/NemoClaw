// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Import after mocks are set up
const { validateApiKey, maskApiKey } = await import("./validate.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockResponse(status: number, body: unknown, ok?: boolean): Response {
  return {
    ok: ok ?? (status >= 200 && status < 300),
    status,
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as Response;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe("validateApiKey", () => {
  const endpoint = "https://integrate.api.nvidia.com/v1";
  const apiKey = "test-placeholder-not-a-real-key";

  it("returns valid with model list on successful response", async () => {
    mockFetch.mockResolvedValue(
      mockResponse(200, {
        data: [{ id: "model-a" }, { id: "model-b" }],
      }),
    );

    const result = await validateApiKey(apiKey, endpoint);

    expect(result.valid).toBe(true);
    expect(result.models).toEqual(["model-a", "model-b"]);
    expect(result.error).toBeNull();
    expect(mockFetch).toHaveBeenCalledWith(
      "https://integrate.api.nvidia.com/v1/models",
      expect.objectContaining({
        headers: { Authorization: `Bearer ${apiKey}` },
      }),
    );
  });

  it("returns valid with empty model list when data is missing", async () => {
    mockFetch.mockResolvedValue(mockResponse(200, {}));

    const result = await validateApiKey(apiKey, endpoint);

    expect(result.valid).toBe(true);
    expect(result.models).toEqual([]);
    expect(result.error).toBeNull();
  });

  it("strips trailing slashes from endpoint URL", async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { data: [] }));

    await validateApiKey(apiKey, "https://example.com/v1///");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/v1/models",
      expect.anything(),
    );
  });

  it("returns error on 401 Unauthorized", async () => {
    mockFetch.mockResolvedValue(mockResponse(401, "Unauthorized", false));

    const result = await validateApiKey(apiKey, endpoint);

    expect(result.valid).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.error).toContain("HTTP 401");
    expect(result.error).toContain("Unauthorized");
  });

  it("returns error on 403 Forbidden", async () => {
    mockFetch.mockResolvedValue(mockResponse(403, "Forbidden", false));

    const result = await validateApiKey(apiKey, endpoint);

    expect(result.valid).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.error).toContain("HTTP 403");
  });

  it("returns error on 500 Internal Server Error", async () => {
    mockFetch.mockResolvedValue(
      mockResponse(500, "Internal Server Error", false),
    );

    const result = await validateApiKey(apiKey, endpoint);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("HTTP 500");
  });

  it("truncates long error bodies to 200 characters", async () => {
    const longBody = "x".repeat(500);
    mockFetch.mockResolvedValue(mockResponse(400, longBody, false));

    const result = await validateApiKey(apiKey, endpoint);

    expect(result.valid).toBe(false);
    // The error contains "HTTP 400: " prefix + 200 chars of body
    expect(result.error!.length).toBeLessThanOrEqual("HTTP 400: ".length + 200);
  });

  it("returns timeout error on AbortError", async () => {
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    mockFetch.mockRejectedValue(abortError);

    const result = await validateApiKey(apiKey, endpoint);

    expect(result.valid).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.error).toBe("Request timed out (10s)");
  });

  it("returns error message on network failure", async () => {
    mockFetch.mockRejectedValue(new TypeError("fetch failed"));

    const result = await validateApiKey(apiKey, endpoint);

    expect(result.valid).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.error).toBe("fetch failed");
  });

  it("handles non-Error rejection gracefully", async () => {
    mockFetch.mockRejectedValue("some string error");

    const result = await validateApiKey(apiKey, endpoint);

    expect(result.valid).toBe(false);
    expect(result.error).toBe("some string error");
  });
});

describe("maskApiKey", () => {
  it("masks short keys (≤ 8 chars) completely", () => {
    expect(maskApiKey("abc")).toBe("****");
    expect(maskApiKey("12345678")).toBe("****");
  });

  it("masks nvapi- prefixed keys with prefix preserved", () => {
    expect(maskApiKey("nvapi-abcdefghijk")).toBe("nvapi-****hijk");
  });

  it("masks regular keys showing last 4 characters", () => {
    expect(maskApiKey("sk-1234567890abcdef")).toBe("****cdef");
  });

  it("masks keys that are exactly 9 characters", () => {
    expect(maskApiKey("123456789")).toBe("****6789");
  });
});
