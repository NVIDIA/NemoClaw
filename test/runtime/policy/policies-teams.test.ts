// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import * as policies from "../../../src/lib/policy";
import {
  managedPolicyMetadata,
  managedRegistrationSource,
  SANDBOX_ID,
} from "../../helpers/managed-policy-receipt-fixture";

const requireForTest = createRequire(import.meta.url);
const YAML = requireForTest("yaml");
const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const POLICIES_PATH = JSON.stringify(path.join(REPO_ROOT, "src", "lib", "policy", "index.ts"));
const REGISTRY_PATH = JSON.stringify(path.join(REPO_ROOT, "src", "lib", "state", "registry.ts"));

function parseResultPayload(stdout: string): any {
  const marker = "__RESULT__";
  const markerIndex = stdout.indexOf(marker);
  expect(markerIndex).toBeGreaterThanOrEqual(0);
  return JSON.parse(stdout.slice(markerIndex + marker.length));
}

function allowedMethods(
  policy: {
    endpoints: Array<{
      host?: string;
      rules?: Array<{ allow?: { method?: string } }>;
    }>;
  },
  host: string,
): string[] {
  return allowedRules(policy, host)
    .map((rule) => rule.method)
    .filter((method): method is string => typeof method === "string")
    .sort();
}

function allowedRules(
  policy: {
    endpoints: Array<{
      host?: string;
      rules?: Array<{ allow?: { method?: string; path?: string } }>;
    }>;
  },
  host: string,
): Array<{ method?: string; path?: string }> {
  const endpoint = policy.endpoints.find((entry) => entry.host === host);
  expect(endpoint).toBeTruthy();
  return (endpoint?.rules ?? []).map((rule) => rule.allow ?? {});
}

