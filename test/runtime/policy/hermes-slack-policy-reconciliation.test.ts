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
  managedSandboxEntry,
  parseResultPayload,
  SANDBOX_ID,
} from "../../helpers/live-policy-fixture";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const POLICIES_PATH = JSON.stringify(path.join(REPO_ROOT, "src", "lib", "policy", "index.ts"));
const POLICY_PRESET_SYNC_PATH = JSON.stringify(
  path.join(REPO_ROOT, "src", "lib", "onboard", "policy-preset-sync.ts"),
);
const REGISTRY_PATH = JSON.stringify(path.join(REPO_ROOT, "src", "lib", "state", "registry.ts"));
const MESSAGING_PLAN_FIXTURES_PATH = JSON.stringify(
  path.join(REPO_ROOT, "test", "helpers", "messaging-plan-fixtures.ts"),
);
const SOURCE_NODE_ARGS = ["--import", "tsx"];

it("applies a missing live Hermes Slack preset despite legacy applied state (#10678)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-hermes-slack-"));
  const fakeOpenshell = path.join(tmpDir, "openshell");
  const policyOut = path.join(tmpDir, "policy.yaml");
  const legacyRegistration = {
    ...managedSandboxEntry("hermes-sandbox", "hermes"),
    policies: ["slack"],
  };
  const script = String.raw`
const fs = require("node:fs");
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});
const { syncPresetSelection } = require(${POLICY_PRESET_SYNC_PATH});
const { makeMessagingPlan } = require(${MESSAGING_PLAN_FIXTURES_PATH});
registry.registerSandbox({
  ...${JSON.stringify(legacyRegistration)},
  messaging: {
    schemaVersion: 1,
    plan: makeMessagingPlan({
      sandboxName: "hermes-sandbox",
      agent: "hermes",
      channels: ["slack"],
    }),
  },
});
const appliedBefore = policies.getAppliedPresets("hermes-sandbox");
syncPresetSelection("hermes-sandbox", appliedBefore, ["slack"]);
const appliedAfter = policies.getAppliedPresets("hermes-sandbox");
process.stdout.write("\n__RESULT__" + JSON.stringify({
  appliedBefore,
  appliedAfter,
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
    expect(payload.appliedBefore).toEqual([]);
    expect(payload.appliedAfter).toEqual(["slack"]);
    const parsed = YAML.parse(payload.policy);
    const binaries = parsed.network_policies.slack.binaries.map(
      (entry: { path: string }) => entry.path,
    );
    expect(binaries).toEqual([
      "/usr/local/bin/hermes",
      "/usr/bin/python3*",
      "/usr/bin/python3.13",
      "/opt/hermes/.venv/bin/python3",
      "/opt/hermes/.venv/bin/python",
    ]);
    expect(binaries).not.toContain("/usr/local/bin/node");
    expect(binaries).not.toContain("/usr/bin/node");
    expect(payload.registry).not.toHaveProperty("policies");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
