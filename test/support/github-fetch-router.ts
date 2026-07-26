// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface RecordedGitHubRequest {
  body?: unknown;
  method: string;
  url: string;
}

export interface GitHubFetchRoute {
  matches: (request: RecordedGitHubRequest) => boolean;
  respond: (request: RecordedGitHubRequest) => Promise<Response> | Response;
}

async function readRequestBody(input: Parameters<typeof fetch>[0], init?: RequestInit) {
  if (init?.body !== undefined) return String(init.body);
  if (input instanceof Request) return input.clone().text();
  return "";
}

export function githubFetchRoute(
  matches: GitHubFetchRoute["matches"],
  respond: GitHubFetchRoute["respond"],
): GitHubFetchRoute {
  return { matches, respond };
}

export function createGitHubFetchRouter(
  routes: readonly GitHubFetchRoute[],
  requests?: RecordedGitHubRequest[],
): typeof fetch {
  return (async (input, init) => {
    const requestInput = input instanceof Request ? input : undefined;
    const serializedBody = await readRequestBody(input, init);
    const request: RecordedGitHubRequest = {
      url: requestInput?.url ?? String(input),
      method: init?.method ?? requestInput?.method ?? "GET",
      body: serializedBody === "" ? undefined : JSON.parse(serializedBody),
    };
    requests?.push(request);
    const matchingRoutes = routes.filter((candidate) => candidate.matches(request));
    if (matchingRoutes.length !== 1) {
      throw new Error(
        `Expected one route for ${request.method} ${request.url}, matched ${matchingRoutes.length}`,
      );
    }
    return matchingRoutes[0]!.respond(request);
  }) as typeof fetch;
}
