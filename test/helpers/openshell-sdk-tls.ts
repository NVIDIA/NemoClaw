// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let cached: { cert: Buffer; key: Buffer } | null = null;

// One throwaway self-signed pair per test process; it serves as both CA and client identity.
function testCertificatePair(): { cert: Buffer; key: Buffer } {
  if (cached) return cached;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sdk-tls-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-subj",
        "/CN=nemoclaw-test",
        "-days",
        "1",
        "-keyout",
        path.join(dir, "key.pem"),
        "-out",
        path.join(dir, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    cached = {
      cert: fs.readFileSync(path.join(dir, "cert.pem")),
      key: fs.readFileSync(path.join(dir, "key.pem")),
    };
    return cached;
  } finally {
    fs.rmSync(dir, { force: true, recursive: true });
  }
}

/** Write valid mTLS files where the OpenShell SDK reads them in a gateway state directory. */
export function writeSdkTlsFiles(stateDir: string): void {
  const { cert, key } = testCertificatePair();
  const clientDir = path.join(stateDir, "tls", "client");
  fs.mkdirSync(clientDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stateDir, "tls", "ca.crt"), cert, { mode: 0o600 });
  fs.writeFileSync(path.join(clientDir, "tls.crt"), cert, { mode: 0o600 });
  fs.writeFileSync(path.join(clientDir, "tls.key"), key, { mode: 0o600 });
}
