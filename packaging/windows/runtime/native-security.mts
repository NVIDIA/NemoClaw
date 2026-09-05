// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

function fail(message) {
  throw new Error(`NemoClaw native runtime security boundary failed: ${message}`);
}

export function resolveBrokerUpstreamUrl(endpointValue, requestTarget) {
  if (typeof endpointValue !== "string" || typeof requestTarget !== "string")
    fail("the provider endpoint or request target is invalid");
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
  if (!requestTarget.startsWith("/v1/")) fail("the broker request target is outside /v1");
  const relativeTarget = requestTarget.slice("/v1/".length);
  if (
    !relativeTarget ||
    relativeTarget.startsWith("/") ||
    relativeTarget.startsWith("\\") ||
    relativeTarget.includes("\\") ||
    relativeTarget.includes("\0")
  )
    fail("the broker request target can escape the configured provider origin");
  const upstream = new URL(relativeTarget, endpoint);
  if (upstream.origin !== endpoint.origin)
    fail("the broker request target changed the configured provider origin");
  return upstream;
}

export function readOpenedRegularFile(file, { encoding, maxBytes = 2 * 1024 * 1024 } = {}) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, "r");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) fail("the opened relay or diagnostic path is not a regular file");
    if (stat.size > maxBytes) fail("the opened relay or diagnostic file exceeds its limit");
    return fs.readFileSync(descriptor, encoding);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function validatedChatMessages(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    fail("the model request body is invalid");
  if (!Array.isArray(body.messages) || body.messages.length > 64)
    fail("the model request message list is invalid");
  let totalBytes = 0;
  return body.messages.map((message) => {
    if (
      message === null ||
      typeof message !== "object" ||
      Array.isArray(message) ||
      !["system", "user", "assistant"].includes(message.role) ||
      typeof message.content !== "string"
    )
      fail("the model request contains an invalid message");
    totalBytes += Buffer.byteLength(message.content, "utf8");
    if (message.content.length > 64 * 1024 || totalBytes > 1024 * 1024)
      fail("the model request message content exceeds its limit");
    return { role: message.role, content: message.content };
  });
}
