// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  managedPolicyMetadata,
  managedRegistrationSource,
  SANDBOX_ID,
} from "../../helpers/managed-policy-receipt-fixture";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const POLICIES_PATH = JSON.stringify(path.join(REPO_ROOT, "src", "lib", "policy", "index.ts"));
const REGISTRY_PATH = JSON.stringify(path.join(REPO_ROOT, "src", "lib", "state", "registry.ts"));
const SOURCE_NODE_ARGS = ["--import", "tsx"];

function parseResultPayload(stdout: string): { error: string } {
  const marker = "__RESULT__";
  const markerIndex = stdout.indexOf(marker);
  expect(markerIndex).toBeGreaterThanOrEqual(0);
  return JSON.parse(stdout.slice(markerIndex + marker.length));
}

function runHermesPermissivePolicy(policySetStatus: number): {
  result: ReturnType<typeof spawnSync>;
  policy: string;
  stagedPath: string;
  stagedMode: string;
  cleanup: () => void;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-permissive-"));
  const fakeOpenshell = path.join(tmpDir, "openshell");
  const policyOut = path.join(tmpDir, "policy.yaml");
  const stagedRecord = path.join(tmpDir, "staged.txt");
  const script = String.raw`
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});
${managedRegistrationSource("hermes-sandbox", "hermes")}
policies.applyPermissivePolicy("hermes-sandbox");
`;
  fs.writeFileSync(
    fakeOpenshell,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$1 $2" = "sandbox get" ]; then
  printf 'Name: hermes-sandbox\nId: ${SANDBOX_ID}\nPhase: Ready\n'
  exit 0
fi
if [ "$1 $2" = "policy get" ]; then
  if [[ " $* " == *" --output json "* ]]; then
    printf '%s\n' ${JSON.stringify(managedPolicyMetadata("hermes-sandbox"))}
    exit 0
  fi
  if [ -f ${JSON.stringify(policyOut)} ]; then
    cat ${JSON.stringify(policyOut)}
  else
    printf 'Version: 1\nHash: fixture-policy\n---\nversion: 1\n\nnetwork_policies: {}\n'
  fi
  exit 0
fi
if [ "$1 $2" = "policy set" ]; then
  policy_file=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--policy" ]; then
      policy_file="$2"
      break
    fi
    shift
  done
  mode="$(node -e 'process.stdout.write((require("node:fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$policy_file")"
  printf '%s\n%s\n' "$policy_file" "$mode" > ${JSON.stringify(stagedRecord)}
  cp "$policy_file" ${JSON.stringify(policyOut)}
  if [ "${policySetStatus}" -eq 0 ]; then
    printf 'Policy version 2 submitted\nPolicy version 2 loaded\n'
    exit 0
  fi
  printf 'message: fixture rejection\n' >&2
  exit "${policySetStatus}"
fi
exit 1
`,
    { mode: 0o755 },
  );

  const result = spawnSync(process.execPath, [...SOURCE_NODE_ARGS, "-e", script], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: tmpDir,
      NEMOCLAW_OPENSHELL_BIN: fakeOpenshell,
    },
  });
  const [stagedPath, stagedMode] = fs.readFileSync(stagedRecord, "utf-8").trim().split("\n");
  return {
    result,
    policy: fs.readFileSync(policyOut, "utf-8"),
    stagedPath,
    stagedMode,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

describe("applyPermissivePolicy", () => {
  it.each([
    ["success", 0],
    ["OpenShell rejection", 17],
  ])(
    "materializes the Hermes Discord provider and removes staged policy material after %s",
    (_case, policySetStatus) => {
      const observed = runHermesPermissivePolicy(policySetStatus);
      try {
        expect(observed.result.status).toBe(policySetStatus);
        expect(observed.stagedMode).toBe("600");
        expect(fs.existsSync(observed.stagedPath)).toBe(false);
        const policy = YAML.parse(observed.policy);
        const endpoints = policy.network_policies.discord.endpoints as Array<{
          host?: string;
          credential_binding?: { provider?: string };
        }>;
        const credentialEndpoints = endpoints.filter((endpoint) =>
          ["discord.com", "gateway.discord.gg", "*.discord.gg"].includes(endpoint.host ?? ""),
        );
        expect(credentialEndpoints.map((endpoint) => endpoint.host).sort()).toEqual([
          "*.discord.gg",
          "discord.com",
          "gateway.discord.gg",
        ]);
        expect(
          credentialEndpoints.map((endpoint) => endpoint.credential_binding?.provider),
        ).toEqual([
          "hermes-sandbox-discord-bridge",
          "hermes-sandbox-discord-bridge",
          "hermes-sandbox-discord-bridge",
        ]);
        expect(observed.policy).not.toContain("{sandboxName}");
      } finally {
        observed.cleanup();
      }
    },
  );

  it("rejects an invalid sandbox name before the permissive policy command", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-permissive-invalid-"));
    const fakeOpenshell = path.join(tmpDir, "openshell");
    const callsPath = path.join(tmpDir, "calls.log");
    fs.writeFileSync(
      fakeOpenshell,
      `#!/usr/bin/env bash\nprintf 'called\\n' > ${JSON.stringify(callsPath)}\nexit 0\n`,
      { mode: 0o755 },
    );
    const script = String.raw`
const policies = require(${POLICIES_PATH});
try {
  policies.applyPermissivePolicy("bad:provider");
} catch (error) {
  process.stdout.write("\n__RESULT__" + JSON.stringify({ error: error.message }));
}
`;

    try {
      const result = spawnSync(process.execPath, [...SOURCE_NODE_ARGS, "-e", script], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          NEMOCLAW_OPENSHELL_BIN: fakeOpenshell,
        },
      });

      expect(result.status).toBe(0);
      expect(parseResultPayload(result.stdout).error).toContain(
        "Invalid or truncated sandbox name",
      );
      expect(fs.existsSync(callsPath)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
