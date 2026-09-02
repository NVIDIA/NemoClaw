// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import * as policyOwner from "../../../src/lib/policy/index.ts";
import type { CredentialPolicyEndpointExpectation } from "../fixtures/credential-policy-transaction.ts";
import { managedRegistrationSource, SANDBOX_ID } from "../../helpers/live-policy-fixture.ts";

const TRANSACTION = path.resolve(
  import.meta.dirname,
  "../fixtures/credential-policy-transaction.ts",
);
const REGISTRY = path.resolve("src/lib/state/registry.ts");
const YAML_MODULE = createRequire(import.meta.url).resolve("yaml");
const TYPESCRIPT = path.resolve("node_modules/typescript/bin/tsc");
const POLICY_BOUNDARY_CONFIG = path.resolve("nemoclaw/tsconfig.shared.json");
const SPAWN_TEST_TIMEOUT_MS = 30_000;
const tempDirs: string[] = [];
const ALLOWED_IPS = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"] as const;
const BINARIES = ["/usr/local/bin/node", "/usr/bin/node"] as const;
let bindCredentialPolicyDocument: typeof import("../fixtures/credential-policy-transaction.ts").bindCredentialPolicyDocument;
let applyCredentialPolicyBinding: typeof import("../fixtures/credential-policy-transaction.ts").applyCredentialPolicyBinding;

function endpointExpectation(protocol: "rest" | "websocket"): CredentialPolicyEndpointExpectation {
  return {
    providerName: "e2e-messaging-bridge",
    host: "host.docker.internal",
    port: 43117,
    protocol,
    enforcement: "enforce",
    credentialRewrite:
      protocol === "rest" ? "request-body-credential-rewrite" : "websocket-credential-rewrite",
    methods: protocol === "rest" ? ["GET", "POST"] : ["GET", "WEBSOCKET_TEXT"],
    allowedIps: ALLOWED_IPS,
    binaries: BINARIES,
  };
}

function controlledEndpoint(protocol: "rest" | "websocket"): Record<string, unknown> {
  const expected = endpointExpectation(protocol);
  return {
    host: expected.host,
    port: expected.port,
    protocol,
    enforcement: expected.enforcement,
    credential_rewrite: expected.credentialRewrite,
    allowed_ips: [...expected.allowedIps],
    rules: expected.methods.map((method) => ({ allow: { method, path: "/**" } })),
  };
}

describe("credential-bound E2E policy endpoint", () => {
  beforeAll(async () => {
    const result = spawnSync(process.execPath, [TYPESCRIPT, "-p", POLICY_BOUNDARY_CONFIG], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      timeout: SPAWN_TEST_TIMEOUT_MS,
    });
    expect(
      result.status,
      [result.stderr, result.stdout, result.error?.message].filter(Boolean).join("\n"),
    ).toBe(0);
    ({ applyCredentialPolicyBinding, bindCredentialPolicyDocument } =
      await import("../fixtures/credential-policy-transaction.ts"));
  }, SPAWN_TEST_TIMEOUT_MS);

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it(
    "strips OpenShell revision metadata before binding the requested endpoint",
    () => {
      const result = bindCredentialPolicyDocument(
        `Config rev:   15880558010371530494\n---\n${YAML.stringify({
          version: 1,
          network_policies: {
            fake: {
              endpoints: [controlledEndpoint("websocket"), { host: "discord.com", port: 443 }],
              binaries: BINARIES.map((path) => ({ path })),
            },
          },
        })}`,
        endpointExpectation("websocket"),
      );

      expect(YAML.parse(result)).toEqual({
        version: 1,
        network_policies: {
          fake: {
            endpoints: [
              {
                host: "host.docker.internal",
                port: 43117,
                protocol: "websocket",
                enforcement: "enforce",
                credential_rewrite: "websocket-credential-rewrite",
                allowed_ips: [...ALLOWED_IPS],
                rules: [
                  { allow: { method: "GET", path: "/**" } },
                  { allow: { method: "WEBSOCKET_TEXT", path: "/**" } },
                ],
                credential_binding: { provider: "e2e-messaging-bridge" },
              },
              { host: "discord.com", port: 443 },
            ],
            binaries: BINARIES.map((path) => ({ path })),
          },
        },
      });
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "rejects a missing protocol before choosing among shared endpoints (#10155)",
    () => {
      expect(() =>
        bindCredentialPolicyDocument(
          YAML.stringify({
            version: 1,
            network_policies: {
              fake: {
                endpoints: [controlledEndpoint("websocket")],
                binaries: BINARIES.map((path) => ({ path })),
              },
            },
          }),
          { ...endpointExpectation("websocket"), protocol: "" as "websocket" },
        ),
      ).toThrow("credential-bound endpoint must have exactly one owner in the base policy");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it.each(["rest", "websocket"] as const)(
    "binds only the requested %s protocol when a fake host and port are shared",
    (protocol) => {
      const result = bindCredentialPolicyDocument(
        YAML.stringify({
          version: 1,
          network_policies: {
            fake: {
              endpoints: [controlledEndpoint("rest"), controlledEndpoint("websocket")],
              binaries: BINARIES.map((path) => ({ path })),
            },
          },
        }),
        endpointExpectation(protocol),
      );
      const endpoints = YAML.parse(result).network_policies.fake.endpoints as Array<
        Record<string, unknown>
      >;
      const requestedIndex = protocol === "rest" ? 0 : 1;
      expect(endpoints[requestedIndex]).toHaveProperty("credential_binding", {
        provider: "e2e-messaging-bridge",
      });
      expect(endpoints[1 - requestedIndex]).not.toHaveProperty("credential_binding");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it("refuses a credential binding transaction after the endpoint controls are weakened", () => {
    const weakened = controlledEndpoint("rest");
    weakened.enforcement = "audit";
    const policy = YAML.stringify({
      version: 1,
      network_policies: {
        fake: {
          endpoints: [weakened],
          binaries: BINARIES.map((path) => ({ path })),
        },
      },
    });

    const capture = vi
      .spyOn(policyOwner, "captureRecordedSandboxBasePolicy")
      .mockReturnValue(policy);
    const write = vi.spyOn(policyOwner, "setPolicyDocument").mockReturnValue(true);

    try {
      expect(() =>
        applyCredentialPolicyBinding({
          sandboxName: "e2e-weakened-policy",
          endpoint: endpointExpectation("rest"),
        }),
      ).toThrow("credential-bound endpoint no longer matches the required policy controls");
      expect(write).not.toHaveBeenCalled();
      expect(YAML.parse(policy).network_policies.fake.endpoints[0]).not.toHaveProperty(
        "credential_binding",
      );
    } finally {
      capture.mockRestore();
      write.mockRestore();
    }
  });

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
      const methods = protocol === "rest" ? ["GET", "POST"] : ["GET", "WEBSOCKET_TEXT"];
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
                  allowed_ips: [...ALLOWED_IPS],
                  rules: methods.map((method) => ({ allow: { method, path: "/**" } })),
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
        endpoint: {
          providerName,
          host,
          port,
          protocol,
          enforcement: "enforce",
          credentialRewrite: rewrite,
          methods,
          allowedIps: ALLOWED_IPS,
          binaries: BINARIES,
        },
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
            allowed_ips: [...ALLOWED_IPS],
            rules: methods.map((method) => ({ allow: { method, path: "/**" } })),
            credential_binding: { provider: providerName },
          },
        ],
        binaries: [{ path: "/usr/local/bin/node" }, { path: "/usr/bin/node" }],
      });
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
