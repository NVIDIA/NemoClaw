// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { MCP_BRIDGE_RUNTIME_COMPATIBILITY_ARTIFACT } from "../../../tools/e2e/mcp-bridge-runtime-compatibility.mts";

const COMPATIBILITY_TOOL = path.resolve("tools/e2e/mcp-bridge-runtime-compatibility.mts");

function runCompatibilityCli(versionStdout: string, versionStderr = "") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-compat-cli-"));
  const artifactDirectory = path.join(root, "artifacts");
  const githubOutputPath = path.join(root, "github-output.txt");
  const githubSummaryPath = path.join(root, "github-summary.md");
  const openshellPath = path.join(root, "openshell");
  fs.mkdirSync(artifactDirectory);
  fs.writeFileSync(githubOutputPath, "", "utf8");
  fs.writeFileSync(githubSummaryPath, "", "utf8");
  fs.writeFileSync(
    openshellPath,
    [
      `#!${process.execPath}`,
      'if (process.argv.length !== 3 || process.argv[2] !== "--version") process.exit(2);',
      `process.stdout.write(${JSON.stringify(versionStdout)});`,
      `process.stderr.write(${JSON.stringify(versionStderr)});`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.chmodSync(openshellPath, 0o755);

  const result = spawnSync(
    process.execPath,
    ["--no-warnings", "--import", "tsx", COMPATIBILITY_TOOL],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        TMPDIR: root,
        LANG: "C",
        NODE_NO_WARNINGS: "1",
        NEMOCLAW_OPENSHELL_BIN: openshellPath,
        E2E_ARTIFACT_DIR: artifactDirectory,
        GITHUB_OUTPUT: githubOutputPath,
        GITHUB_STEP_SUMMARY: githubSummaryPath,
      },
      killSignal: "SIGKILL",
      timeout: 30_000,
    },
  );

  return {
    artifactDirectory,
    githubOutputPath,
    githubSummaryPath,
    result,
    root,
  };
}

describe.skipIf(process.platform === "win32")("MCP bridge compatibility CLI", () => {
  it("emits expected mismatch evidence through the real entrypoint (#6426)", () => {
    const run = runCompatibilityCli("openshell 0.0.78-dev.6+ga7271169\n");
    try {
      expect(run.result.error).toBeUndefined();
      expect(run.result.signal).toBeNull();
      expect(run.result.status).toBe(0);
      expect(run.result.stderr).toBe("");
      expect(run.result.stdout).toContain("::notice title=OpenShell dev compatibility::");
      expect(run.result.stdout).not.toContain("0.0.78-dev.6+ga7271169");
      expect(run.result.stdout).not.toContain("0.0.72");
      expect(fs.readFileSync(run.githubOutputPath, "utf8")).toBe(
        [
          "mode=expected-version-mismatch",
          "expected_version=0.0.72",
          "actual_version=0.0.78-dev.6+ga7271169",
          "",
        ].join("\n"),
      );
      const artifact = JSON.parse(
        fs.readFileSync(
          path.join(run.artifactDirectory, MCP_BRIDGE_RUNTIME_COMPATIBILITY_ARTIFACT),
          "utf8",
        ),
      );
      expect(artifact).toMatchObject({
        schemaVersion: 1,
        lane: "mcp-bridge-dev",
        artifactKind: "runtime-compatibility-preflight",
        classificationStatus: "passed",
        compatibility: "unsupported-version",
        mode: "expected-version-mismatch",
        expectedOpenShellVersion: "0.0.72",
        actualOpenShellVersion: "0.0.78-dev.6+ga7271169",
        credentialBoundaryGate: "rejected-as-required",
        fullLifecycle: "not-run",
      });
      expect(artifact).not.toHaveProperty("guardMessage");
      const summary = fs.readFileSync(run.githubSummaryPath, "utf8");
      expect(summary).toContain(
        "the exact-version gate rejected the unsupported runtime as required",
      );
      expect(summary).not.toContain("0.0.78-dev.6+ga7271169");
      expect(summary).not.toContain("0.0.72");
    } finally {
      fs.rmSync(run.root, { force: true, recursive: true });
    }
  });

  it("keeps malformed probe output fatal and out of shared evidence (#6426)", () => {
    const secret = "MCP_TEST_TOKEN=fixture-credential-do-not-log-6426";
    const run = runCompatibilityCli("openshell 0.0.72\n", `${secret}\n`);
    try {
      expect(run.result.error).toBeUndefined();
      expect(run.result.signal).toBeNull();
      expect(run.result.status).toBe(1);
      expect(run.result.stderr).toContain(
        "actual <unparseable> (invalid openshell --version output)",
      );
      const sharedEvidence = [
        run.result.stdout,
        run.result.stderr,
        fs.readFileSync(run.githubOutputPath, "utf8"),
        fs.readFileSync(run.githubSummaryPath, "utf8"),
        ...fs
          .readdirSync(run.artifactDirectory)
          .map((name) => fs.readFileSync(path.join(run.artifactDirectory, name), "utf8")),
      ].join("\n");
      expect(sharedEvidence).not.toContain(secret);
      expect(sharedEvidence).not.toContain("MCP_TEST_TOKEN");
      expect(fs.readFileSync(run.githubOutputPath, "utf8")).toBe("");
      expect(fs.readFileSync(run.githubSummaryPath, "utf8")).toBe("");
      expect(
        fs.existsSync(path.join(run.artifactDirectory, MCP_BRIDGE_RUNTIME_COMPATIBILITY_ARTIFACT)),
      ).toBe(false);
    } finally {
      fs.rmSync(run.root, { force: true, recursive: true });
    }
  });

  it("reports missing workflow output paths without probing OpenShell (#6426)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-compat-cli-"));
    try {
      const probeMarker = path.join(root, "openshell-probed");
      const openshellPath = path.join(root, "openshell");
      fs.writeFileSync(
        openshellPath,
        [
          `#!${process.execPath}`,
          `require("node:fs").writeFileSync(${JSON.stringify(probeMarker)}, "probed");`,
          'process.stdout.write("openshell 0.0.72\\n");',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.chmodSync(openshellPath, 0o755);

      for (const missingName of ["E2E_ARTIFACT_DIR", "GITHUB_OUTPUT"]) {
        const env: Record<string, string> = {
          PATH: process.env.PATH ?? "",
          HOME: root,
          TMPDIR: root,
          LANG: "C",
          NODE_NO_WARNINGS: "1",
          NEMOCLAW_OPENSHELL_BIN: openshellPath,
          E2E_ARTIFACT_DIR: path.join(root, "artifacts"),
          GITHUB_OUTPUT: path.join(root, "github-output.txt"),
        };
        delete env[missingName];
        const result = spawnSync(
          process.execPath,
          ["--no-warnings", "--import", "tsx", COMPATIBILITY_TOOL],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            env,
            killSignal: "SIGKILL",
            timeout: 30_000,
          },
        );

        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("E2E_ARTIFACT_DIR and GITHUB_OUTPUT are required");
        expect(result.stderr).not.toContain("OpenShell credential boundary runtime version check");
        expect(fs.existsSync(probeMarker)).toBe(false);
      }
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});
