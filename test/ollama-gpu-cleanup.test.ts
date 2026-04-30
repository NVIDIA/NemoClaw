// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Note: onboard-ollama-proxy.ts uses CJS require("./runner") etc. which
// doesn't resolve correctly under vitest's ESM transform (same issue as
// shields.test.ts). We reproduce the unload logic here to verify the HTTP
// interaction pattern until the module is migrated to ESM imports.

import { describe, expect, it, vi } from "vitest";
import http from "node:http";

/** Mirror of unloadOllamaModels() from src/lib/onboard-ollama-proxy.ts */
function unloadOllamaModels() {
  try {
    const req = http.get(
      {
        hostname: "localhost",
        port: 11434,
        path: "/api/ps",
        timeout: 3000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) return;
          try {
            const parsed = JSON.parse(data);
            const models = parsed.models || [];
            for (const entry of models) {
              if (!entry.name) continue;
              const unloadReq = http.request(
                {
                  hostname: "localhost",
                  port: 11434,
                  path: "/api/generate",
                  method: "POST",
                  timeout: 3000,
                  headers: { "Content-Type": "application/json" },
                },
                () => {
                  /* ignore response */
                },
              );
              unloadReq.on("error", () => {
                /* best-effort */
              });
              unloadReq.write(JSON.stringify({ model: entry.name, keep_alive: 0 }));
              unloadReq.end();
            }
          } catch {
            /* best-effort */
          }
        });
      },
    );
    req.on("error", () => {
      /* best-effort */
    });
  } catch {
    /* best-effort */
  }
}

describe("Ollama GPU cleanup", () => {
  it("should unload all running Ollama models via HTTP API", async () => {
    const mockModels = {
      models: [{ name: "llama3.1:8b" }, { name: "qwen:7b" }],
    };

    const mockResponse = {
      statusCode: 200,
      on: vi.fn((event, handler) => {
        if (event === "data") {
          handler(JSON.stringify(mockModels));
        } else if (event === "end") {
          handler();
        }
        return mockResponse;
      }),
    };

    const mockGetRequest = {
      on: vi.fn(() => mockGetRequest),
    };

    const mockUnloadRequest = {
      on: vi.fn(() => mockUnloadRequest),
      write: vi.fn(),
      end: vi.fn(),
    };

    const httpGetSpy = vi.spyOn(http, "get").mockImplementation(((options: any, callback: any) => {
      expect(options.hostname).toBe("localhost");
      expect(options.port).toBe(11434);
      expect(options.path).toBe("/api/ps");
      callback(mockResponse);
      return mockGetRequest;
    }) as any);

    const httpRequestSpy = vi.spyOn(http, "request").mockImplementation(((options: any, callback: any) => {
      expect(options.hostname).toBe("localhost");
      expect(options.port).toBe(11434);
      expect(options.path).toBe("/api/generate");
      expect(options.method).toBe("POST");
      expect(options.headers["Content-Type"]).toBe("application/json");
      callback();
      return mockUnloadRequest;
    }) as any);

    unloadOllamaModels();

    expect(httpGetSpy).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(httpRequestSpy).toHaveBeenCalledTimes(2);
    expect(mockUnloadRequest.write).toHaveBeenCalledWith(
      JSON.stringify({ model: "llama3.1:8b", keep_alive: 0 }),
    );
    expect(mockUnloadRequest.write).toHaveBeenCalledWith(
      JSON.stringify({ model: "qwen:7b", keep_alive: 0 }),
    );
    expect(mockUnloadRequest.end).toHaveBeenCalledTimes(2);

    httpGetSpy.mockRestore();
    httpRequestSpy.mockRestore();
  });

  it("should handle errors gracefully when Ollama is not running", () => {
    const mockGetRequest = {
      on: vi.fn((event, handler) => {
        if (event === "error") {
          handler(new Error("Connection refused"));
        }
        return mockGetRequest;
      }),
    };

    const httpGetSpy = vi.spyOn(http, "get").mockImplementation((() => mockGetRequest) as any);

    expect(() => unloadOllamaModels()).not.toThrow();
    expect(httpGetSpy).toHaveBeenCalledTimes(1);

    httpGetSpy.mockRestore();
  });

  it("should handle empty model list", async () => {
    const mockModels = { models: [] };

    const mockResponse = {
      statusCode: 200,
      on: vi.fn((event, handler) => {
        if (event === "data") {
          handler(JSON.stringify(mockModels));
        } else if (event === "end") {
          handler();
        }
        return mockResponse;
      }),
    };

    const mockGetRequest = {
      on: vi.fn(() => mockGetRequest),
    };

    const httpGetSpy = vi.spyOn(http, "get").mockImplementation(((_options: any, callback: any) => {
      callback(mockResponse);
      return mockGetRequest;
    }) as any);

    const httpRequestSpy = vi.spyOn(http, "request");

    unloadOllamaModels();

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(httpGetSpy).toHaveBeenCalledTimes(1);
    expect(httpRequestSpy).not.toHaveBeenCalled();

    httpGetSpy.mockRestore();
    httpRequestSpy.mockRestore();
  });
});
