// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";

import { requireSuccessfulPolicyBoundaryBuild } from "../fixtures/credential-policy-boundary-build.ts";
import { managedRegistrationSource, SANDBOX_ID } from "../../helpers/live-policy-fixture.ts";

const HELPER = path.resolve(import.meta.dirname, "../fixtures/credential-policy-binding.ts");
const TRANSACTION = path.resolve(
  import.meta.dirname,
  "../fixtures/credential-policy-transaction.ts",
);
const REGISTRY = path.resolve("src/lib/state/registry.ts");
const YAML_MODULE = createRequire(import.meta.url).resolve("yaml");
const TYPESCRIPT = path.resolve("node_modules/typescript/bin/tsc");
const POLICY_BOUNDARY_CONFIG = path.resolve("nemoclaw/tsconfig.shared.json");
const SPAWN_TEST_TIMEOUT_MS = 15_000;
const tempDirs: string[] = [];

function runBinding(policyFile: string, protocol = "websocket") {
  return spawnSync(
    process.execPath,
    [
      "--disable-warning=DEP0205",
      "--import",
      "tsx",
      HELPER,
      policyFile,
      "e2e-messaging-bridge",
      "host.docker.internal",
      "43117",
      protocol,
    ],
    { encoding: "utf8", killSignal: "SIGKILL", timeout: 15_000 },
  );
}