describe("Teams policy preset", () => {
  it("composes Microsoft Teams Bot Framework and Graph capabilities", () => {
    const merged = policies.mergePresetNamesIntoPolicy(
      "version: 1\nnetwork_policies: {}\n",
      ["teams"],
      { sandboxName: "teams-preset" },
    );
    expect(merged.appliedPresets).toEqual(["teams"]);
    expect(merged.missingPresets).toEqual([]);
    const teamsPolicy = YAML.parse(merged.policy).network_policies.teams;
    const hosts = teamsPolicy.endpoints.map((endpoint: { host?: string }) => endpoint.host);
    expect(hosts).toContain("login.microsoftonline.com");
    expect(hosts).toContain("login.botframework.com");
    expect(hosts).toContain("api.botframework.com");
    expect(hosts).toContain("smba.trafficmanager.net");
    expect(hosts).toContain("graph.microsoft.com");
    expect(hosts).toContain("*.sharepoint.com");
    expect(allowedMethods(teamsPolicy, "graph.microsoft.com")).toEqual(["GET"]);
    expect(allowedRules(teamsPolicy, "smba.trafficmanager.net")).toEqual([
      { method: "GET", path: "/**" },
      { method: "POST", path: "/**" },
      { method: "PUT", path: "/**" },
      { method: "DELETE", path: "/**" },
    ]);
    expect(allowedMethods(teamsPolicy, "teams.microsoft.com")).toEqual(["GET"]);
    expect(allowedMethods(teamsPolicy, "teams.cdn.office.net")).toEqual(["GET"]);
    expect(allowedMethods(teamsPolicy, "statics.teams.cdn.office.net")).toEqual(["GET"]);
    expect(allowedMethods(teamsPolicy, "*.sharepoint.com")).toEqual(["GET"]);
  });

  it("returns Teams validation guidance", () => {
    expect(policies.getPresetValidationWarning("teams")).toContain("Microsoft Teams");
  });

  it("shares the Teams credential binding with Outlook only while Teams is active", () => {
    const sandboxName = "teams-outlook";
    const composed = policies.mergePresetNamesIntoPolicy(
      "version: 1\nnetwork_policies: {}\n",
      ["outlook", "teams"],
      { sandboxName },
    ).policy;
    const composedPolicy = YAML.parse(composed);
    const outlookLogin = composedPolicy.network_policies.outlook_graph.endpoints.find(
      (endpoint: { host?: string }) => endpoint.host === "login.microsoftonline.com",
    );
    const teamsLogin = composedPolicy.network_policies.teams.endpoints.find(
      (endpoint: { host?: string }) => endpoint.host === "login.microsoftonline.com",
    );
    expect(outlookLogin.credential_binding).toEqual({
      provider: `${sandboxName}-teams-bridge`,
    });
    expect(outlookLogin.credential_binding).toEqual(teamsLogin.credential_binding);

    const teamsEntries = policies.extractPresetEntries(
      policies.loadPresetForSandbox(sandboxName, "teams"),
    );
    const withoutTeams = policies.removePresetFromPolicy(composed, teamsEntries);
    const restored = YAML.parse(
      policies.reconcileTeamsOutlookLoginCredentialBinding(withoutTeams, sandboxName),
    );
    const restoredOutlookLogin = restored.network_policies.outlook_graph.endpoints.find(
      (endpoint: { host?: string }) => endpoint.host === "login.microsoftonline.com",
    );
    expect(restoredOutlookLogin).not.toHaveProperty("credential_binding");
  });

  it("refuses to overwrite a foreign Outlook credential binding", () => {
    const outlook = policies.mergePresetNamesIntoPolicy(
      "version: 1\nnetwork_policies: {}\n",
      ["outlook"],
      { sandboxName: "teams-outlook" },
    ).policy;
    const drifted = YAML.parse(outlook);
    const outlookLogin = drifted.network_policies.outlook_graph.endpoints.find(
      (endpoint: { host?: string }) => endpoint.host === "login.microsoftonline.com",
    );
    outlookLogin.credential_binding = { provider: "operator-owned" };

    expect(() =>
      policies.mergePresetNamesIntoPolicy(YAML.stringify(drifted), ["teams"], {
        sandboxName: "teams-outlook",
      }),
    ).toThrow("already has a different credential binding");
  });

  it("binds the Hermes Teams login endpoints to its bridge provider (#10079)", () => {
    const composed = policies.mergePresetNamesIntoPolicy(
      "version: 1\nnetwork_policies: {}\n",
      ["outlook", "teams"],
      { agent: "hermes", sandboxName: "hermes-outlook" },
    ).policy;
    const parsed = YAML.parse(composed);
    const outlookLogin = parsed.network_policies.outlook_graph.endpoints.find(
      (endpoint: { host?: string }) => endpoint.host === "login.microsoftonline.com",
    );
    const teamsLogin = parsed.network_policies.teams.endpoints.find(
      (endpoint: { host?: string }) => endpoint.host === "login.microsoftonline.com",
    );
    const teamsBotLogin = parsed.network_policies.teams.endpoints.find(
      (endpoint: { host?: string }) => endpoint.host === "login.botframework.com",
    );

    expect(teamsLogin.credential_binding).toEqual({
      provider: "hermes-outlook-teams-bridge",
    });
    expect(teamsBotLogin.credential_binding).toEqual(teamsLogin.credential_binding);
    expect(outlookLogin.credential_binding).toEqual(teamsLogin.credential_binding);
  });

  it("uses agent-specific preset content for Hermes Teams", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-hermes-teams-"));
    const fakeOpenshell = path.join(tmpDir, "openshell");
    const policyOut = path.join(tmpDir, "policy.yaml");
    const script = String.raw`
const fs = require("node:fs");
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});
${managedRegistrationSource("hermes-sandbox", "hermes")}
const result = policies.applyPresets("hermes-sandbox", ["teams"]);
process.stdout.write("\n__RESULT__" + JSON.stringify({
  result,
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
    printf '%s\n' ${JSON.stringify(managedPolicyMetadata("hermes-sandbox"))}
    exit 0
  fi
  if [ -f ${JSON.stringify(policyOut)} ]; then
    cat ${JSON.stringify(policyOut)}
    exit 0
  fi
  printf 'Version: 1\nHash: test\n---\nversion: 1\n\nnetwork_policies: {}\n'
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
      const result = spawnSync(process.execPath, ["-e", script], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          NEMOCLAW_OPENSHELL_BIN: fakeOpenshell,
          POLICY_OUT: policyOut,
        },
      });

      expect(result.status).toBe(0);
      const payload = parseResultPayload(result.stdout);
      const parsed = YAML.parse(payload.policy);
      const teamsPolicy = parsed.network_policies.teams;
      const binaries = teamsPolicy.binaries.map((entry: { path: string }) => entry.path);
      expect(binaries).toContain("/usr/bin/python3*");
      expect(binaries).toContain("/opt/hermes/.venv/bin/python");
      expect(binaries).toContain("/usr/local/bin/hermes");
      expect(
        teamsPolicy.endpoints.some(
          (endpoint: { host?: string }) => endpoint.host === "smba.trafficmanager.net",
        ),
      ).toBe(true);
      const hosts = teamsPolicy.endpoints.map((endpoint: { host?: string }) => endpoint.host);
      expect(hosts).toEqual(
        expect.arrayContaining([
          "login.microsoftonline.com",
          "login.botframework.com",
          "api.botframework.com",
          "smba.trafficmanager.net",
          "graph.microsoft.com",
          "*.sharepoint.com",
        ]),
      );
      expect(allowedMethods(teamsPolicy, "graph.microsoft.com")).toEqual(["GET"]);
      expect(allowedRules(teamsPolicy, "smba.trafficmanager.net")).toEqual([
        { method: "GET", path: "/**" },
        { method: "POST", path: "/**" },
        { method: "PUT", path: "/**" },
        { method: "DELETE", path: "/**" },
      ]);
      expect(allowedMethods(teamsPolicy, "teams.microsoft.com")).toEqual(["GET"]);
      expect(allowedMethods(teamsPolicy, "*.sharepoint.com")).toEqual(["GET"]);
      expect(payload.registry.policies).toEqual(["teams"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
