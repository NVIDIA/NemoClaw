// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import https from "node:https";
import { runInNewContext } from "node:vm";
import { createMcpFixtureTls } from "../e2e/fixtures/mcp-fixture-tls.ts";
import { startFakeMcpHttpsServer } from "../e2e/live/mcp-bridge-servers.ts";
import {
  buildCredentialWindowChildScript,
  buildCredentialWindowOneShotScript,
  CREDENTIAL_WINDOW_PATHS,
  CREDENTIAL_WINDOW_STEPS,
} from "../e2e/live/openshell-credential-generation-window.ts";

export function credentialWindowHttpFixture(result: number | string) {
  const requests: unknown[] = [];
  return {
    requests,
    request: (options: unknown, callback: (response: unknown) => void) => {
      requests.push(options);
      const outbound = new EventEmitter();
      return Object.assign(outbound, {
        setTimeout: () => {},
        end: (body: string) =>
          queueMicrotask(() => {
            const method = JSON.parse(body).method;
            const negotiating = method === "initialize" || method === "notifications/initialized";
            if (!negotiating && typeof result === "string") {
              outbound.emit("error", { code: result, message: "private-error-secret" });
            } else {
              const response = Object.assign(new EventEmitter(), {
                statusCode: method === "initialize" ? 200 : negotiating ? 202 : result,
                headers: { "mcp-session-id": "fixture-session" },
                setEncoding: () => {},
                resume: () => {},
              });
              callback(response);
              if (method === "initialize") {
                response.emit(
                  "data",
                  JSON.stringify({ result: { protocolVersion: "2025-11-25" } }),
                );
              }
              response.emit("end");
            }
          }),
      });
    },
  };
}

export async function runCredentialWindowSessionFixture(
  scenario: "retained" | "fresh",
  authorization = "fixture-secret",
) {
  const certificate = createMcpFixtureTls();
  const server = await startFakeMcpHttpsServer({
    secret: "fixture-secret",
    tls: certificate.tls,
  });
  try {
    const writes = new Map<string, string>();
    let summary = "";
    let diagnostic = "";
    const url = `https://127.0.0.1:${server.port}/mcp`;
    const script =
      scenario === "fresh"
        ? buildCredentialWindowOneShotScript()
        : buildCredentialWindowChildScript({ mcpUrl: url, maxRuntimeMs: 3000 });
    const childProcess = {
      argv: ["node", url, "fresh-request"],
      env: { FAKE_MCP_SECRET: "openshell:resolve:env:v42_FAKE_MCP_SECRET" },
      stdout: {
        write: (value: string) => {
          summary += value;
        },
      },
      stderr: {
        write: (value: string) => {
          diagnostic += value;
        },
      },
      exitCode: 0,
    };
    await runInNewContext(script, {
      Buffer,
      URL,
      setTimeout,
      process: childProcess,
      require: (name: string) =>
        name === "node:fs"
          ? {
              existsSync: () => true,
              readFileSync: () =>
                writes.has(CREDENTIAL_WINDOW_PATHS.acknowledgement)
                  ? CREDENTIAL_WINDOW_STEPS.stop
                  : CREDENTIAL_WINDOW_STEPS.allowedBeforeExpiry,
              writeFileSync: (file: string, value: string) => writes.set(file, value),
            }
          : {
              request: (
                options: https.RequestOptions,
                callback: (response: import("node:http").IncomingMessage) => void,
              ) =>
                https.request(
                  {
                    ...options,
                    ca: certificate.tls.cert,
                    // Model the proxy rewrite while exercising the real fixture's session validation.
                    headers: {
                      ...options.headers,
                      authorization: `Bearer ${authorization}`,
                    },
                  },
                  callback,
                ),
            },
    });
    return {
      exitCode: childProcess.exitCode,
      writes,
      summary,
      diagnostic,
      requests: server.requests,
    };
  } finally {
    await server.close();
    certificate.close();
  }
}
