// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";

/** Inspect raw sandbox observations before evidence redaction, without sending the real key. */
export const HOSTED_CREDENTIAL_SCAN_SOURCE = String.raw`
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { length, salt, fingerprint } = JSON.parse(process.argv[1]);
const digest = value => crypto.createHash("sha256").update(salt).update(value).digest("hex");
const contains = (data, width, expected) => data.some((_, offset) =>
  offset + width <= data.length && digest(data.subarray(offset, offset + width)) === expected,
);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-credential-scan-"));
try {
  const canary = Buffer.from("nemoclaw-scan-canary-" + crypto.randomUUID());
  const canaryFile = path.join(root, "canary");
  fs.writeFileSync(canaryFile, canary, { mode: 0o600 });
  const environment = execFileSync("env");
  const processes = execFileSync("ps", ["aux"]);
  const sample = execFileSync("sh", [
    "-lc", 'find "$1" /tmp /sandbox /home -type f -size -1M 2>/dev/null | head -200',
    "credential-scan", root,
  ]).toString().trim().split("\n").filter(Boolean);
  const observations = sample.flatMap(file => {
    try { return [{ file, data: fs.readFileSync(file).subarray(0, 64 * 1024) }]; }
    catch { return []; }
  });
  const files = observations.filter(entry => entry.file !== canaryFile).map(entry => entry.data);
  console.log(JSON.stringify({
    environmentClean: environment.length > 0 && !contains(environment, length, fingerprint),
    processesClean: processes.length > 0 && !contains(processes, length, fingerprint),
    sampledFilesClean: files.length > 0 && !files.some(data => contains(data, length, fingerprint)),
    canaryDetected: observations.some(entry => contains(entry.data, canary.length, digest(canary))),
    sampledFileCount: files.length,
  }));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
`;

/** The sandbox receives a salted fingerprint and byte length, never the provider credential. */
export function hostedCredentialScanCommand(credential: string): string[] {
  const salt = randomUUID();
  return [
    "node",
    "-e",
    HOSTED_CREDENTIAL_SCAN_SOURCE,
    JSON.stringify({
      length: Buffer.byteLength(credential),
      salt,
      fingerprint: createHash("sha256").update(salt).update(credential).digest("hex"),
    }),
  ];
}
