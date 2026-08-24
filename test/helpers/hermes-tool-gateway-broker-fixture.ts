// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { IncomingMessage, ServerResponse } from "node:http";
import zlib from "node:zlib";

export const HERMES_BROKER_REDIRECT_TARGET = "/v1/redirect-destination";
export const HERMES_BROKER_REDIRECT_HEADER = "redirect-header-must-not-pass";
export const HERMES_BROKER_REDIRECT_BODY = "redirect-body-must-not-pass";

export type HermesBrokerUpstreamRequest = {
  url?: string;
  authorization?: string;
  browserUseApiKey?: string;
  apiKey?: string;
  acceptEncoding?: string;
};

export function handleHermesBrokerUpstream(
  requests: HermesBrokerUpstreamRequest[],
  req: IncomingMessage,
  res: ServerResponse,
): void {
  requests.push({
    url: req.url,
    authorization: req.headers.authorization,
    browserUseApiKey: req.headers["x-browser-use-api-key"] as string | undefined,
    apiKey: req.headers["x-api-key"] as string | undefined,
    acceptEncoding: req.headers["accept-encoding"] as string | undefined,
  });
  if (req.url === "/v1/redirect-probe") {
    res.writeHead(302, {
      Location: HERMES_BROKER_REDIRECT_TARGET,
      "Content-Type": "text/plain",
      "X-Redirect-Probe": HERMES_BROKER_REDIRECT_HEADER,
    });
    res.end(HERMES_BROKER_REDIRECT_BODY);
    return;
  }
  const body = zlib.gzipSync(JSON.stringify({ ok: true, path: req.url }));
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Encoding": "gzip",
    "Content-Length": String(body.length),
    "Content-MD5": "not-a-real-digest",
    "Set-Cookie": "fixture_session=1; HttpOnly; Secure; SameSite=Strict",
  });
  res.end(body);
}

export function handleHermesBrokerCoexistencePortal(
  refreshHeaders: string[],
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const refreshToken = String(req.headers["x-nous-refresh-token"] || "");
    const respond = () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/api/oauth/agent-key") {
        res.end(
          JSON.stringify({
            api_key: "local-agent-key",
            expires_in: 1800,
            inference_base_url: "https://inference-api.nousresearch.com/v1",
          }),
        );
        return;
      }
      refreshHeaders.push(refreshToken);
      const identity = refreshToken.split("-")[0] || "source";
      res.end(
        JSON.stringify({
          access_token: `access-${identity}`,
          refresh_token: refreshToken,
          expires_in: 900,
          token_type: "Bearer",
        }),
      );
    };
    if (refreshToken === "deadline-refresh-token") setTimeout(respond, 250);
    else respond();
  });
}
