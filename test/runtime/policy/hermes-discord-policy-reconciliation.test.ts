// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import YAML from "yaml";

import {
  livePolicyMetadata,
  managedRegistrationSource,
  parseResultPayload,
  SANDBOX_ID,
} from "../../helpers/live-policy-fixture";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const POLICIES_PATH = JSON.stringify(path.join(REPO_ROOT, "src", "lib", "policy", "index.ts"));
const REGISTRY_PATH = JSON.stringify(path.join(REPO_ROOT, "src", "lib", "state", "registry.ts"));
const MESSAGING_PLAN_FIXTURES_PATH = JSON.stringify(
  path.join(REPO_ROOT, "test", "helpers", "messaging-plan-fixtures.ts"),
);
const SOURCE_NODE_ARGS = ["--import", "tsx"];

it("removes stale generic runtime grants when the Hermes Discord preset is reapplied", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-hermes-discord-"));
  const fakeOpenshell = path.join(tmpDir, "openshell");
  const policyOut = path.join(tmpDir, "policy.yaml");
  const script = String.raw`
const fs = require("node:fs");
const YAML = require("yaml");
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});
const { makeMessagingPlan } = require(${MESSAGING_PLAN_FIXTURES_PATH});
${managedRegistrationSource("hermes-sandbox", "hermes")}
registry.updateSandbox("hermes-sandbox", {
  messaging: {
    schemaVersion: 1,
    plan: makeMessagingPlan({
      sandboxName: "hermes-sandbox",
      agent: "hermes",
      channels: ["discord"],
    }),
  },
});
const initialResult = policies.applyPresets("hermes-sandbox", ["discord"]);
const previousPolicy = YAML.parse(fs.readFileSync(process.env.POLICY_OUT, "utf-8"));
previousPolicy.network_policies.discord.binaries.unshift(
  { path: "/usr/local/bin/node" },
  { path: "/usr/bin/python3*" },
  { path: "/usr/bin/python3.13" },
);
fs.writeFileSync(process.env.POLICY_OUT, YAML.stringify(previousPolicy));
const reapplyResult = policies.applyPreset("hermes-sandbox", "discord");
process.stdout.write("\n__RESULT__" + JSON.stringify({
  initialResult,
  reapplyResult,
  policy: fs.readFileSync(process.env.POLICY_OUT, "utf-8"),
  registry: registry.getSandbox("hermes-sandbox"),
}));
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
    printf '%s\n' ${JSON.stringify(livePolicyMetadata("hermes-sandbox"))}
    exit 0
  fi
  if [ -f ${JSON.stringify(policyOut)} ]; then
    cat ${JSON.stringify(policyOut)}
  else
    printf 'Version: 1\nHash: test\n---\nversion: 1\n\nnetwork_policies: {}\n'
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
  cp "$policy_file" ${JSON.stringify(policyOut)}
  printf 'Policy version 2 submitted\nPolicy version 2 loaded\n'
  exit 0
fi
exit 1
`,
    { mode: 0o755 },
  );

  try {
    const result = spawnSync(process.execPath, [...SOURCE_NODE_ARGS, "-e", script], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        NEMOCLAW_OPENSHELL_BIN: fakeOpenshell,
        POLICY_OUT: policyOut,
      },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = parseResultPayload(result.stdout);
    expect(payload.initialResult).toBe(true);
    expect(payload.reapplyResult).toBe(true);
    const discordPolicy = YAML.parse(payload.policy).network_policies.discord;
    const binaries = discordPolicy.binaries.map((entry: { path: string }) => entry.path);
    expect(binaries).toEqual(["/opt/hermes/.venv/bin/python3", "/opt/hermes/.venv/bin/python"]);
    expect(binaries).not.toContain("/usr/local/bin/node");
    expect(binaries).not.toContain("/usr/bin/python3*");
    expect(binaries).not.toContain("/usr/bin/python3.13");
    const discordComEndpoints = discordPolicy.endpoints.filter(
      (endpoint: { host?: string }) => endpoint.host === "discord.com",
    );
    expect(discordComEndpoints).toHaveLength(1);
    expect(discordComEndpoints[0].credential_binding).toEqual({
      provider: "hermes-sandbox-discord-bridge",
    });
    expect(payload.registry).not.toHaveProperty("policies");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
