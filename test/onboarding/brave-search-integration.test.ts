// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createWebSearchFlowHelpers } from "../../src/lib/onboard/web-search-flow";
import { BRAVE_TEST_KEY, startBraveBackend } from "../e2e/fixtures/brave-backend";

describe("Brave Search with a local backend", () => {
  it.each([200, 401, 403, 429, 503])(
    "configures optional search from an HTTP %i response without a Brave account",
    async (status) => {
      const backend = await startBraveBackend(status);
      try {
        vi.stubEnv("PATH", backend.env.PATH);
        const flow = createWebSearchFlowHelpers({
          env: { NEMOCLAW_WEB_SEARCH_PROVIDER: "brave" },
          getCredential: (name) => (name === "BRAVE_API_KEY" ? BRAVE_TEST_KEY : null),
          saveCredential: vi.fn(),
          prompt: vi.fn(async () => {
            throw new Error("Unexpected interactive prompt");
          }),
          note: vi.fn(),
          cliName: () => "nemoclaw",
          isNonInteractive: () => true,
          commandExecutor: {
            runBuffered: async () => {
              throw new Error("Unexpected sandbox command");
            },
          },
        });
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const configured = await flow.configureWebSearch(null);
        expect(configured).toEqual(
          status === 200 ? { fetchEnabled: true, provider: "brave" } : null,
        );
        expect(await backend.requests()).toEqual([
          {
            method: "GET",
            path: "/res/v1/web/search",
            query: "ping",
            count: "1",
            authenticated: true,
          },
        ]);
      } finally {
        vi.unstubAllEnvs();
        await backend.close();
      }
    },
  );
});
