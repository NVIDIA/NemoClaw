// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";

import { requireSuccessfulPolicyBoundaryBuild } from "../fixtures/hermes-discord-policy-boundary-build.ts";

const HELPER = path.resolve(import.meta.dirname, "../fixtures/hermes-discord-policy-binding.ts");
const TYPESCRIPT = path.resolve("node_modules/typescript/bin/tsc");
const POLICY_BOUNDARY_CONFIG = path.resolve("nemoclaw/tsconfig.shared.json");
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
      "e2e-hermes-discord-discord-bridge",
      "host.docker.internal",
      "43117",
      protocol,
    ],
    { encoding: "utf8", killSignal: "SIGKILL", timeout: 15_000 },
  );
}

describe("Hermes Discord E2E policy binding", () => {
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

  it("strips OpenShell revision metadata before binding the fake Gateway endpoint", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-discord-policy-"));
    tempDirs.push(tempDir);
    const policyFile = path.join(tempDir, "policy.yaml");
    fs.writeFileSync(
      policyFile,
      [
        "Config rev:   15880558010371530494",
        "---",
        "version: 1",
        "network_policies:",
        "  discord_gateway:",
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
        discord_gateway: {
          endpoints: [
            {
              host: "host.docker.internal",
              port: 43117,
              protocol: "websocket",
              credential_binding: { provider: "e2e-hermes-discord-discord-bridge" },
            },
            { host: "discord.com", port: 443 },
          ],
        },
      },
    });
    expect(fs.statSync(policyFile).mode & 0o777).toBe(0o600);
  });

  it("rejects a missing protocol before choosing among shared endpoints (#10155)", () => {
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
        "e2e-hermes-discord-discord-bridge",
        "host.docker.internal",
        "43117",
      ],
      { encoding: "utf8", killSignal: "SIGKILL", timeout: 15_000 },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("<protocol>");
  });

  it("binds only the requested protocol when a fake host and port are shared", () => {
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

    const result = runBinding(policyFile, "websocket");
    const endpoints = YAML.parse(fs.readFileSync(policyFile, "utf8")).network_policies.fake
      .endpoints as Array<Record<string, unknown>>;

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(endpoints[0]).not.toHaveProperty("credential_binding");
    expect(endpoints[1]).toHaveProperty("credential_binding", {
      provider: "e2e-hermes-discord-discord-bridge",
    });
  });
});
