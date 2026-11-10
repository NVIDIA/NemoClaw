// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";

export function nativeLocalPipeName(port: number): string {
  if (process.platform !== "win32" || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("The native local pipe requires Windows and a valid declared port.");
  return String.raw`\\.\pipe\LOCAL\OpenShell-Loopback-${port}`;
}

export async function requestNativeBrokerBootstrap(
  port: number,
  token: string | null,
  signal?: AbortSignal,
): Promise<{ status: number; body: unknown }> {
  const socketPath = nativeLocalPipeName(port);
  if (token !== null && (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,128}$/u.test(token)))
    throw new Error("The native broker bootstrap identity is invalid.");
  signal?.throwIfAborted();
  return await new Promise((resolve, reject) => {
    let result: { status: number; body: unknown } | undefined;
    let failure: Error | undefined;
    const request = http.request({
      socketPath,
      path: "/native/bootstrap",
      method: "POST",
      agent: false,
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });
    const timer = setTimeout(
      () =>
        request.destroy(
          Object.assign(new Error("The native broker bootstrap timed out."), { code: "ETIMEDOUT" }),
        ),
      15_000,
    );
    const abort = () =>
      request.destroy(
        Object.assign(new Error("The native broker bootstrap was stopped."), { code: "ABORT_ERR" }),
      );
    request.once("close", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (result) resolve(result);
      else reject(new Error("The native broker bootstrap closed before completion."));
    });
    request.once("error", (error) => {
      failure = error;
    });
    request.once("response", (response) => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > 1024 * 1024)
          request.destroy(new Error("The native broker bootstrap reply is too large."));
        else chunks.push(chunk);
      });
      response.once("error", (error) => request.destroy(error));
      response.once("aborted", () =>
        request.destroy(new Error("The native broker bootstrap reply was interrupted.")),
      );
      response.once("end", () => {
        try {
          result = {
            status: response.statusCode ?? 0,
            body:
              response.statusCode === 200
                ? JSON.parse(
                    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
                  )
                : null,
          };
          request.destroy();
        } catch {
          request.destroy(new Error("The native broker bootstrap reply is invalid."));
        }
      });
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else request.end();
  });
}

export async function readNativeBrokerBootstrap(port: number, token: string): Promise<unknown> {
  if (typeof token !== "string")
    throw new Error("The native broker bootstrap identity is invalid.");
  const result = await requestNativeBrokerBootstrap(port, token);
  if (result.status !== 200) throw new Error("The native broker bootstrap request failed.");
  return result.body;
}
