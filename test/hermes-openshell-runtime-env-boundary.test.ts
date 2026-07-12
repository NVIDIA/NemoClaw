// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const VALIDATOR = path.join(
  import.meta.dirname,
  "..",
  "agents",
  "hermes",
  "validate-env-secret-boundary.py",
);
const CANONICAL_TLS_KEY_PATH = "/etc/openshell/tls/client/tls.key";

function runRuntimeEnvValidator(envOverrides: Record<string, string>) {
  return spawnSync("python3", [VALIDATOR, "runtime-env"], {
    encoding: "utf-8",
    timeout: 5000,
    env: {
      HOME: os.tmpdir(),
      PATH: process.env.PATH ?? "",
      ...envOverrides,
    },
  });
}

function runEnvFileValidator(envFileContent: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-openshell-boundary-"));
  const envFile = path.join(tmpDir, ".env");
  fs.writeFileSync(envFile, envFileContent);

  try {
    return spawnSync("python3", [VALIDATOR, "env-file", envFile], {
      encoding: "utf-8",
      timeout: 5000,
      env: { HOME: os.tmpdir(), PATH: process.env.PATH ?? "" },
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("Hermes OpenShell runtime environment boundary", () => {
  it("accepts the driver-owned OpenShell transport environment", () => {
    const result = runRuntimeEnvValidator({
      OPENSHELL_ENDPOINT: "https://gateway.openshell.internal:8080",
      OPENSHELL_LOG_LEVEL: "info",
      OPENSHELL_SANDBOX: "hermes-gpu",
      OPENSHELL_SANDBOX_ID: "sandbox-id",
      OPENSHELL_TLS_CA: "/etc/openshell/tls/client/ca.crt",
      OPENSHELL_TLS_CERT: "/etc/openshell/tls/client/tls.crt",
      OPENSHELL_TLS_KEY: CANONICAL_TLS_KEY_PATH,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("rejects noncanonical OpenShell TLS key values without printing them", () => {
    const pemValue = [
      "-----BEGIN PRIVATE ",
      "KEY-----\nraw-private-key\n-----END PRIVATE ",
      "KEY-----",
    ].join("");
    for (const value of [
      "raw-private-key",
      pemValue,
      "relative/tls.key",
      "/tmp/tls.key",
      `${CANONICAL_TLS_KEY_PATH}.bak`,
    ]) {
      const result = runRuntimeEnvValidator({ OPENSHELL_TLS_KEY: value });

      expect(result.status, `${value}: ${result.stderr}`).toBe(1);
      expect(result.stderr).toContain("process environment");
      expect(result.stderr).toContain("OPENSHELL_TLS_KEY");
      expect(result.stderr).not.toContain(value);
    }
  });

  it("keeps the canonical OpenShell TLS key path out of mutable Hermes .env", () => {
    const result = runEnvFileValidator(`OPENSHELL_TLS_KEY=${CANONICAL_TLS_KEY_PATH}\n`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("OPENSHELL_TLS_KEY (line 1)");
    expect(result.stderr).not.toContain(CANONICAL_TLS_KEY_PATH);
  });

  it("continues to reject OpenShell supervisor identity credentials", () => {
    const values = {
      OPENSHELL_K8S_SA_TOKEN_FILE: "/var/run/secrets/openshell/token",
      OPENSHELL_SANDBOX_TOKEN: "raw-sandbox-token",
      OPENSHELL_SANDBOX_TOKEN_FILE: "/etc/openshell/token",
    };
    const result = runRuntimeEnvValidator(values);

    expect(result.status).toBe(1);
    for (const [key, value] of Object.entries(values)) {
      expect(result.stderr).toContain(key);
      expect(result.stderr).not.toContain(value);
    }
  });
});
