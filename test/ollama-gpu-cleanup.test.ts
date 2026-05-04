// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import http from "node:http";

import { unloadOllamaModels } from "../dist/lib/onboard-ollama-proxy.js";

describe("Ollama GPU cleanup", () => {
  it("unloads all running Ollama models via the production HTTP implementation", async () => {
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

    const mockUnloadRequests: Array<{
      on: ReturnType<typeof vi.fn>;
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    }> = [];

    const httpGetSpy = vi.spyOn(http, "get").mockImplementation(((options: any, callback: any) => {
      expect(options.hostname).toBe("localhost");
      expect(options.port).toBe(11434);
      expect(options.path).toBe("/api/ps");
      callback(mockResponse);
      return mockGetRequest;
    }) as any);

    const httpRequestSpy = vi.spyOn(http, "request").mockImplementation(((
      options: any,
      callback: any,
    ) => {
      expect(options.hostname).toBe("localhost");
      expect(options.port).toBe(11434);
      expect(options.path).toBe("/api/generate");
      expect(options.method).toBe("POST");
      expect(options.headers["Content-Type"]).toBe("application/json");
      const req = {
        on: vi.fn(() => req),
        write: vi.fn(),
        end: vi.fn(),
      };
      mockUnloadRequests.push(req);
      callback();
      return req;
    }) as any);

    unloadOllamaModels();

    expect(httpGetSpy).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(httpRequestSpy).toHaveBeenCalledTimes(2);
    expect(mockUnloadRequests.map((req) => req.write.mock.calls[0]?.[0])).toEqual([
      JSON.stringify({ model: "llama3.1:8b", keep_alive: 0 }),
      JSON.stringify({ model: "qwen:7b", keep_alive: 0 }),
    ]);
    expect(mockUnloadRequests.every((req) => req.end.mock.calls.length === 1)).toBe(true);

    httpGetSpy.mockRestore();
    httpRequestSpy.mockRestore();
  });

  it("handles errors gracefully when Ollama is not running", () => {
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

  it("does not unload anything when Ollama reports no loaded models", async () => {
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
