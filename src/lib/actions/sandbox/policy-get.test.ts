// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import { captureOpenshellCommand } from "../../adapters/openshell/client";
import {
  createCliOpenShellSandboxPolicyRead,
  type CliOpenShellSandboxPolicyRead,
} from "../../adapters/openshell/sandbox-policy-cli";
import type { OpenShellSandboxError } from "../../adapters/openshell/sandbox-observer";
import { PolicyObservationError } from "../../adapters/openshell/policy-state";
import * as gatewayTarget from "./gateway-target";
import { getSandboxPolicy } from "./policy-get";

type FakeOpenShell = {
  argsPath: string;
  output: string;
  readPolicy: CliOpenShellSandboxPolicyRead;
};

const tempDirs: string[] = [];

function createFakeOpenShell(output: string, exitCode = 0): FakeOpenShell {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-get-"));
  tempDirs.push(tempDir);
  const argsPath = path.join(tempDir, "args.txt");
  const outputPath = path.join(tempDir, "output.txt");
  const executablePath = path.join(tempDir, "openshell");
  fs.writeFileSync(outputPath, output);
  fs.writeFileSync(
    executablePath,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >${JSON.stringify(argsPath)}`,
      `cat ${JSON.stringify(outputPath)}`,
      `exit ${exitCode}`,
    ].join("\n"),
    { mode: 0o755 },
  );
  const readPolicy = createCliOpenShellSandboxPolicyRead({
    capture: (args, options) =>
      captureOpenshellCommand(executablePath, args, {
        ...options,
        cwd: tempDir,
      }),
  });
  return { argsPath, output, readPolicy };
}

function failedPolicyRead(error: OpenShellSandboxError): CliOpenShellSandboxPolicyRead {
  return vi.fn(async () => ({ result: { ok: false as const, error }, displayOutput: "" }));
}

describe("getSandboxPolicy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reads --base and strips OpenShell metadata into round-trippable YAML (#6052)", async () => {
    const yaml = [
      "version: 1",
      "filesystem_policy:",
      "  read_only: []",
      "network_policies: {}",
    ].join("\n");
    const fake = createFakeOpenShell(
      [
        "Version: 1",
        `Hash: sha256:${"a".repeat(64)}`,
        "Status: active",
        "Active: 1",
        "Created: 2026-07-01T00:00:00Z",
        "Loaded: 2026-07-01T00:00:01Z",
        "---",
        yaml,
        "",
      ].join("\n"),
    );

    const result = await getSandboxPolicy("alpha", fake.readPolicy);

    expect(fs.readFileSync(fake.argsPath, "utf8").trim()).toBe("policy get --base alpha");
    expect(result.raw).toBe(fake.output.trim());
    expect(result.yaml).toBe(yaml);
    expect(YAML.parse(result.yaml)).toEqual({
      version: 1,
      filesystem_policy: { read_only: [] },
      network_policies: {},
    });
  });

  it("redacts literal credentials from parsed and raw display output", async () => {
    const credential = "opaque-live-policy-credential";
    const urlCredential = "opaque-url-credential";
    const fake = createFakeOpenShell(
      [
        "Version: 4",
        `Hash: sha256:${"a".repeat(64)}`,
        "Status: active",
        "Active: 4",
        "---",
        "version: 1",
        "network_policies:",
        "  protected_api:",
        "    endpoints:",
        `      - host: https://operator:${urlCredential}@api.example`,
        "process:",
        "  environment:",
        `    SERVICE_API_KEY: ${credential}`,
      ].join("\n"),
    );

    const result = await getSandboxPolicy("alpha", fake.readPolicy);

    expect(result.raw).toContain("Version: 4");
    expect(result.raw).toContain("---");
    expect(result.yaml).toContain("SERVICE_API_KEY");
    expect(result.yaml).toContain("[STRIPPED_BY_MIGRATION]");
    expect(result.raw).not.toContain(credential);
    expect(result.yaml).not.toContain(credential);
    expect(result.raw).not.toContain(urlCredential);
    expect(result.yaml).not.toContain(urlCredential);
  });

  it.each([
    [
      "authentication",
      {
        kind: "authentication",
        message: "OpenShell could not authenticate the sandbox policy read.",
      },
      "Restore authentication for the sandbox's OpenShell gateway",
    ],
    [
      "unreachable gateway",
      {
        kind: "transport",
        reason: "unreachable",
        message: "The sandbox's OpenShell gateway is unreachable.",
      },
      "Select the sandbox's recorded gateway first with `openshell gateway select nemoclaw-18080`. Verify the gateway with `openshell status`.",
    ],
    [
      "schema mismatch",
      { kind: "schema", message: "The OpenShell CLI and gateway policy schemas do not match." },
      "Update the OpenShell CLI and gateway to compatible versions",
    ],
  ] as const)(
    "preserves typed %s failures with gateway-specific recovery",
    async (_label, error, recovery) => {
      vi.spyOn(gatewayTarget, "getKnownSandboxTargetGatewayName").mockReturnValue("nemoclaw-18080");

      const failure = await getSandboxPolicy("alpha", failedPolicyRead(error)).catch(
        (caught: unknown) => caught,
      );

      expect(failure).toBeInstanceOf(PolicyObservationError);
      expect(failure).toMatchObject({ policyReadError: error });
      expect((failure as Error).message).toContain("sandbox 'alpha'");
      expect((failure as Error).message).toContain("recorded gateway 'nemoclaw-18080'");
      expect((failure as Error).message).toContain(recovery);
      expect((failure as Error).message).toContain("`nemoclaw alpha policy get`");
    },
  );
});
