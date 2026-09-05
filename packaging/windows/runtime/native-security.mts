// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

type NativeMessage = { role: "system" | "user" | "assistant"; content: string };
type ReadOpenedRegularFileOptions = { encoding?: BufferEncoding; maxBytes?: number };
export type BrokerOperation = "models" | "chat-completions";

function fail(message: string): never {
  throw new Error(`NemoClaw native runtime security boundary failed: ${message}`);
}

export function brokerOperationForRequest(
  method: string | undefined,
  requestTarget: string | undefined,
): BrokerOperation | null {
  if (method === "GET" && requestTarget === "/v1/models") return "models";
  if (method === "POST" && requestTarget === "/v1/chat/completions") return "chat-completions";
  return null;
}

export function resolveBrokerUpstreamUrl(endpointValue: string, operation: BrokerOperation): URL {
  if (typeof endpointValue !== "string") fail("the provider endpoint is invalid");
  const endpoint = new URL(`${endpointValue.replace(/\/$/u, "")}/`);
  const loopback = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]";
  if (
    (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    fail("the provider endpoint violates the native preview boundary");
  const relativeTarget =
    operation === "models"
      ? "models"
      : operation === "chat-completions"
        ? "chat/completions"
        : fail("the broker operation is not allowlisted");
  const upstream = new URL(relativeTarget, endpoint);
  if (upstream.origin !== endpoint.origin)
    fail("the broker request target changed the configured provider origin");
  return upstream;
}

export function readOpenedRegularFile(
  file: string,
  options: { encoding: BufferEncoding; maxBytes?: number },
): string | null;
export function readOpenedRegularFile(
  file: string,
  options?: { encoding?: undefined; maxBytes?: number },
): Buffer | null;
export function readOpenedRegularFile(
  file: string,
  { encoding, maxBytes = 2 * 1024 * 1024 }: ReadOpenedRegularFileOptions = {},
): Buffer | string | null {
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, "r");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) fail("the opened relay or diagnostic path is not a regular file");
    if (stat.size > maxBytes) fail("the opened relay or diagnostic file exceeds its limit");
    return encoding ? fs.readFileSync(descriptor, encoding) : fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function validatedChatMessages(body: unknown): NativeMessage[] {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    fail("the model request body is invalid");
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length > 64)
    fail("the model request message list is invalid");
  let totalBytes = 0;
  return messages.map((message: unknown) => {
    if (
      message === null ||
      typeof message !== "object" ||
      Array.isArray(message) ||
      !["system", "user", "assistant"].includes((message as { role?: unknown }).role as string) ||
      typeof (message as { content?: unknown }).content !== "string"
    )
      fail("the model request contains an invalid message");
    const validated = message as NativeMessage;
    totalBytes += Buffer.byteLength(validated.content, "utf8");
    if (validated.content.length > 64 * 1024 || totalBytes > 1024 * 1024)
      fail("the model request message content exceeds its limit");
    return { role: validated.role, content: validated.content };
  });
}
