// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { shellQuote } from "../fixtures/clients/command.ts";

export interface HermesSlackCredentialFingerprint {
  readonly byteLength: number;
  readonly sha256: string;
}

export function hermesSlackCredentialFingerprints(
  credentials: readonly string[],
): readonly HermesSlackCredentialFingerprint[] {
  const fingerprints = credentials
    .filter((credential) => credential.length > 0)
    .map((credential) => ({
      byteLength: Buffer.byteLength(credential),
      sha256: createHash("sha256").update(credential).digest("hex"),
    }));
  if (fingerprints.length === 0) {
    throw new Error("Hermes Slack credential scan requires at least one credential fingerprint");
  }
  return fingerprints;
}

export const HERMES_SLACK_CREDENTIAL_FINGERPRINT_SCAN_SOURCE = String.raw`
import hashlib
import json
import pathlib
import sys

fingerprints = json.load(sys.stdin)
file_paths = json.loads(sys.argv[1])
scan_processes = sys.argv[2] == "processes"

def contains_fingerprint(data):
    for fingerprint in fingerprints:
        width = fingerprint.get("byteLength")
        expected = fingerprint.get("sha256")
        if not isinstance(width, int) or width <= 0:
            raise RuntimeError("credential fingerprint byteLength is invalid")
        if not isinstance(expected, str) or len(expected) != 64:
            raise RuntimeError("credential fingerprint sha256 is invalid")
        for offset in range(max(0, len(data) - width + 1)):
            if hashlib.sha256(data[offset:offset + width]).hexdigest() == expected:
                return True
    return False

file_hit = False
for raw_path in file_paths:
    try:
        data = pathlib.Path(raw_path).read_bytes()
    except Exception:
        continue
    if contains_fingerprint(data):
        file_hit = True
        break

process_hit = False
process_observed = False
if scan_processes:
    for path in pathlib.Path("/proc").glob("[0-9]*/cmdline"):
        try:
            data = path.read_bytes()
        except Exception:
            continue
        if not data:
            continue
        process_observed = True
        if contains_fingerprint(data):
            process_hit = True
            break

print(json.dumps({
    "files": "LEAK" if file_hit else "OK",
    "processes": "LEAK" if process_hit else ("OK" if process_observed else "EMPTY"),
}, sort_keys=True))
`;

export function hermesSlackCredentialFingerprintScanCommand(filePaths: readonly string[]): string {
  return [
    "python3 -c",
    shellQuote(HERMES_SLACK_CREDENTIAL_FINGERPRINT_SCAN_SOURCE),
    shellQuote(JSON.stringify(filePaths)),
    "processes",
  ].join(" ");
}

export function hermesSlackCredentialScanScript(options: {
  credentialFingerprints: readonly HermesSlackCredentialFingerprint[];
  openshellCommandPath: string;
  remoteCommand: string;
  sandboxName: string;
}): string {
  if (options.credentialFingerprints.length === 0) {
    throw new Error("Hermes Slack credential scan requires at least one credential fingerprint");
  }
  const fingerprintPayload = JSON.stringify(options.credentialFingerprints);
  return [
    "set -euo pipefail",
    [
      "printf %s",
      shellQuote(fingerprintPayload),
      "|",
      shellQuote(options.openshellCommandPath),
      "sandbox exec --name",
      shellQuote(options.sandboxName),
      "-- sh -lc",
      shellQuote(options.remoteCommand),
    ].join(" "),
  ].join("\n");
}
