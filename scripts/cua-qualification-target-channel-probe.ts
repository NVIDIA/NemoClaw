#!/usr/bin/node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { TextDecoder } = require("node:util");

const PROTOCOL = "cua.qualification.target-channel/v1";
const KIND = "cua-qualification-target-channel-identity";
const SOURCE_SOCKET = "/run/nemoclaw/cua-qualification-target.sock";
const ISOLATED_SOCKET = "/run/nemoclaw-cua-artifact/target.sock";
const SOCKET_ENV = "NEMOCLAW_CUA_QUALIFICATION_TARGET_SOCKET";
const MAX_RESPONSE_BYTES = 4096;
const TIMEOUT_MS = 2000;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REQUEST = `${JSON.stringify({
  schemaVersion: "1.0.0",
  kind: "cua-qualification-target-channel-identity-request",
  protocol: PROTOCOL,
})}\n`;

function fail(): void {
  process.stderr.write("cua-qualification-target-channel-probe: target channel unavailable\n");
  process.exitCode = 1;
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function parseIdentityFrame(
  bytes: Buffer,
  expectedServiceBundle: string,
  expectedTargetImage: string,
): Record<string, string> {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_RESPONSE_BYTES) {
    throw new Error("bounded response required");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("strict UTF-8 required");
  }
  if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) {
    throw new Error("one complete response frame required");
  }
  let value;
  try {
    value = JSON.parse(text.slice(0, -1));
  } catch {
    throw new Error("strict JSON required");
  }
  if (JSON.stringify(value) !== text.slice(0, -1)) {
    throw new Error("canonical JSON frame required");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "kind",
      "protocol",
      "serviceBundleDigest",
      "targetImageDigest",
    ]) ||
    value.schemaVersion !== "1.0.0" ||
    value.kind !== KIND ||
    value.protocol !== PROTOCOL ||
    value.serviceBundleDigest !== expectedServiceBundle ||
    value.targetImageDigest !== expectedTargetImage
  ) {
    throw new Error("target channel identity mismatch");
  }
  return {
    schemaVersion: "1.0.0",
    kind: KIND,
    protocol: PROTOCOL,
    serviceBundleDigest: expectedServiceBundle,
    targetImageDigest: expectedTargetImage,
  };
}

function socketIdentity(socketPath: string, expectedGid: number): string {
  if (fs.realpathSync(socketPath) !== socketPath) throw new Error("non-canonical socket");
  let ancestor = path.dirname(socketPath);
  for (;;) {
    const stat = fs.lstatSync(ancestor);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== 0 ||
      (stat.mode & 0o022) !== 0
    ) {
      throw new Error("unsafe socket ancestor");
    }
    if (ancestor === "/") break;
    ancestor = path.dirname(ancestor);
  }
  const stat = fs.lstatSync(socketPath, { bigint: true });
  if (
    !stat.isSocket() ||
    stat.isSymbolicLink() ||
    stat.uid !== 0n ||
    stat.gid !== BigInt(expectedGid) ||
    (stat.mode & 0o7777n) !== 0o660n ||
    stat.nlink !== 1n
  ) {
    throw new Error("unsafe socket identity");
  }
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.nlink,
    stat.uid,
    stat.gid,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(":");
}

async function probe(
  socketPath: string,
  expectedGid: number,
  expectedServiceBundle: string,
  expectedTargetImage: string,
): Promise<Record<string, string>> {
  const before = socketIdentity(socketPath, expectedGid);
  const response = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let ended = false;
    const client = net.createConnection({ path: socketPath });
    const rejectOnce = (error: Error): void => {
      if (ended) return;
      ended = true;
      client.destroy();
      reject(error);
    };
    client.setTimeout(TIMEOUT_MS, () => rejectOnce(new Error("target channel timed out")));
    client.once("connect", () => client.end(REQUEST));
    client.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) {
        rejectOnce(new Error("target channel response exceeded its bound"));
        return;
      }
      chunks.push(chunk);
    });
    client.once("error", rejectOnce);
    client.once("end", () => {
      if (ended) return;
      ended = true;
      resolve(Buffer.concat(chunks, size));
    });
  });
  if (socketIdentity(socketPath, expectedGid) !== before) {
    throw new Error("target channel socket changed during the probe");
  }
  return parseIdentityFrame(response, expectedServiceBundle, expectedTargetImage);
}

async function main(): Promise<void> {
  const [mode, expectedGidText, expectedServiceBundle, expectedTargetImage] = process.argv.slice(2);
  if (
    process.argv.length !== 6 ||
    (mode !== "--isolated" && mode !== "--source") ||
    !/^[1-9][0-9]{0,9}$/.test(expectedGidText ?? "") ||
    !DIGEST.test(expectedServiceBundle ?? "") ||
    !DIGEST.test(expectedTargetImage ?? "")
  ) {
    throw new Error("invalid target channel probe invocation");
  }
  const socketPath = mode === "--isolated" ? ISOLATED_SOCKET : SOURCE_SOCKET;
  if (
    (mode === "--isolated" && process.env[SOCKET_ENV] !== ISOLATED_SOCKET) ||
    (mode === "--source" && process.env[SOCKET_ENV] !== undefined)
  ) {
    throw new Error("target channel environment mismatch");
  }
  const identity = await probe(
    socketPath,
    Number(expectedGidText),
    expectedServiceBundle,
    expectedTargetImage,
  );
  process.stdout.write(`${JSON.stringify(identity)}\n`);
}

if (require.main === module) {
  main().catch(fail);
}

module.exports = {
  KIND,
  MAX_RESPONSE_BYTES,
  PROTOCOL,
  REQUEST,
  parseIdentityFrame,
};
