// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { IncomingMessage, ServerResponse } from "node:http";

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
