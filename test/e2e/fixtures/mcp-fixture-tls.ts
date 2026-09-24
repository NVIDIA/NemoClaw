// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createMcpFixtureTls() {
  const tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-fixture-tls-"));
  const close = () => fs.rmSync(tlsDir, { recursive: true, force: true });
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        path.join(tlsDir, "server.key"),
        "-out",
        path.join(tlsDir, "server.crt"),
      ],
      { stdio: "ignore", timeout: 20_000, killSignal: "SIGKILL" },
    );
    const fixtureTls = {
      cert: fs.readFileSync(path.join(tlsDir, "server.crt")),
      key: fs.readFileSync(path.join(tlsDir, "server.key")),
    };

    return { tls: fixtureTls, close };
  } catch (error) {
    close();
    throw error;
  }
}
