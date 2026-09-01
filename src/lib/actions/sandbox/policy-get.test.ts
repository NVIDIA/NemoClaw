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
import * as openshellResolveModule from "../../adapters/openshell/resolve";
import * as registry from "../../state/registry";
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
        "Hash: sha256:abc",
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

  it("returns empty output when OpenShell succeeds without a policy", async () => {
    const fake = createFakeOpenShell("");

    await expect(getSandboxPolicy("alpha", fake.readPolicy)).resolves.toEqual({
      raw: "",
      yaml: "",
    });
    expect(fs.readFileSync(fake.argsPath, "utf8").trim()).toBe("policy get --base alpha");
  });

  it("preserves unparsed output while rejecting malformed policy YAML", async () => {
    const fake = createFakeOpenShell("Version: 1\nHash: sha256:abc\nStatus: active\n");

    await expect(getSandboxPolicy("alpha", fake.readPolicy)).resolves.toEqual({
      raw: fake.output.trim(),
      yaml: "",
    });
  });

  it("adds sandbox context when the OpenShell subprocess fails", async () => {
    const fake = createFakeOpenShell("gateway unavailable\n", 42);

    await expect(getSandboxPolicy("alpha", fake.readPolicy)).rejects.toThrow(
      /Failed to retrieve base policy for sandbox 'alpha'\. The OpenShell sandbox policy read failed/,
    );
    expect(fs.readFileSync(fake.argsPath, "utf8").trim()).toBe("policy get --base alpha");
  });

  it("preserves actionable guidance when the OpenShell binary is missing (#9805)", async () => {
    vi.spyOn(openshellResolveModule, "resolveOpenshell").mockReturnValue(null);
    vi.stubEnv("HOME", "/home/nemoclaw-test");
    vi.stubEnv("PATH", "/nonexistent-nemoclaw-path");
    vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", "/nonexistent/openshell");

    const failure = await getSandboxPolicy("alpha").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    const message = String((failure as Error).message);
    expect(message).toContain("openshell binary not found. Checked:");
    expect(message).toContain("NEMOCLAW_OPENSHELL_BIN=/nonexistent/openshell");
    expect(message).toContain("PATH=/nonexistent-nemoclaw-path");
    expect(message).toContain("/home/nemoclaw-test/.local/bin/openshell");
    expect(message).toContain("/usr/local/bin/openshell");
    expect(message).toContain("/usr/bin/openshell");
    expect(message).toContain("Install OpenShell");
  });

  it("requests the base policy through a typed policy fake (#9805)", async () => {
    const readPolicy: CliOpenShellSandboxPolicyRead = vi.fn(async () => ({
      result: {
        ok: true as const,
        value: {
          scope: "base" as const,
          document: "version: 1\nnetwork_policies: {}",
          reportedRevision: 7,
          appliedRevision: 7,
        },
      },
      displayOutput: "Version: 7\nActive: 7\n---\nversion: 1\nnetwork_policies: {}",
    }));

    await expect(getSandboxPolicy("alpha", readPolicy)).resolves.toMatchObject({
      yaml: "version: 1\nnetwork_policies: {}",
    });
    expect(readPolicy).toHaveBeenCalledWith({
      target: { kind: "selected" },
      sandboxName: "alpha",
      scope: "base",
    });
  });

  it("reads a registered sandbox from its owning gateway instead of the selected sibling", async () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "alpha",
      gatewayName: "nemoclaw-8091",
      gatewayPort: 8091,
    } as never);
    const readPolicy: CliOpenShellSandboxPolicyRead = vi.fn(async () => ({
      result: {
        ok: true as const,
        value: {
          scope: "base" as const,
          document: "version: 1\nnetwork_policies: {}",
          reportedRevision: 7,
          appliedRevision: 7,
        },
      },
      displayOutput: "Version: 7\nActive: 7\n---\nversion: 1\nnetwork_policies: {}",
    }));

    await expect(getSandboxPolicy("alpha", readPolicy)).resolves.toMatchObject({
      yaml: "version: 1\nnetwork_policies: {}",
    });
    expect(readPolicy).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw-8091" },
      sandboxName: "alpha",
      scope: "base",
    });
  });
});
