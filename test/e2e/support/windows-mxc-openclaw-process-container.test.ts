// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { sha256WindowsOpenClawArtifactTree } from "../../../tools/e2e/windows-mxc-openclaw-artifact-tree.mts";
import {
  allowlistedWindowsProcessEnvironment,
  assertCleanCheckoutIdentity,
  assertExactArtifactIdentities,
  assertExpectedOpenClawProcessIdentity,
  assertExpectedOpenShellGatewayProcessIdentity,
  normalizeReportedVersion,
  parseWindowsMxcOpenClawQualificationEnvironment,
  parseWindowsProcessQueryResult,
  renderWindowsMxcFilesystemPolicy,
  renderWindowsMxcGatewayConfig,
  renderWindowsMxcOpenClawProbeAgent,
  sameWindowsProcessIdentity,
  sandboxListContainsExactName,
  sha256File,
  shouldRetrySandboxDelete,
} from "../live/windows-mxc-openclaw-process-container-helpers.ts";

const roots: string[] = [];

function fixture(): { readonly environment: NodeJS.ProcessEnv; readonly root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mxc-contract-"));
  roots.push(root);
  const artifactDirectory = path.join(root, "evidence");
  const openClawRoot = path.join(root, "openclaw");
  fs.mkdirSync(artifactDirectory, { recursive: true });
  fs.mkdirSync(path.join(openClawRoot, "node"), { recursive: true });
  fs.mkdirSync(path.join(openClawRoot, "runtime"), { recursive: true });
  const paths = {
    cli: path.join(root, "openshell.exe"),
    entry: path.join(openClawRoot, "runtime", "openclaw.mjs"),
    gateway: path.join(root, "openshell-gateway.exe"),
    node: path.join(openClawRoot, "node", "node.exe"),
    wxc: path.join(root, "wxc-exec.exe"),
  };
  for (const [name, file] of Object.entries(paths)) fs.writeFileSync(file, name, "utf8");
  return {
    root,
    environment: {
      E2E_ARTIFACT_DIR: artifactDirectory,
      NEMOCLAW_E2E_EXPECTED_SHA: "a".repeat(40),
      NEMOCLAW_WINDOWS_MXC_NODE: paths.node,
      NEMOCLAW_WINDOWS_MXC_NODE_SHA256: sha256File(paths.node),
      NEMOCLAW_WINDOWS_MXC_OPENCLAW_ENTRY: paths.entry,
      NEMOCLAW_WINDOWS_MXC_OPENCLAW_ENTRY_SHA256: sha256File(paths.entry),
      NEMOCLAW_WINDOWS_MXC_OPENCLAW_ARTIFACT_TREE_SHA256:
        sha256WindowsOpenClawArtifactTree(openClawRoot),
      NEMOCLAW_WINDOWS_MXC_OPENCLAW_ROOT: openClawRoot,
      NEMOCLAW_WINDOWS_MXC_OPENCLAW_VERSION: "2026.7.1",
      NEMOCLAW_WINDOWS_MXC_OPENSHELL_CLI: paths.cli,
      NEMOCLAW_WINDOWS_MXC_OPENSHELL_CLI_SHA256: sha256File(paths.cli),
      NEMOCLAW_WINDOWS_MXC_OPENSHELL_GATEWAY: paths.gateway,
      NEMOCLAW_WINDOWS_MXC_OPENSHELL_GATEWAY_SHA256: sha256File(paths.gateway),
      NEMOCLAW_WINDOWS_MXC_OPENSHELL_REVISION: "b".repeat(40),
      NEMOCLAW_WINDOWS_MXC_OPENSHELL_VERSION: "0.0.12",
      NEMOCLAW_WINDOWS_MXC_WXC_EXEC: paths.wxc,
      NEMOCLAW_WINDOWS_MXC_WXC_EXEC_SHA256: sha256File(paths.wxc),
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("inactive Windows MXC OpenClaw process_container qualification", () => {
  it("requires exact identities and keeps the OpenClaw launch files under one artifact root (#8178)", () => {
    const { environment } = fixture();
    const parsed = parseWindowsMxcOpenClawQualificationEnvironment(environment);

    expect(parsed.openClaw.version).toBe("2026.7.1");
    expect(parsed.openShell.packageVersion).toBe("0.0.12");
    expect(parsed.expected.openClawArtifactTreeSha256).toBe(
      environment.NEMOCLAW_WINDOWS_MXC_OPENCLAW_ARTIFACT_TREE_SHA256,
    );
    expect(parsed.expected.wxcExecSha256).toBe(environment.NEMOCLAW_WINDOWS_MXC_WXC_EXEC_SHA256);
  });

  it("rejects an OpenClaw executable outside the staged artifact root (#8178)", () => {
    const { environment, root } = fixture();
    const outside = path.join(root, "outside-node.exe");
    fs.writeFileSync(outside, "node", "utf8");
    environment.NEMOCLAW_WINDOWS_MXC_NODE = outside;
    environment.NEMOCLAW_WINDOWS_MXC_NODE_SHA256 = sha256File(outside);

    expect(() => parseWindowsMxcOpenClawQualificationEnvironment(environment)).toThrow(
      /must be a child of the OpenClaw artifact root/u,
    );
  });

  it("rejects moving aliases instead of exact digest and revision identities (#8178)", () => {
    const { environment } = fixture();
    environment.NEMOCLAW_WINDOWS_MXC_OPENSHELL_REVISION = "main";
    environment.NEMOCLAW_WINDOWS_MXC_WXC_EXEC_SHA256 = "latest";

    expect(() => parseWindowsMxcOpenClawQualificationEnvironment(environment)).toThrow(
      /unsupported format/u,
    );
  });

  it("rejects an artifact replaced after its initial identity check (#8178)", () => {
    const { environment } = fixture();
    const parsed = parseWindowsMxcOpenClawQualificationEnvironment(environment);
    assertExactArtifactIdentities(parsed);

    fs.writeFileSync(parsed.openShell.cliPath, "replacement", "utf8");

    expect(() => assertExactArtifactIdentities(parsed)).toThrow(
      /openShellCliSha256 does not match the expected exact identity/u,
    );
  });

  it("rejects dirty source identity and version-prefix matches (#8178)", () => {
    expect(() =>
      assertCleanCheckoutIdentity({
        expectedRevision: "a".repeat(40),
        observedRevision: "a".repeat(40),
        statusOutput: " M test/e2e/README.md\n",
      }),
    ).toThrow(/must be clean/u);
    expect(() =>
      assertCleanCheckoutIdentity({
        expectedRevision: "a".repeat(40),
        observedRevision: "b".repeat(40),
        statusOutput: "",
      }),
    ).toThrow(/does not match/u);
    expect(normalizeReportedVersion("OpenClaw 2026.7.1\n")).toBe("2026.7.1");
    expect(normalizeReportedVersion("2026.7.10\n")).toBe("2026.7.10");
    expect(normalizeReportedVersion("OpenClaw version 2026.7.1 extra\n")).toBeNull();
  });

  it("matches exact registry names and identifies when delete needs a retry (#8178)", () => {
    expect(sandboxListContainsExactName('[{"name":"mxc-oc-123-extra"}]', "mxc-oc-123")).toBe(false);
    expect(sandboxListContainsExactName('[{"name":"mxc-oc-123"}]', "mxc-oc-123")).toBe(true);
    expect(shouldRetrySandboxDelete(true, true)).toBe(true);
    expect(shouldRetrySandboxDelete(true, false)).toBe(false);
  });

  it("compares the complete Windows process identity (#8178)", () => {
    const child = {
      commandLine: '"C:\\artifact\\node.exe" "C:\\artifact\\openclaw.mjs" gateway run --port 23456',
      creationDate: "20260804180001.000000-420",
      executablePath: "C:\\artifact\\node.exe",
      parentProcessId: 41,
      processId: 42,
    };
    expect(
      sameWindowsProcessIdentity(child, {
        ...child,
        creationDate: "20260804180002.000000-420",
      }),
    ).toBe(false);
  });

  it("accepts only the expected OpenClaw child and parent command identities (#8178)", () => {
    const parent = {
      commandLine: '"C:\\artifact\\node.exe" "C:\\probe\\probe-agent.mjs"',
      creationDate: "20260804180000.000000-420",
      executablePath: "C:\\artifact\\node.exe",
      parentProcessId: 40,
      processId: 41,
    };
    const child = {
      commandLine: '"C:\\artifact\\node.exe" "C:\\artifact\\openclaw.mjs" gateway run --port 23456',
      creationDate: "20260804180001.000000-420",
      executablePath: "C:\\artifact\\node.exe",
      parentProcessId: 41,
      processId: 42,
    };
    expect(() =>
      assertExpectedOpenClawProcessIdentity(
        { child, parent },
        {
          entryPath: "C:\\artifact\\openclaw.mjs",
          nodePath: "C:\\artifact\\node.exe",
          port: 23456,
          probeAgentPath: "C:\\probe\\probe-agent.mjs",
        },
      ),
    ).not.toThrow();
    expect(() =>
      assertExpectedOpenClawProcessIdentity(
        { child: { ...child, executablePath: "C:\\Windows\\System32\\svchost.exe" }, parent },
        {
          entryPath: "C:\\artifact\\openclaw.mjs",
          nodePath: "C:\\artifact\\node.exe",
          port: 23456,
          probeAgentPath: "C:\\probe\\probe-agent.mjs",
        },
      ),
    ).toThrow(/does not match/u);
    expect(() =>
      assertExpectedOpenClawProcessIdentity(
        {
          child: {
            ...child,
            commandLine:
              '"C:\\artifact\\node.exe" "C:\\artifact\\openclaw.mjs.extra" gateway run --port 23456',
          },
          parent,
        },
        {
          entryPath: "C:\\artifact\\openclaw.mjs",
          nodePath: "C:\\artifact\\node.exe",
          port: 23456,
          probeAgentPath: "C:\\probe\\probe-agent.mjs",
        },
      ),
    ).toThrow(/does not match/u);
  });

  it("requires the OpenShell gateway path and ordered port argument pair (#8178)", () => {
    const identity = {
      commandLine: '"C:\\package\\openshell-gateway.exe" --port 17670 --disable-tls',
      creationDate: "20260804180000.000000-420",
      executablePath: "C:\\package\\openshell-gateway.exe",
      parentProcessId: 40,
      processId: 41,
    };
    expect(() =>
      assertExpectedOpenShellGatewayProcessIdentity(identity, {
        gatewayPath: "C:\\package\\openshell-gateway.exe",
        port: 17670,
      }),
    ).not.toThrow();
    expect(() =>
      assertExpectedOpenShellGatewayProcessIdentity(
        {
          ...identity,
          commandLine: '"C:\\package\\openshell-gateway.exe" --disable-tls 17670 --port',
        },
        { gatewayPath: "C:\\package\\openshell-gateway.exe", port: 17670 },
      ),
    ).toThrow(/does not match/u);
  });

  it("renders a gateway-scoped process_container probe without credential values (#8178)", () => {
    const config = renderWindowsMxcGatewayConfig({
      agentPath: "C:\\artifact\\node.exe",
      shareDirectory: "C:\\probe\\share",
      wxcExecPath: "C:\\package\\wxc-exec.exe",
    });

    expect(config).toContain('backend = "process_container"');
    expect(config).toContain("pc_least_privilege = true");
    expect(config).toContain('"NEMOCLAW_MXC_E2E_TOKEN"');
    expect(config).not.toContain("credential-value");
    expect(config).not.toContain("--token");
  });

  it("grants the artifact read-only and only the probe share read-write (#8178)", () => {
    const policy = renderWindowsMxcFilesystemPolicy({
      openClawRoot: "C:\\artifact",
      shareDirectory: "C:\\probe\\share",
    });

    expect(policy).toContain('read_only:\n    - "C:/artifact"');
    expect(policy).toContain('read_write:\n    - "C:/probe/share"');
    expect(policy).toContain("include_workdir: false");
  });

  it("keeps the ephemeral readiness token out of OpenClaw arguments and source literals (#8178)", () => {
    const agent = renderWindowsMxcOpenClawProbeAgent();

    expect(agent).toContain('required("NEMOCLAW_MXC_E2E_TOKEN")');
    expect(agent).toContain("if (gateway.pid !== undefined)");
    expect(agent).toContain('gateway.once("error"');
    expect(agent).toContain("writeFileSync(outcomePath");
    expect(agent).toContain('"gateway",\n    "health"');
    expect(agent).not.toContain('"--token"');
    expect(agent).not.toMatch(/[A-Za-z0-9_-]{40,}/u);
  });

  it("passes only allowlisted Windows runtime variables to host child processes (#8178)", () => {
    const allowed = allowlistedWindowsProcessEnvironment({
      AWS_SECRET_ACCESS_KEY: "secret",
      Path: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      UNRELATED_CREDENTIAL: "secret",
    });

    expect(allowed).toEqual({ Path: "C:\\Windows\\System32", SystemRoot: "C:\\Windows" });
  });

  it("fails closed when a Windows process query fails without output (#8178)", () => {
    expect(() =>
      parseWindowsProcessQueryResult({ exitCode: 1, stderr: "query failed", stdout: "" }),
    ).toThrow(/query failed/u);
    expect(parseWindowsProcessQueryResult({ exitCode: 3, stderr: "", stdout: "" })).toBeNull();
  });

  it("changes the artifact digest when file content or relative paths change (#8178)", () => {
    const { root } = fixture();
    const artifact = path.join(root, "digest-artifact");
    fs.mkdirSync(artifact);
    const first = path.join(artifact, "first.txt");
    fs.writeFileSync(first, "one", "utf8");
    const initial = sha256WindowsOpenClawArtifactTree(artifact);
    fs.writeFileSync(first, "two", "utf8");
    const contentChanged = sha256WindowsOpenClawArtifactTree(artifact);
    fs.renameSync(first, path.join(artifact, "second.txt"));
    const pathChanged = sha256WindowsOpenClawArtifactTree(artifact);

    expect(contentChanged).not.toBe(initial);
    expect(pathChanged).not.toBe(contentChanged);
  });

  it("rejects links in the OpenClaw artifact tree (#8178)", () => {
    const { root } = fixture();
    const artifact = path.join(root, "linked-artifact");
    fs.mkdirSync(artifact);
    const target = path.join(artifact, "target.txt");
    fs.writeFileSync(target, "content", "utf8");
    fs.symlinkSync(target, path.join(artifact, "link.txt"));

    expect(() => sha256WindowsOpenClawArtifactTree(artifact)).toThrow(/must not contain links/u);
  });

  it.runIf(process.platform !== "win32")(
    "rejects unsupported entries in the OpenClaw artifact tree (#8178)",
    async () => {
      const artifact = fs.mkdtempSync(path.join("/tmp", "nemoclaw-mxc-socket-"));
      roots.push(artifact);
      const socketPath = path.join(artifact, "runtime.sock");
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      try {
        expect(() => sha256WindowsOpenClawArtifactTree(artifact)).toThrow(/unsupported file type/u);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
