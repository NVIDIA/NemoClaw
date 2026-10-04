// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";

export interface RuntimeSession {
  readonly voiceSessionId: string;
  readonly grant: string;
  readonly expiresAt: string;
}

async function request(options: {
  readonly port: number;
  readonly method: string;
  readonly path: string;
  readonly bearer: string;
  readonly body?: object;
}): Promise<{ readonly status: number; readonly body: string; readonly contentType: string }> {
  const body = options.body ? JSON.stringify(options.body) : "";
  return new Promise((resolve, reject) => {
    const client = http.request(
      {
        host: "127.0.0.1",
        port: options.port,
        method: options.method,
        path: options.path,
        headers: {
          authorization: `Bearer ${options.bearer}`,
          ...(body
            ? {
                "content-length": String(Buffer.byteLength(body)),
                "content-type": "application/json",
              }
            : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            contentType: String(response.headers["content-type"] ?? ""),
          }),
        );
      },
    );
    client.once("error", reject);
    client.end(body);
  });
}

/**
 * Deterministic fixture for the pinned runtime integration seam.
 *
 * It knows only the deployment bearer, voice-session grant, committed text,
 * normalized response events, and the runtime's existing text output callback.
 */
export class PinnedVoiceRuntimeAdapter {
  constructor(
    private readonly port: number,
    private readonly deploymentBearer: string,
    private readonly outputText: (text: string) => void,
  ) {}

  async createSession(runtimeConversationId: string): Promise<RuntimeSession> {
    const result = await request({
      port: this.port,
      method: "POST",
      path: "/v1/voice/sessions",
      bearer: this.deploymentBearer,
      body: { runtimeConversationId },
    });
    if (result.status !== 201) throw new Error(`session admission failed: ${result.status}`);
    return JSON.parse(result.body) as RuntimeSession;
  }

  async commitTurn(session: RuntimeSession, commitId: string, text: string): Promise<unknown[]> {
    const result = await request({
      port: this.port,
      method: "POST",
      path: `/v1/voice/sessions/${encodeURIComponent(session.voiceSessionId)}/turns`,
      bearer: session.grant,
      body: { commitId, text },
    });
    if (result.status !== 200 || !result.contentType.startsWith("application/x-ndjson")) {
      throw new Error(`turn failed: ${result.status}`);
    }
    const events = result.body
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const event of events) {
      if (event.type === "response.text.delta" && typeof event.text === "string") {
        this.outputText(event.text);
      }
    }
    return events;
  }

  async closeSession(session: RuntimeSession): Promise<void> {
    const result = await request({
      port: this.port,
      method: "DELETE",
      path: `/v1/voice/sessions/${encodeURIComponent(session.voiceSessionId)}`,
      bearer: session.grant,
    });
    if (result.status !== 204) throw new Error(`session close failed: ${result.status}`);
  }
}
