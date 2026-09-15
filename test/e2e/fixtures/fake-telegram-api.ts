// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";

export type FakeTelegramRequest = {
  endpoint: string;
  event: "request";
  chatId: string;
  text: string;
  tokenLooksPlaceholder: boolean;
  tokenMatchesExpected: boolean;
  tokenRedacted: true;
};

export type FakeTelegramApi = {
  close(): Promise<void>;
  port: string;
  requests(): readonly FakeTelegramRequest[];
};

function fieldsFromBody(body: string): Record<string, unknown> {
  try {
    const value = JSON.parse(body || "{}") as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function startFakeTelegramApi(expectedToken: string): Promise<FakeTelegramApi> {
  if (!expectedToken) throw new Error("fake Telegram API requires an expected token");
  const captured: FakeTelegramRequest[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://fake-telegram.local");
      const match = /^\/bot([^/]+)\/([^/?]+)$/u.exec(url.pathname);
      const token = match?.[1] ?? "";
      const endpoint = match?.[2] ?? "";
      const fields = fieldsFromBody(Buffer.concat(chunks).toString("utf8"));
      const tokenMatchesExpected = token === expectedToken;
      captured.push({
        endpoint,
        event: "request",
        chatId: fields.chat_id === undefined ? "" : String(fields.chat_id),
        text: fields.text === undefined ? "" : String(fields.text),
        tokenLooksPlaceholder: token.includes("openshell:resolve:env:"),
        tokenMatchesExpected,
        tokenRedacted: true,
      });
      response.setHeader("content-type", "application/json");
      if (!match) {
        response.statusCode = 404;
        response.end(JSON.stringify({ ok: false, error_code: 404 }));
        return;
      }
      if (!tokenMatchesExpected) {
        response.statusCode = 401;
        response.end(JSON.stringify({ ok: false, error_code: 401 }));
        return;
      }
      response.statusCode = 200;
      response.end(
        JSON.stringify({
          ok: true,
          result:
            endpoint === "sendMessage"
              ? {
                  message_id: 4201,
                  chat: { id: fields.chat_id ?? "", type: "private" },
                  text: String(fields.text ?? ""),
                }
              : true,
        }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("fake Telegram API did not publish a TCP port");
  }
  return {
    port: String(address.port),
    requests: () => captured.map((entry) => ({ ...entry })),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