describe("credential-bound E2E policy endpoint", () => {
  beforeAll(async () => {
    const result = spawnSync(process.execPath, [TYPESCRIPT, "-p", POLICY_BOUNDARY_CONFIG], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      timeout: 15_000,
    });
    await requireSuccessfulPolicyBoundaryBuild(result);
  });

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it(
    "strips OpenShell revision metadata before binding the requested endpoint",
    () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-credential-policy-"));
      tempDirs.push(tempDir);
      const policyFile = path.join(tempDir, "policy.yaml");
      fs.writeFileSync(
        policyFile,
        [
          "Config rev:   15880558010371530494",
          "---",
          "version: 1",
          "network_policies:",
          "  fake:",
          "    endpoints:",
          "      - host: host.docker.internal",
          "        port: 43117",
          "        protocol: websocket",
          "      - host: discord.com",
          "        port: 443",
          "",
        ].join("\n"),
      );

      const result = runBinding(policyFile);

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(YAML.parse(fs.readFileSync(policyFile, "utf8"))).toEqual({
        version: 1,
        network_policies: {
          fake: {
            endpoints: [
              {
                host: "host.docker.internal",
                port: 43117,
                protocol: "websocket",
                credential_binding: { provider: "e2e-messaging-bridge" },
              },
              { host: "discord.com", port: 443 },
            ],
          },
        },
      });
      expect(fs.statSync(policyFile).mode & 0o777).toBe(0o600);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "rejects a missing protocol before choosing among shared endpoints (#10155)",
    () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-messaging-policy-"));
      tempDirs.push(tempDir);
      const policyFile = path.join(tempDir, "policy.yaml");
      fs.writeFileSync(policyFile, "version: 1\nnetwork_policies: {}\n");

      const result = spawnSync(
        process.execPath,
        [
          "--disable-warning=DEP0205",
          "--import",
          "tsx",
          HELPER,
          policyFile,
          "e2e-messaging-bridge",
          "host.docker.internal",
          "43117",
        ],
        { encoding: "utf8", killSignal: "SIGKILL", timeout: 15_000 },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("<protocol>");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it.each(["rest", "websocket"] as const)(
    "binds only the requested %s protocol when a fake host and port are shared",
    (protocol) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-messaging-policy-"));
      tempDirs.push(tempDir);
      const policyFile = path.join(tempDir, "policy.yaml");
      fs.writeFileSync(
        policyFile,
        [
          "version: 1",
          "network_policies:",
          "  fake:",
          "    endpoints:",
          "      - host: host.docker.internal",
          "        port: 43117",
          "        protocol: rest",
          "      - host: host.docker.internal",
          "        port: 43117",
          "        protocol: websocket",
          "",
        ].join("\n"),
      );

      const result = runBinding(policyFile, protocol);
      const endpoints = YAML.parse(fs.readFileSync(policyFile, "utf8")).network_policies.fake
        .endpoints as Array<Record<string, unknown>>;

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const requestedIndex = protocol === "rest" ? 0 : 1;
      expect(endpoints[requestedIndex]).toHaveProperty("credential_binding", {
        provider: "e2e-messaging-bridge",
      });
      expect(endpoints[1 - requestedIndex]).not.toHaveProperty("credential_binding");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it.each([
    ["rest", "request-body-credential-rewrite"],
    ["websocket", "websocket-credential-rewrite"],
  ] as const)(
    "preserves a concurrent policy edit while applying the %s credential binding transaction",
    (protocol, rewrite) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-credential-transaction-"));
      tempDirs.push(tempDir);
      const currentPolicy = path.join(tempDir, "current.yaml");
      const concurrentPolicy = path.join(tempDir, "concurrent.yaml");
      const versionFile = path.join(tempDir, "version.txt");
      const writesFile = path.join(tempDir, "writes.txt");
      const fakeOpenshell = path.join(tempDir, "openshell.cjs");
      const sandboxName = `e2e-cred-${protocol === "rest" ? "rest" : "ws"}`;
      const providerName = `${sandboxName}-bridge`;
      const host = "host.openshell.internal";
      const port = 43117;
      fs.writeFileSync(
        currentPolicy,
        YAML.stringify({
          version: 1,
          network_policies: {
            fake: {
              endpoints: [
                {
                  host,
                  port,
                  protocol,
                  enforcement: "enforce",
                  credential_rewrite: rewrite,
                  rules: [{ allow: { method: "GET", path: "/**" } }],
                },
              ],
              binaries: [{ path: "/usr/local/bin/node" }, { path: "/usr/bin/node" }],
            },
          },
        }),
      );
      fs.writeFileSync(versionFile, "1");
      fs.writeFileSync(writesFile, "0");
      fs.writeFileSync(
        fakeOpenshell,
        `#!/usr/bin/env node
const fs = require("node:fs");
const YAML = require(${JSON.stringify(YAML_MODULE)});
const args = process.argv.slice(2);
const currentPolicy = ${JSON.stringify(currentPolicy)};
const concurrentPolicy = ${JSON.stringify(concurrentPolicy)};
const versionFile = ${JSON.stringify(versionFile)};
const writesFile = ${JSON.stringify(writesFile)};
if (args[0] === "sandbox" && args[1] === "get") {
  process.stdout.write("Name: ${sandboxName}\\nId: ${SANDBOX_ID}\\nPhase: Ready\\n");
  process.exit(0);
}
if (args[0] === "policy" && args[1] === "get") {
  if (args.includes("--output")) {
    const version = Number(fs.readFileSync(versionFile, "utf8"));
    const policy = YAML.parse(fs.readFileSync(currentPolicy, "utf8"));
    process.stdout.write(JSON.stringify({
      scope: "sandbox",
      sandbox: ${JSON.stringify(sandboxName)},
      status: "effective",
      policy_source: "sandbox",
      hash: "policy-" + String(version),
      active_version: version,
      policy,
    }) + "\\n");
    process.exit(0);
  }
  const revisionIndex = args.indexOf("--rev");
  const source = revisionIndex >= 0 && args[revisionIndex + 1] === "2"
    ? concurrentPolicy
    : currentPolicy;
  process.stdout.write(fs.readFileSync(source, "utf8"));
  process.exit(0);
}
if (args[0] === "policy" && args[1] === "set") {
  const policyIndex = args.indexOf("--policy");
  const requested = fs.readFileSync(args[policyIndex + 1], "utf8");
  const writes = Number(fs.readFileSync(writesFile, "utf8"));
  if (writes === 0) {
    const concurrent = YAML.parse(fs.readFileSync(currentPolicy, "utf8"));
    concurrent.network_policies.concurrent_host_edit = {
      endpoints: [{ host: "concurrent.example.test", port: 443, protocol: "rest" }],
    };
    fs.writeFileSync(concurrentPolicy, YAML.stringify(concurrent));
    fs.writeFileSync(versionFile, "2");
  }
  fs.writeFileSync(currentPolicy, requested);
  fs.writeFileSync(versionFile, String(writes === 0 ? 3 : 4));
  fs.writeFileSync(writesFile, String(writes + 1));
  process.exit(0);
}
process.stderr.write("unexpected openshell argv: " + args.join(" ") + "\\n");
process.exit(2);
`,
        { mode: 0o755 },
      );

      const driver = `
const registry = require(${JSON.stringify(REGISTRY)});
${managedRegistrationSource(sandboxName)}
const transaction = require(${JSON.stringify(TRANSACTION)});
transaction.applyCredentialPolicyBinding(${JSON.stringify({
        sandboxName,
        providerName,
        host,
        port,
        protocol,
      })});
`;
      const result = spawnSync(process.execPath, ["--import", "tsx", "-e", driver], {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: tempDir,
          NEMOCLAW_OPENSHELL_BIN: fakeOpenshell,
        },
        killSignal: "SIGKILL",
        timeout: SPAWN_TEST_TIMEOUT_MS,
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.readFileSync(writesFile, "utf8")).toBe("2");
      const finalPolicy = YAML.parse(fs.readFileSync(currentPolicy, "utf8"));
      expect(finalPolicy.network_policies.concurrent_host_edit).toEqual({
        endpoints: [{ host: "concurrent.example.test", port: 443, protocol: "rest" }],
      });
      expect(finalPolicy.network_policies.fake).toEqual({
        endpoints: [
          {
            host,
            port,
            protocol,
            enforcement: "enforce",
            credential_rewrite: rewrite,
            rules: [{ allow: { method: "GET", path: "/**" } }],
            credential_binding: { provider: providerName },
          },
        ],
        binaries: [{ path: "/usr/local/bin/node" }, { path: "/usr/bin/node" }],
      });
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
