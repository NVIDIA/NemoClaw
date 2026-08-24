// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  assertRepositoryName,
  createPrBlobClient,
  type FetchLike,
  GRAPHQL_BATCH_SIZE,
  isTransientStatus,
  RATE_LIMIT_DEFAULT_DELAY_MS,
} from "./helpers/pr-blob-client";

const DETERMINISTIC = { sleep: async () => {} } as const;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function blobData(entries: Record<string, unknown>): unknown {
  return { data: { repository: entries } };
}

/** A fetch stub that returns a scripted response per call and records calls. */
function scriptedFetch(responses: Array<() => Promise<Response>>): {
  fetchImpl: FetchLike;
  urls: string[];
} {
  const urls: string[] = [];
  let call = 0;
  const fetchImpl: FetchLike = async (url) => {
    urls.push(String(url));
    const responder = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return responder();
  };
  return { fetchImpl, urls };
}

describe("growth-guardrails pr-blob-client", () => {
  it("classifies transient HTTP statuses", () => {
    expect([408, 425, 429, 500, 503, 599].map(isTransientStatus)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect([200, 400, 401, 404].map(isTransientStatus)).toEqual([false, false, false, false]);
  });

  it("rejects non owner/name repository names", () => {
    expect(() => assertRepositoryName("not-a-repo", "REPO")).toThrow(/owner\/name/);
    expect(() => assertRepositoryName(undefined, "HEAD_REPO")).toThrow(/owner\/name/);
    expect(assertRepositoryName("NVIDIA/NemoClaw", "REPO")).toBeUndefined();
  });

  it("paginates getPullFiles until a short page", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.ts` }));
    const { fetchImpl, urls } = scriptedFetch([
      async () => jsonResponse(fullPage),
      async () => jsonResponse([{ filename: "last.ts" }]),
    ]);
    const client = createPrBlobClient({ token: "t", fetchImpl, ...DETERMINISTIC });
    const files = await client.getPullFiles("NVIDIA/NemoClaw", "1");
    expect(files).toHaveLength(101);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("page=2");
  });

  it("batches blob fetches into GRAPHQL_BATCH_SIZE-sized GraphQL queries", async () => {
    const paths = Array.from({ length: GRAPHQL_BATCH_SIZE + 5 }, (_, i) => `test/f${i}.test.ts`);
    const graphqlCalls: number[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      const query = JSON.parse(String((init as { body?: string })?.body ?? "{}")).query as string;
      const aliasCount = (query.match(/f\d+: object/g) ?? []).length;
      graphqlCalls.push(aliasCount);
      const entries: Record<string, unknown> = {};
      for (let i = 0; i < aliasCount; i += 1) {
        entries[`f${i}`] = {
          __typename: "Blob",
          text: "line\n",
          isBinary: false,
          isTruncated: false,
        };
      }
      return jsonResponse(blobData(entries));
    };
    const client = createPrBlobClient({ token: "t", fetchImpl, ...DETERMINISTIC });
    const blobs = await client.fetchBlobs("NVIDIA/NemoClaw", "deadbeef", paths);
    expect(graphqlCalls).toEqual([GRAPHQL_BATCH_SIZE, 5]);
    expect(blobs.size).toBe(GRAPHQL_BATCH_SIZE + 5);
  });

  it("refuses to read binary blobs", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(
        blobData({ f0: { __typename: "Blob", text: null, isBinary: true, isTruncated: false } }),
      );
    const client = createPrBlobClient({ token: "t", fetchImpl, ...DETERMINISTIC });
    await expect(client.fetchBlobs("NVIDIA/NemoClaw", "oid", ["bin.test.ts"])).rejects.toThrow(
      /binary; refusing to read/,
    );
  });

  it("falls back to the REST raw media type for truncated blobs", async () => {
    const contentsAccept: string[] = [];
    let call = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      call += 1;
      const accept = (init?.headers as Record<string, string> | undefined)?.Accept ?? "";
      contentsAccept.push(String(url).includes("/contents/") ? accept : "");
      return call === 1
        ? jsonResponse(
            blobData({
              f0: { __typename: "Blob", text: null, isBinary: false, isTruncated: true },
            }),
          )
        : new Response("a\nb\n", { status: 200 });
    };
    const client = createPrBlobClient({ token: "t", fetchImpl, ...DETERMINISTIC });
    const blobs = await client.fetchBlobs("NVIDIA/NemoClaw", "oid", ["big.test.ts"]);
    expect(blobs.get("big.test.ts")).toBe("a\nb\n");
    expect(contentsAccept).toContain("application/vnd.github.raw");
  });

  it("waits until the primary rate-limit reset before retrying a 403", async () => {
    const sleeps: number[] = [];
    const { fetchImpl, urls } = scriptedFetch([
      async () =>
        jsonResponse({ message: "API rate limit exceeded" }, 403, {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1060",
        }),
      async () => jsonResponse([{ filename: "ok.ts" }]),
    ]);
    const client = createPrBlobClient({
      token: "t",
      fetchImpl,
      now: () => 1_000_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(client.getPullFiles("NVIDIA/NemoClaw", "9")).resolves.toEqual([
      { filename: "ok.ts" },
    ]);
    expect(urls).toHaveLength(2);
    expect(sleeps).toEqual([60_000]);
  });

  it("uses retry-after for a secondary rate limit", async () => {
    const sleeps: number[] = [];
    const { fetchImpl } = scriptedFetch([
      async () => jsonResponse({ message: "slow down" }, 429, { "retry-after": "7" }),
      async () => jsonResponse([{ filename: "ok.ts" }]),
    ]);
    const client = createPrBlobClient({
      token: "t",
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(client.getPullFiles("NVIDIA/NemoClaw", "9")).resolves.toHaveLength(1);
    expect(sleeps).toEqual([7000]);
  });

  it("does not retry before a reset outside the workflow wait budget", async () => {
    const sleeps: number[] = [];
    const { fetchImpl, urls } = scriptedFetch([
      async () =>
        jsonResponse({ message: "API rate limit exceeded" }, 403, {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1300",
        }),
    ]);
    const client = createPrBlobClient({
      token: "t",
      fetchImpl,
      now: () => 1_000_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(client.getPullFiles("NVIDIA/NemoClaw", "9")).rejects.toThrow(/HTTP 403/);
    expect(urls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("waits at least one minute when a rate-limit reset is unavailable", async () => {
    const sleeps: number[] = [];
    const { fetchImpl } = scriptedFetch([
      async () =>
        jsonResponse({ message: "API rate limit exceeded" }, 403, {
          "x-ratelimit-remaining": "0",
        }),
      async () => jsonResponse([{ filename: "ok.ts" }]),
    ]);
    const client = createPrBlobClient({
      token: "t",
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(client.getPullFiles("NVIDIA/NemoClaw", "9")).resolves.toHaveLength(1);
    expect(sleeps).toEqual([RATE_LIMIT_DEFAULT_DELAY_MS]);
  });

  it("does not retry a permission-denied 403", async () => {
    const sleeps: number[] = [];
    const { fetchImpl, urls } = scriptedFetch([
      async () => jsonResponse({ message: "Resource not accessible" }, 403),
    ]);
    const client = createPrBlobClient({
      token: "t",
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(client.getPullFiles("NVIDIA/NemoClaw", "9")).rejects.toThrow(/HTTP 403/);
    expect(urls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("retries a transient 500 then succeeds", async () => {
    const { fetchImpl, urls } = scriptedFetch([
      async () => jsonResponse({ message: "boom" }, 500),
      async () => jsonResponse([{ filename: "ok.ts" }]),
    ]);
    const client = createPrBlobClient({ token: "t", fetchImpl, ...DETERMINISTIC });
    const files = await client.getPullFiles("NVIDIA/NemoClaw", "9");
    expect(files).toEqual([{ filename: "ok.ts" }]);
    expect(urls).toHaveLength(2);
  });

  it("retries a transient GraphQL error payload then succeeds", async () => {
    const { fetchImpl, urls } = scriptedFetch([
      async () =>
        jsonResponse({
          errors: [{ message: "API rate limit exceeded", type: "RATE_LIMITED" }],
        }),
      async () =>
        jsonResponse(
          blobData({
            f0: {
              __typename: "Blob",
              text: "ok\n",
              isBinary: false,
              isTruncated: false,
            },
          }),
        ),
    ]);
    const client = createPrBlobClient({ token: "t", fetchImpl, ...DETERMINISTIC });

    const blobs = await client.fetchBlobs("NVIDIA/NemoClaw", "oid", ["test/a.test.ts"]);

    expect(blobs.get("test/a.test.ts")).toBe("ok\n");
    expect(urls).toHaveLength(2);
  });

  it("does not retry a non-transient GraphQL error payload", async () => {
    const { fetchImpl, urls } = scriptedFetch([
      async () =>
        jsonResponse({
          errors: [{ message: "Resource not accessible", type: "FORBIDDEN" }],
        }),
    ]);
    const client = createPrBlobClient({ token: "t", fetchImpl, ...DETERMINISTIC });

    await expect(client.fetchBlobs("NVIDIA/NemoClaw", "oid", ["test/a.test.ts"])).rejects.toThrow(
      /GraphQL errors: Resource not accessible/,
    );
    expect(urls).toHaveLength(1);
  });

  it("gives up after exhausting retries on persistent 503", async () => {
    const { fetchImpl, urls } = scriptedFetch([async () => jsonResponse({ message: "down" }, 503)]);
    const client = createPrBlobClient({ token: "t", fetchImpl, ...DETERMINISTIC });
    await expect(client.getPullFiles("NVIDIA/NemoClaw", "9")).rejects.toThrow(/HTTP 503/);
    expect(urls).toHaveLength(4);
  });
});
