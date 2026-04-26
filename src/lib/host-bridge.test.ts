// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import {
  CODEX_VERSION_POLICY_NAME,
  CODEX_VERSION_SERVICE_NAME,
  CODEX_VERSION_SERVICE_PORT,
  CODEX_VERSION_TARGET_PATH,
  buildCodexVersionBridgeRegistration,
  buildCodexVersionPolicyEntry,
  buildHostBridgeEvidencePaths,
  buildHostBridgeRevertScript,
  buildHostServiceListArgs,
  buildHostServiceRegisterArgs,
  buildHostServiceUnregisterArgs,
  buildPolicySetArgs,
  formatHostBridgeValidationNotes,
  listHostBridgeEvidenceDirs,
  mergeCodexVersionPolicy,
  policyHasCodexVersionBridge,
  removeCodexVersionPolicy,
  writeHostBridgeEvidence,
} from "./host-bridge";

const cleanupDirs: string[] = [];
const originalHome = process.env.HOME;

afterEach(() => {
  process.env.HOME = originalHome;
  while (cleanupDirs.length > 0) {
    fs.rmSync(cleanupDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("host-bridge", () => {
  it("builds the fixed codex_version registration payload", () => {
    const registration = buildCodexVersionBridgeRegistration("alpha");

    expect(registration).toEqual({
      version: 1,
      sandbox: "alpha",
      service_name: "codex-bridge.local",
      service_port: 80,
      target_scheme: "http",
      target_host: "127.0.0.1",
      target_port: 36566,
      target_path: "/codex_version",
      protocol: "rest",
      enforcement: "enforce",
      rules: [{ allow: { method: "POST", path: "/codex_version" } }],
      binaries: [{ path: "/usr/bin/curl" }],
    });
    expect(JSON.stringify(registration.rules)).not.toContain("GET");
    expect(JSON.stringify(registration.rules)).not.toContain("/**");
  });

  it("can omit the binary restriction for environments without binary identity enforcement", () => {
    const registration = buildCodexVersionBridgeRegistration("alpha", { includeBinary: false });
    const policyEntry = buildCodexVersionPolicyEntry({ includeBinary: false }) as {
      endpoints: Array<{ host: string; port: number; rules: Array<{ allow: { method: string; path: string } }> }>;
      binaries?: unknown;
    };

    expect(registration.binaries).toBeUndefined();
    expect(policyEntry.binaries).toBeUndefined();
    expect(policyEntry.endpoints).toEqual([
      {
        host: CODEX_VERSION_SERVICE_NAME,
        port: CODEX_VERSION_SERVICE_PORT,
        protocol: "rest",
        enforcement: "enforce",
        rules: [{ allow: { method: "POST", path: CODEX_VERSION_TARGET_PATH } }],
      },
    ]);
  });

  it("builds host-service CLI args around the evidence registration file", () => {
    expect(buildHostServiceRegisterArgs("alpha", "/tmp/bridge_registration.json")).toEqual([
      "host-service",
      "register",
      "--sandbox",
      "alpha",
      "--file",
      "/tmp/bridge_registration.json",
      "--wait",
    ]);
    expect(buildHostServiceUnregisterArgs("alpha")).toEqual([
      "host-service",
      "unregister",
      "--sandbox",
      "alpha",
      "--service-name",
      "codex-bridge.local",
      "--service-port",
      "80",
      "--wait",
    ]);
    expect(buildHostServiceListArgs("alpha")).toEqual(["host-service", "list", "--sandbox", "alpha"]);
    expect(buildPolicySetArgs("alpha", "/tmp/policy.yaml")).toEqual([
      "policy",
      "set",
      "--policy",
      "/tmp/policy.yaml",
      "--wait",
      "alpha",
    ]);
  });

  it("merges the codex bridge policy entry without disturbing existing entries", () => {
    const currentPolicy = YAML.stringify({
      version: 1,
      network_policies: {
        npm_registry: {
          name: "npm_registry",
          endpoints: [{ host: "registry.npmjs.org", port: 443 }],
        },
      },
    });

    const merged = YAML.parse(mergeCodexVersionPolicy(currentPolicy)) as Record<string, unknown>;
    const networkPolicies = merged.network_policies as Record<string, unknown>;

    expect(networkPolicies.npm_registry).toBeTruthy();
    expect(networkPolicies[CODEX_VERSION_POLICY_NAME]).toEqual(buildCodexVersionPolicyEntry());
    expect(policyHasCodexVersionBridge(mergeCodexVersionPolicy(currentPolicy))).toBe(true);
    const endpoint = (networkPolicies[CODEX_VERSION_POLICY_NAME] as {
      endpoints: Array<{ port: number; rules: Array<{ allow: { method: string; path: string } }> }>;
    }).endpoints[0];
    expect(endpoint.port).toBe(80);
    expect(endpoint.rules).toEqual([{ allow: { method: "POST", path: "/codex_version" } }]);
    expect(JSON.stringify(endpoint.rules)).not.toContain("GET");
    expect(JSON.stringify(endpoint.rules)).not.toContain("/**");
  });

  it("removes only the codex bridge policy entry", () => {
    const currentPolicy = YAML.stringify({
      version: 1,
      network_policies: {
        [CODEX_VERSION_POLICY_NAME]: buildCodexVersionPolicyEntry(),
        pypi: {
          name: "pypi",
          endpoints: [{ host: "pypi.org", port: 443 }],
        },
      },
    });

    const removed = YAML.parse(removeCodexVersionPolicy(currentPolicy)) as Record<string, unknown>;
    const networkPolicies = removed.network_policies as Record<string, unknown>;

    expect(networkPolicies[CODEX_VERSION_POLICY_NAME]).toBeUndefined();
    expect(networkPolicies.pypi).toBeTruthy();
    expect(policyHasCodexVersionBridge(removeCodexVersionPolicy(currentPolicy))).toBe(false);
  });

  it("writes evidence artifacts and a reversible script", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-bridge-"));
    cleanupDirs.push(tempHome);
    process.env.HOME = tempHome;

    const paths = buildHostBridgeEvidencePaths("alpha", "add", new Date("2026-04-26T01:02:03Z"));
    const registration = buildCodexVersionBridgeRegistration("alpha");
    const revertScript = buildHostBridgeRevertScript({
      operation: "add",
      sandboxName: "alpha",
      policyBeforePath: paths.policyBeforePath,
      registrationPath: paths.registrationPath,
    });
    const validationNotes = formatHostBridgeValidationNotes({
      operation: "add",
      sandboxName: "alpha",
      result: "success",
      details: ["Evidence created for regression reruns."],
    });

    writeHostBridgeEvidence({
      paths,
      policyBefore: "version: 1\nnetwork_policies: {}\n",
      policyAfter: mergeCodexVersionPolicy("version: 1\nnetwork_policies: {}\n"),
      registration,
      revertScript,
      validationNotes,
    });

    expect(fs.existsSync(paths.policyBeforePath)).toBe(true);
    expect(fs.existsSync(paths.policyAfterPath)).toBe(true);
    expect(fs.existsSync(paths.registrationPath)).toBe(true);
    expect(fs.existsSync(paths.revertScriptPath)).toBe(true);
    expect(fs.existsSync(paths.validationNotesPath)).toBe(true);
    expect(fs.readFileSync(paths.registrationPath, "utf-8")).toContain(CODEX_VERSION_SERVICE_NAME);
    expect(fs.readFileSync(paths.revertScriptPath, "utf-8")).toContain("openshell 'host-service'");
    expect(fs.readFileSync(paths.revertScriptPath, "utf-8")).toContain("'policy' 'set'");
    expect(fs.readFileSync(paths.validationNotesPath, "utf-8")).toContain("result=success");
    expect(listHostBridgeEvidenceDirs("alpha")[0]).toBe(paths.dir);
  });
});
