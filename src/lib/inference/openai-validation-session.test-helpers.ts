// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";
import { afterEach, expect, vi } from "vitest";
import type { CurlProbeResult } from "../adapters/http/probe";
import type { OpenAiValidationSessionDeps } from "./openai-validation-session";

export function useOpenAiValidationTestServers(): (server: http.Server) => Promise<number> {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
  });

  return async (server: http.Server): Promise<number> => {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });
    servers.push(server);
    const address = server.address();
    expect(address).toBeTruthy();
    expect(typeof address).toBe("object");
    return (address as import("node:net").AddressInfo).port;
  };
}

const legacySuccess = (): CurlProbeResult => ({
  ok: true,
  httpStatus: 200,
  curlStatus: 0,
  body: "",
  stderr: "",
  message: "legacy",
});

export function createOpenAiValidationTestDeps(
  legacyProbe: OpenAiValidationSessionDeps["legacyProbe"] = vi.fn(legacySuccess),
): OpenAiValidationSessionDeps {
  return {
    legacyProbe,
    hasResponsesToolCall: (body: string) => body.includes('"type":"function_call"'),
    hasChatCompletionsToolCall: (body: string) => body.includes('"tool_calls"'),
    hasChatCompletionsToolCallLeak: () => false,
    getChatPayload: (model: string) => ({ model, messages: [] }),
    getResponsesTimeoutMs: () => 1_000,
    getChatTimeoutMs: () => 1_000,
    sessionOptions: {
      env: {},
      lookup: vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]),
      allowPrivateAddressesForTesting: true,
    },
  };
}
