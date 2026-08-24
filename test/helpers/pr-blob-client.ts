// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// GitHub pull-request file/blob client for the codebase growth guardrail tests.
// It batches blob reads, falls back for large files, and retries transient
// failures without duplicating network code in each test.
//
import pRetry from "p-retry";

// Trust boundary: this runs from the trusted base checkout under
// pull_request_target. It only reads GitHub's diff metadata and blob text as
// DATA. It never executes pull-request-controlled code.

const GRAPHQL_URL = "https://api.github.com/graphql";
const REST_API_ROOT = "https://api.github.com";

export const GRAPHQL_BATCH_SIZE = 25;
export const RETRY_ATTEMPTS = 4;
export const RETRY_BASE_MS = 250;
export const RETRY_MAX_MS = 4000;

export type FetchLike = (url: string, init?: Parameters<typeof fetch>[1]) => Promise<Response>;

export type PullRequestFile = {
  readonly filename: string;
  readonly previous_filename?: string | null;
  readonly status?: string;
  readonly additions?: number;
  readonly deletions?: number;
};

/** A fetched blob maps to its UTF-8 text, or null when the path is absent. */
export type BlobMap = ReadonlyMap<string, string | null>;

export type PrBlobClientOptions = {
  readonly token: string;
  readonly fetchImpl?: FetchLike;
  /** Overrides p-retry timing for deterministic tests. */
  readonly retryOptions?: Pick<pRetry.Options, "minTimeout" | "maxTimeout" | "randomize">;
};

export type PrBlobClient = {
  getPullFiles(repo: string, prNumber: string): Promise<PullRequestFile[]>;
  fetchBlobs(repoFullName: string, oid: string, paths: readonly string[]): Promise<BlobMap>;
};

type RetriableError = Error & { transient?: boolean };

export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

function responseError(url: string, response: Response): RetriableError {
  const error: RetriableError = new Error(`${url}: HTTP ${response.status}`);
  error.transient =
    isTransientStatus(response.status) ||
    (response.status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        response.headers.has("retry-after")));
  return error;
}

function splitRepoName(fullName: string): { owner: string; name: string } {
  const [owner, name] = fullName.split("/");
  if (!owner || !name) throw new Error(`Unexpected repository full name: ${fullName}`);
  return { owner, name };
}

function buildBlobQuery(paths: readonly string[]): string {
  const aliases = paths
    .map(
      (_, index) =>
        `      f${index}: object(expression: $e${index}) { __typename ... on Blob { text isBinary isTruncated byteSize } }`,
    )
    .join("\n");
  const params = paths.map((_, index) => `$e${index}: String!`).join(", ");
  return `query($owner: String!, $name: String!, ${params}) {\n  repository(owner: $owner, name: $name) {\n${aliases}\n  }\n}`;
}

