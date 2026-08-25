// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

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

function runPermissivePolicy(options: {
  agent?: "hermes" | "openclaw";
  livePolicy?: string;
  policySetStatus: number;
  sandboxName: string;
}): {
  result: ReturnType<typeof spawnSync>;
  policy: string;
  stagedPath: string;
  stagedMode: string;
  cleanup: () => void;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-permissive-"));
  const fakeOpenshell = path.join(tmpDir, "openshell");
  const policyOut = path.join(tmpDir, "policy.yaml");
  const livePolicyPath = path.join(tmpDir, "live-policy.yaml");
  const livePolicyResponsePath = path.join(tmpDir, "live-policy-response.json");
  const stagedRecord = path.join(tmpDir, "staged.txt");
  fs.writeFileSync(
    livePolicyPath,
    options.livePolicy ?? YAML.stringify({ version: 1, network_policies: {} }),
  );
  fs.writeFileSync(
    livePolicyResponsePath,
    JSON.stringify({
      scope: "sandbox",
      sandbox: options.sandboxName,
      status: "effective",
      policy_source: "sandbox",
      policy: YAML.parse(fs.readFileSync(livePolicyPath, "utf-8")),
    }),
  );
  const registration = options.agent
    ? `registry.registerSandbox(${JSON.stringify({
        name: options.sandboxName,
        agent: options.agent,
        policies: [],
      })});`
    : "";
  const script = String.raw`
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});
${registration}
policies.applyPermissivePolicy(${JSON.stringify(options.sandboxName)});
`;
  fs.writeFileSync(
    fakeOpenshell,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$1 $2" = "policy get" ]; then
  if [[ " $* " == *" --output json "* ]]; then
    cat ${JSON.stringify(livePolicyResponsePath)}
  else
    cat ${JSON.stringify(livePolicyPath)}
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
  if [ "${options.policySetStatus}" -eq 0 ]; then
    printf 'Policy version 2 submitted\nPolicy version 2 loaded\n'
    exit 0
  fi
  printf 'message: fixture rejection\n' >&2
  exit "${options.policySetStatus}"
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
  expect(
    fs.existsSync(stagedRecord),
    `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(true);
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
      const observed = runPermissivePolicy({
        agent: "hermes",
        livePolicy: YAML.stringify({
          network_policies: {
            discord: {
              endpoints: [
                { credential_binding: { provider: "hermes-sandbox-discord-bridge" } },
              ],
            },
          },
        }),
        policySetStatus,
        sandboxName: "hermes-sandbox",
      });
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

  it("omits credential-bound routes when OpenClaw has no live providers (#10153)", () => {
    const sandboxName = "fallback-openclaw";
    const observed = runPermissivePolicy({
      agent: "openclaw",
      policySetStatus: 0,
      sandboxName,
    });
    try {
      expect(observed.result.status).toBe(0);
      expect(observed.stagedMode).toBe("600");
      expect(fs.existsSync(observed.stagedPath)).toBe(false);
      const policy = YAML.parse(observed.policy);
      expect(policy.network_policies.telegram).toBeUndefined();
      expect(policy.network_policies.slack).toBeUndefined();
      expect(observed.policy).not.toContain("{sandboxName}");
    } finally {
      observed.cleanup();
    }
  });

  it("retains OpenClaw routes when the live policy has each exact provider set (#10153)", () => {
    const sandboxName = "configured-openclaw";
    const observed = runPermissivePolicy({
      agent: "openclaw",
      livePolicy: YAML.stringify({
        network_policies: {
          telegram_bot: {
            endpoints: [
              { credential_binding: { provider: `${sandboxName}-telegram-bridge` } },
            ],
          },
          slack: {
            endpoints: [
              { credential_binding: { provider: `${sandboxName}-slack-app` } },
              { credential_binding: { provider: `${sandboxName}-slack-bridge` } },
            ],
          },
        },
      }),
      policySetStatus: 0,
      sandboxName,
    });
    try {
      expect(observed.result.status).toBe(0);
      const policy = YAML.parse(observed.policy);
      expect(
        new Set(
          policy.network_policies.telegram.endpoints.map(
            (endpoint: { credential_binding?: { provider?: string } }) =>
              endpoint.credential_binding?.provider,
          ),
        ),
      ).toEqual(new Set([`${sandboxName}-telegram-bridge`]));
      const slackEndpoints = policy.network_policies.slack.endpoints as Array<{
        credential_binding?: { provider?: string };
        host?: string;
        rules?: Array<{ allow?: { method?: string; path?: string } }>;
      }>;
      expect(
        new Set(slackEndpoints.map((endpoint) => endpoint.credential_binding?.provider)),
      ).toEqual(new Set([`${sandboxName}-slack-app`, `${sandboxName}-slack-bridge`]));
      expect(
        slackEndpoints.find(
          (endpoint) =>
            endpoint.host === "slack.com" &&
            endpoint.credential_binding?.provider === `${sandboxName}-slack-app`,
        ),
      ).toMatchObject({
        rules: [{ allow: { method: "POST", path: "/api/apps.connections.open" } }],
      });
      expect(observed.policy).not.toContain("{sandboxName}");
    } finally {
      observed.cleanup();
    }
  });

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
