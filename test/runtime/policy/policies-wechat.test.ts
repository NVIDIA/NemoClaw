// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  managedPolicyMetadata,
  managedRegistrationSource,
  parseResultPayload,
  SANDBOX_ID,
} from "./managed-policy-receipt-fixture";

const requireForTest = createRequire(import.meta.url);
const YAML = requireForTest("yaml");
const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const POLICIES_PATH = JSON.stringify(path.join(REPO_ROOT, "src", "lib", "policy", "index.ts"));
const REGISTRY_PATH = JSON.stringify(path.join(REPO_ROOT, "src", "lib", "state", "registry.ts"));
const SOURCE_NODE_ARGS = ["--import", "tsx"];

describe("WeChat policy application", () => {
  it.each([
    ["OpenClaw", "openclaw", ["/usr/bin/node", "/usr/local/bin/node"]],
    ["Hermes", "hermes", ["/usr/bin/python3*", "/opt/hermes/.venv/bin/python"]],
  ] as const)(
    "applies %s routes with the exact sandbox provider (#10153)",
    (_displayName, agent, expectedBinaries) => {
      const sandboxName = `${agent}-wechat`;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-policy-${agent}-wechat-`));
      const fakeOpenshell = path.join(tmpDir, "openshell");
      const policyOut = path.join(tmpDir, "policy.yaml");
      const script = String.raw`
const fs = require("node:fs");
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});
${managedRegistrationSource(sandboxName, agent)}
const result = policies.applyPresets(${JSON.stringify(sandboxName)}, ["wechat"]);
process.stdout.write("\n__RESULT__" + JSON.stringify({
  result,
  policy: fs.readFileSync(process.env.POLICY_OUT, "utf-8"),
  registry: registry.getSandbox(${JSON.stringify(sandboxName)}),
}));
`;
      fs.writeFileSync(
        fakeOpenshell,
        `#!/usr/bin/env bash
set -euo pipefail
if [ "$1 $2" = "sandbox get" ]; then
  printf 'Name: ${sandboxName}\nId: ${SANDBOX_ID}\nPhase: Ready\n'
  exit 0
fi
if [ "$1 $2" = "policy get" ]; then
  if [[ " $* " == *" --output json "* ]]; then
    printf '%s\n' ${JSON.stringify(managedPolicyMetadata(sandboxName))}
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

        expect(result.status, result.stderr).toBe(0);
        const payload = parseResultPayload(result.stdout);
        const parsed = YAML.parse(payload.policy);
        expect(parsed.network_policies.wechat).toBeUndefined();
        const wechatPolicy = parsed.network_policies.wechat_bridge;
        const binaries = wechatPolicy.binaries.map((entry: { path: string }) => entry.path);
        expect(binaries).toEqual(expect.arrayContaining([...expectedBinaries]));
        const endpoints = wechatPolicy.endpoints as Array<{
          host?: string;
          port?: number;
          credential_binding?: { provider?: string };
        }>;
        expect(endpoints.map((endpoint) => endpoint.host).sort()).toEqual([
          "ilinkai.wechat.com",
          "ilinkai.weixin.qq.com",
        ]);
        expect(endpoints.map((endpoint) => endpoint.port)).toEqual([443, 443]);
        expect(endpoints.map((endpoint) => endpoint.credential_binding?.provider)).toEqual([
          `${sandboxName}-wechat-bridge`,
          `${sandboxName}-wechat-bridge`,
        ]);
        expect(payload.registry.policies).toEqual(["wechat"]);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );
});
