// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { createPackageFixture } from "./helpers/package-fixture";

const repositoryRoot = path.join(import.meta.dirname, "..", "..");
const roots: string[] = [];

function packageFixture(): string {
  const root = createPackageFixture({
    prefix: "nemoclaw-sdk-loading-",
    entries: [
      "dist/lib/adapters/openshell",
      "dist/lib/adapters/fs",
      "dist/lib/onboard/gateway/state-dir.js",
      "dist/lib/onboard/gateway-binding",
      "dist/lib/core",
      "dist/lib/inference/llama-cpp/contract.js",
      "dist/lib/config/canonical-mapping.js",
      "dist/lib/policy/sandbox-policy-validation.js",
      "dist/lib/security/credential-filter.js",
      "nemoclaw/dist/shared",
      "schemas",
    ],
  });
  roots.push(root);
  for (const name of ["yaml", "typebox", "ajv", "@bufbuild/protobuf"]) {
    const destination = path.join(root, "node_modules", name);
    mkdirSync(path.dirname(destination), { recursive: true });
    symlinkSync(path.join(repositoryRoot, "node_modules", name), destination, "dir");
  }
  return root;
}

function addImportOnlySdk(root: string): void {
  const sdk = path.join(root, "node_modules", "@nvidia", "openshell-sdk");
  mkdirSync(sdk, { recursive: true });
  writeFileSync(
    path.join(sdk, "package.json"),
    JSON.stringify({
      name: "@nvidia/openshell-sdk",
      type: "module",
      exports: { ".": { import: "./index.mjs" }, "./raw": { import: "./raw.mjs" } },
    }),
  );
  writeFileSync(
    path.join(sdk, "index.mjs"),
    `export const OpenShellClient = {
  connect: async ({ gateway, caCert, clientCert, clientKey }) => ({
    gateway,
    identity: [caCert, clientCert, clientKey].map(value => value.toString("utf8")),
  }),
};`,
  );
  // A generated proto3 SandboxPolicy with one uint32 version field.
  writeFileSync(
    path.join(sdk, "raw.mjs"),
    `import { fileDesc, messageDesc } from "@bufbuild/protobuf/codegenv2";
const file = fileDesc("Cg1maXh0dXJlLnByb3RvEgdmaXh0dXJlIikKDVNhbmRib3hQb2xpY3kSGAoHdmVyc2lvbhgBIAEoDVIHdmVyc2lvbmIGcHJvdG8z");
export const SandboxPolicySchema = messageDesc(file, 0);`,
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("compiled OpenShell SDK loading (#11421)", () => {
  it("connects and serializes policy through import-only public SDK exports", () => {
    const root = packageFixture();
    addImportOnlySdk(root);
    // Gateway ownership deliberately excludes world-writable temporary ancestors.
    const stateDir = mkdtempSync(path.join(userInfo().homedir, ".nemoclaw-sdk-contract-"));
    roots.push(stateDir);
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { create } from "@bufbuild/protobuf";
const require = createRequire(path.join(process.cwd(), "probe.cjs"));
const { connectManagedOpenShellSdk } = require("./dist/lib/adapters/openshell/sdk.js");
const { serializeSdkPolicy } = require("./dist/lib/adapters/openshell/sandbox-config.js");
const { ensureManagedGatewayStateRoot } = require("./dist/lib/onboard/gateway/state-dir.js");
const stateDir = process.argv[1];
ensureManagedGatewayStateRoot({ gatewayName: "nemoclaw-9443", gatewayPort: 9443, stateDir });
fs.mkdirSync(path.join(stateDir, "tls", "client"), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(stateDir, "tls", "ca.crt"), "fixture-ca");
fs.writeFileSync(path.join(stateDir, "tls", "client", "tls.crt"), "fixture-cert");
fs.writeFileSync(path.join(stateDir, "tls", "client", "tls.key"), "fixture-key");
const client = await connectManagedOpenShellSdk(
  { kind: "named", gatewayName: "nemoclaw-9443" },
  { env: { NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: stateDir }, homeDir: process.cwd() },
);
const { SandboxPolicySchema } = await import("@nvidia/openshell-sdk/raw");
const policy = await serializeSdkPolicy(create(SandboxPolicySchema, { version: 1 }));
console.log(JSON.stringify({ client, policy }));
`,
          stateDir,
        ],
        { cwd: root, encoding: "utf8" },
      ),
    ) as { client: unknown; policy: string };

    expect(result.client).toEqual({
      gateway: "https://127.0.0.1:9443",
      identity: ["fixture-ca", "fixture-cert", "fixture-key"],
    });
    expect(YAML.parse(result.policy)).toEqual({ version: 1 });
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: root,
        encoding: "utf8",
      }),
    ) as Array<{ files: Array<{ path: string }> }>;
    expect(packed[0]?.files.map(({ path: filePath }) => filePath)).toContain(
      "dist/lib/adapters/openshell/sdk-import.mjs",
    );
  });

  it("loads the compiled adapters before the optional SDK is installed", () => {
    const root = packageFixture();
    const output = execFileSync(
      process.execPath,
      [
        "-e",
        `
const sdk = require("./dist/lib/adapters/openshell/sdk.js");
const policy = require("./dist/lib/adapters/openshell/sandbox-config.js");
console.log(JSON.stringify([typeof sdk.connectManagedOpenShellSdk, typeof policy.serializeSdkPolicy]));
`,
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(JSON.parse(output)).toEqual(["function", "function"]);
  });
});