export function createPrBlobClient(options: PrBlobClientOptions): PrBlobClient {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  const headers = {
    Authorization: `Bearer ${options.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };

  function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return pRetry(
      async () => {
        try {
          return await fn();
        } catch (error) {
          if ((error as RetriableError)?.transient === true) throw error;
          throw new pRetry.AbortError(error as Error);
        }
      },
      {
        retries: RETRY_ATTEMPTS - 1,
        factor: 2,
        minTimeout: RETRY_BASE_MS,
        maxTimeout: RETRY_MAX_MS,
        randomize: true,
        ...options.retryOptions,
        onFailedAttempt: (error) => {
          console.error(`retry: ${label} attempt ${error.attemptNumber} failed (${error.message})`);
        },
      },
    );
  }

  async function requestJson(url: string, init?: Parameters<typeof fetch>[1]): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      const wrapped: RetriableError = new Error(
        `${url}: network error ${(error as Error)?.message ?? error}`,
      );
      wrapped.transient = true;
      throw wrapped;
    }
    if (!response.ok) throw responseError(url, response);
    return response.json();
  }

  function getJson(url: string): Promise<unknown> {
    return withRetry(url, () => requestJson(url, { headers }));
  }

  async function graphql(
    query: string,
    variables: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const body = JSON.stringify({ query, variables });
    const label = `graphql ${variables.owner ?? ""}/${variables.name ?? ""}@${variables.oid ?? ""}`;
    return withRetry(label, async () => {
      const payload = (await requestJson(GRAPHQL_URL, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body,
      })) as {
        data?: Record<string, unknown>;
        errors?: Array<{ message?: string; type?: string }>;
      };
      if (Array.isArray(payload.errors) && payload.errors.length > 0) {
        const messages = payload.errors.map((entry) => entry.message).join("; ");
        const transient = payload.errors.some(
          (entry) =>
            entry.type === "RATE_LIMITED" ||
            /timed? *out|unavailable|internal/i.test(entry.message ?? ""),
        );
        const error: RetriableError = new Error(`${label}: GraphQL errors: ${messages}`);
        if (transient) error.transient = true;
        throw error;
      }
      return payload.data ?? {};
    });
  }

  async function getContentViaRest(
    repo: string,
    ref: string,
    file: string,
  ): Promise<string | null> {
    if (!file) return null;
    const encodedPath = file.split("/").map(encodeURIComponent).join("/");
    const url = `${REST_API_ROOT}/repos/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;
    // This fallback only runs for blobs GraphQL truncated, i.e. large files
    // (1-100 MB). The default /contents object shape drops `content` above 1 MB,
    // so request the raw media type and read the body text directly.
    const rawHeaders = { ...headers, Accept: "application/vnd.github.raw" };
    return withRetry(url, async () => {
      let response: Response;
      try {
        response = await fetchImpl(url, { headers: rawHeaders });
      } catch (error) {
        const wrapped: RetriableError = new Error(
          `${url}: network error ${(error as Error)?.message ?? error}`,
        );
        wrapped.transient = true;
        throw wrapped;
      }
      if (response.status === 404) return null;
      if (!response.ok) throw responseError(url, response);
      return response.text();
    });
  }

  async function getPullFiles(repo: string, prNumber: string): Promise<PullRequestFile[]> {
    const files: PullRequestFile[] = [];
    for (let page = 1; ; page += 1) {
      const batch = (await getJson(
        `${REST_API_ROOT}/repos/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`,
      )) as PullRequestFile[];
      files.push(...batch);
      if (batch.length < 100) return files;
    }
  }

  async function fetchBlobs(
    repoFullName: string,
    oid: string,
    paths: readonly string[],
  ): Promise<BlobMap> {
    const results = new Map<string, string | null>();
    if (paths.length === 0) return results;
    const { owner, name } = splitRepoName(repoFullName);
    const rest: string[] = [];
    for (let start = 0; start < paths.length; start += GRAPHQL_BATCH_SIZE) {
      const chunk = paths.slice(start, start + GRAPHQL_BATCH_SIZE);
      const query = buildBlobQuery(chunk);
      const variables: Record<string, string> = { owner, name, oid };
      chunk.forEach((path, index) => {
        variables[`e${index}`] = `${oid}:${path}`;
      });
      const data = await graphql(query, variables);
      const repository = data.repository as Record<string, BlobNode | null> | undefined;
      if (!repository) throw new Error(`GraphQL repository not found: ${repoFullName}`);
      chunk.forEach((path, index) => {
        const node = repository[`f${index}`];
        if (!node || node.__typename !== "Blob") {
          results.set(path, null);
          return;
        }
        if (node.isBinary) throw new Error(`${path} is binary; refusing to read`);
        if (node.text == null || node.isTruncated) {
          rest.push(path);
          return;
        }
        results.set(path, node.text);
      });
    }
    for (const path of rest) {
      results.set(path, await getContentViaRest(repoFullName, oid, path));
    }
    return results;
  }

  return { getPullFiles, fetchBlobs };
}

type BlobNode = {
  readonly __typename?: string;
  readonly text?: string | null;
  readonly isBinary?: boolean;
  readonly isTruncated?: boolean;
  readonly byteSize?: number;
};

export function assertRepositoryName(repo: string | undefined, label: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? "")) {
    throw new Error(`${label} must be an owner/name repository name`);
  }
}
