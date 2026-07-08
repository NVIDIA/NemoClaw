// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import { getSandboxPolicy } from "./policy-get";

type FakeOpenShell = {
  argsPath: string;
  output: string;
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
  vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", executablePath);
  return { argsPath, output };
}

describe("getSandboxPolicy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reads --base and strips OpenShell metadata into round-trippable YAML (#6052)", () => {
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

    const result = getSandboxPolicy("alpha");

    expect(fs.readFileSync(fake.argsPath, "utf8").trim()).toBe("policy get --base alpha");
    expect(result.raw).toBe(fake.output.trim());
    expect(result.yaml).toBe(yaml);
    expect(YAML.parse(result.yaml)).toEqual({
      version: 1,
      filesystem_policy: { read_only: [] },
      network_policies: {},
    });
  });

  it("returns empty output when OpenShell succeeds without a policy", () => {
    const fake = createFakeOpenShell("");

    expect(getSandboxPolicy("alpha")).toEqual({ raw: "", yaml: "" });
    expect(fs.readFileSync(fake.argsPath, "utf8").trim()).toBe("policy get --base alpha");
  });

  it("preserves unparsed output while rejecting malformed policy YAML", () => {
    const fake = createFakeOpenShell("Version: 1\nHash: sha256:abc\nStatus: active\n");

    expect(getSandboxPolicy("alpha")).toEqual({
      raw: fake.output.trim(),
      yaml: "",
    });
  });

  it("adds sandbox context when the OpenShell subprocess fails", () => {
    const fake = createFakeOpenShell("gateway unavailable\n", 42);

    expect(() => getSandboxPolicy("alpha")).toThrow(
      /Failed to retrieve base policy for sandbox 'alpha'\. Command failed with status 42/,
    );
    expect(fs.readFileSync(fake.argsPath, "utf8").trim()).toBe("policy get --base alpha");
  });
});
