// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SECRET_BOUNDARY_VALIDATOR_SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "agents",
  "hermes",
  "validate-env-secret-boundary.py",
);
const GENERATED_HEX_TOKEN = Array.from({ length: 64 }, (_value, index) =>
  (index % 16).toString(16),
).join("");
const INHERITED_HEX_TOKEN = Array.from({ length: 64 }, (_value, index) =>
  (15 - (index % 16)).toString(16),
).join("");

function runEnvFileValidator(envFileContent: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-api-key-boundary-"));
  const envFile = path.join(tmpDir, ".env");
  fs.writeFileSync(envFile, envFileContent);

  try {
    return spawnSync("python3", [SECRET_BOUNDARY_VALIDATOR_SCRIPT, "env-file", envFile], {
      encoding: "utf-8",
      timeout: 5000,
      env: {
        PATH: process.env.PATH ?? "",
      },
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runRuntimeEnvValidator(
  envOverrides: Record<string, string>,
  switchyardBindings?: string,
) {
  return spawnSync(
    "python3",
    [
      SECRET_BOUNDARY_VALIDATOR_SCRIPT,
      ...(switchyardBindings === undefined
        ? ["runtime-env"]
        : ["switchyard-runtime-env", switchyardBindings]),
    ],
    {
    encoding: "utf-8",
    timeout: 5000,
    env: {
      HOME: os.tmpdir(),
      PATH: process.env.PATH ?? "",
      HERMES_LAZY_INSTALL_TARGET: "/sandbox/.hermes/lazy-packages",
      ...envOverrides,
    },
    },
  );
}

describe("agents/hermes/validate-hermes-env-secret-boundary API_SERVER_KEY contract", () => {
  it("allows generated API_SERVER_KEY values in Hermes .env files", () => {
    const envFileResult = runEnvFileValidator(
      [
        "API_SERVER_PORT=18642",
        "API_SERVER_HOST=127.0.0.1",
        `API_SERVER_KEY=${GENERATED_HEX_TOKEN}`,
        "",
      ].join("\n"),
    );

    expect(envFileResult.status, envFileResult.stderr).toBe(0);
    expect(envFileResult.stderr).toBe("");
  });

  it("rejects inherited generated-looking API_SERVER_KEY values in process env", () => {
    const envFileResult = runEnvFileValidator(
      [
        "API_SERVER_PORT=18642",
        "API_SERVER_HOST=127.0.0.1",
        `API_SERVER_KEY=${GENERATED_HEX_TOKEN}`,
        "",
      ].join("\n"),
    );
    const runtimeEnvResult = runRuntimeEnvValidator({
      API_SERVER_HOST: "127.0.0.1",
      API_SERVER_PORT: "18642",
      API_SERVER_KEY: INHERITED_HEX_TOKEN,
    });

    expect(envFileResult.status, envFileResult.stderr).toBe(0);
    expect(runtimeEnvResult.status).toBe(1);
    expect(runtimeEnvResult.stderr).toContain("process environment");
    expect(runtimeEnvResult.stderr).toContain("API_SERVER_KEY");
    expect(runtimeEnvResult.stderr).not.toContain(INHERITED_HEX_TOKEN.slice(0, 16));
  });

  it("rejects weak API_SERVER_KEY values in Hermes .env without printing the value", () => {
    for (const { envLine, redactedValue } of [
      { envLine: "API_SERVER_KEY=x", redactedValue: "API_SERVER_KEY=x" },
      { envLine: "API_SERVER_KEY=server-key", redactedValue: "server-key" },
      {
        envLine: "export API_SERVER_KEY='server-key'",
        redactedValue: "server-key",
      },
    ]) {
      const result = runEnvFileValidator(
        ["API_SERVER_PORT=18642", "API_SERVER_HOST=127.0.0.1", envLine, ""].join("\n"),
      );

      expect(result.status, `${envLine}: ${result.stderr}`).toBe(1);
      expect(result.stderr, envLine).toContain("API_SERVER_KEY (line 3)");
      expect(result.stderr, envLine).not.toContain(redactedValue);
    }
  });

  it("rejects weak API_SERVER_KEY values in process env without printing the value", () => {
    const weakKey = "server-key";
    const result = runRuntimeEnvValidator({
      API_SERVER_HOST: "127.0.0.1",
      API_SERVER_PORT: "18642",
      API_SERVER_KEY: weakKey,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("process environment");
    expect(result.stderr).toContain("API_SERVER_KEY");
    expect(result.stderr).not.toContain(weakKey);
  });
});

describe("agents/hermes/validate-hermes-env-secret-boundary routing placeholders", () => {
  it("rejects every Switchyard credential from persisted Hermes .env (#8887)", () => {
    const result = runEnvFileValidator(
      [
        "API_SERVER_PORT=18642",
        "API_SERVER_HOST=127.0.0.1",
        "SWITCHYARD_WEAK_AUTHORIZATION=openshell:resolve:env:v9_SWITCHYARD_WEAK_AUTHORIZATION",
        "",
      ].join("\n"),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SWITCHYARD_WEAK_AUTHORIZATION");
  });

  it.each([
    "Bearer openshell:resolve:env:FAST_API_KEY",
    "Bearer sk-proj-rawcredentialmaterial",
  ])("rejects an unsafe routing header without printing it (#8887)", (value) => {
    const result = runEnvFileValidator(
      [
        "API_SERVER_PORT=18642",
        "API_SERVER_HOST=127.0.0.1",
        `SWITCHYARD_WEAK_AUTHORIZATION=${value}`,
        "",
      ].join("\n"),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SWITCHYARD_WEAK_AUTHORIZATION");
    expect(result.stderr).not.toContain(value);
  });

  it("requires exact same-revision OpenShell markers for every enabled runtime binding (#8887)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-switchyard-bindings-"));
    const bindings = path.join(directory, "bindings.json");
    fs.writeFileSync(
      bindings,
      `${JSON.stringify({
        schemaVersion: 1,
        targets: (["judge", "weak", "strong"] as const).map((role) => ({
          role,
          headerEnv: [
            {
              envKey: `SWITCHYARD_${role.toUpperCase()}_AUTHORIZATION`,
              headerName: "authorization",
            },
          ],
        })),
      })}\n`,
      { mode: 0o600 },
    );
    const revision = "1234567890123456789";
    const valid = Object.fromEntries(
      (["JUDGE", "WEAK", "STRONG"] as const).map((role) => {
        const key = `SWITCHYARD_${role}_AUTHORIZATION`;
        return [key, `openshell:resolve:env:v${revision}_${key}`];
      }),
    );

    try {
      expect(runRuntimeEnvValidator(valid, bindings).status).toBe(0);
      const extra = runRuntimeEnvValidator(
        { ...valid, SWITCHYARD_STALE_AUTHORIZATION: "raw-secret" },
        bindings,
      );
      expect(extra.status).toBe(1);
      expect(extra.stderr).toContain("SWITCHYARD_STALE_AUTHORIZATION");
      expect(extra.stderr).not.toContain("raw-secret");
      for (const [label, overrides] of [
        ["missing", { ...valid, SWITCHYARD_WEAK_AUTHORIZATION: "" }],
        ["raw", { ...valid, SWITCHYARD_WEAK_AUTHORIZATION: "raw-secret" }],
        [
          "unversioned",
          {
            ...valid,
            SWITCHYARD_WEAK_AUTHORIZATION:
              "openshell:resolve:env:SWITCHYARD_WEAK_AUTHORIZATION",
          },
        ],
        [
          "wrong suffix",
          {
            ...valid,
            SWITCHYARD_WEAK_AUTHORIZATION:
              `openshell:resolve:env:v${revision}_SWITCHYARD_STRONG_AUTHORIZATION`,
          },
        ],
        [
          "mixed revision",
          {
            ...valid,
            SWITCHYARD_WEAK_AUTHORIZATION:
              "openshell:resolve:env:v7_SWITCHYARD_WEAK_AUTHORIZATION",
          },
        ],
      ] as const) {
        const result = runRuntimeEnvValidator(overrides, bindings);
        expect(result.status, `${label}: ${result.stderr}`).toBe(1);
        expect(result.stderr).not.toContain("raw-secret");
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
