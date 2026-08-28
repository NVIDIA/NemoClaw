// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { spawnSync } from "node:child_process";
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
  assertExpectedOpenShellForwardProcessIdentity,
  assertExpectedOpenShellGatewayProcessIdentity,
  classifyWindowsMxcOpenClawStartupObservation,
  classifyWindowsMxcForwardHealthObservation,
  createWindowsMxcOpenShellAttachmentObservationRequest,
  createWindowsMxcQualificationFailure,
  normalizeReportedVersion,
  observeWindowsMxcForwardHealthReadiness,
  parseWindowsMxcOpenClawQualificationEnvironment,
  parseOpenClawExactChatReply,
  parseOpenClawHealthResult,
  parseWindowsProcessQueryResult,
  renderWindowsMxcFilesystemPolicy,
  renderWindowsMxcGatewayConfig,
  renderWindowsMxcOpenClawProbeAgent,
  removeWindowsMxcRuntimeArtifacts,
  retainedWindowsMxcSandboxName,
  runWindowsMxcForwardCleanup,
  sameWindowsProcessIdentity,
  sandboxListContainsExactName,
  sha256File,
  shouldRetrySandboxDelete,
  withWindowsMxcLocalSetupOwnership,
  windowsMxcOpenClawStartupPreconditionsPass,
  withoutOpenShellGatewaySelection,
} from "../live/windows-mxc-openclaw-process-container-helpers.ts";

const roots: string[] = [];

function fixture(): { readonly environment: NodeJS.ProcessEnv; readonly root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mxc-contract-"));
  roots.push(root);
  const artifactDirectory = path.join(root, "evidence");
  const distributionDirectory = path.join(root, "packages");
  const openShellRoot = path.join(root, "openshell");
  const mxcRoot = path.join(root, "mxc");
  const openClawRoot = path.join(root, "openclaw");
  fs.mkdirSync(artifactDirectory, { recursive: true });
  fs.mkdirSync(distributionDirectory, { recursive: true });
  fs.mkdirSync(openShellRoot, { recursive: true });
  fs.mkdirSync(mxcRoot, { recursive: true });
  fs.mkdirSync(path.join(openClawRoot, "node"), { recursive: true });
  fs.mkdirSync(path.join(openClawRoot, "runtime"), { recursive: true });
  const paths = {
    artifact: path.join(distributionDirectory, "openshell.zip"),
    cli: path.join(openShellRoot, "openshell.exe"),
    entry: path.join(openClawRoot, "runtime", "openclaw.mjs"),
    gateway: path.join(openShellRoot, "openshell-gateway.exe"),
    node: path.join(openClawRoot, "node", "node.exe"),
    relay: path.join(openShellRoot, "openshell-supervisor-relay.exe"),
    wxc: path.join(mxcRoot, "wxc-exec.exe"),
  };
  for (const [name, file] of Object.entries(paths)) fs.writeFileSync(file, name, "utf8");
  return {
    root,
    environment: {
      E2E_ARTIFACT_DIR: artifactDirectory,
      NEMOCLAW_E2E_EXPECTED_SHA: "a".repeat(40),
      NEMOCLAW_WINDOWS_MXC_HOST_PREPARATION: "wxc-host-prep-prepare-system-drive",
      NEMOCLAW_WINDOWS_MXC_NODE: paths.node,
      NEMOCLAW_WINDOWS_MXC_NODE_SHA256: sha256File(paths.node),
      NEMOCLAW_WINDOWS_MXC_OPENCLAW_ENTRY: paths.entry,
      NEMOCLAW_WINDOWS_MXC_OPENCLAW_ENTRY_SHA256: sha256File(paths.entry),
      NEMOCLAW_WINDOWS_MXC_OPENCLAW_ARTIFACT_TREE_SHA256:
        sha256WindowsOpenClawArtifactTree(openClawRoot),
      NEMOCLAW_WINDOWS_MXC_OPENCLAW_ROOT: openClawRoot,
      NEMOCLAW_WINDOWS_MXC_OPENCLAW_VERSION: "2026.7.1",
      NEMOCLAW_WINDOWS_MXC_OPENSHELL_DISTRIBUTION_ARTIFACT: paths.artifact,
      NEMOCLAW_WINDOWS_MXC_OPENSHELL_DISTRIBUTION_ROOT: openShellRoot,
      NEMOCLAW_WINDOWS_MXC_OPENSHELL_DISTRIBUTION_SHA256: sha256File(paths.artifact),
      NEMOCLAW_WINDOWS_MXC_OPENSHELL_CLI: paths.cli,
      NEMOCLAW_WINDOWS_MXC_OPENSHELL_CLI_SHA256: sha256File(paths.cli),
      NEMOCLAW_WINDOWS_MXC_OPENSHELL_GATEWAY: paths.gateway,
      NEMOCLAW_WINDOWS_MXC_OPENSHELL_GATEWAY_SHA256: sha256File(paths.gateway),
      NEMOCLAW_WINDOWS_MXC_OPENSHELL_RELAY: paths.relay,
      NEMOCLAW_WINDOWS_MXC_OPENSHELL_RELAY_SHA256: sha256File(paths.relay),
      NEMOCLAW_WINDOWS_MXC_OPENSHELL_REVISION: "b".repeat(40),
      NEMOCLAW_WINDOWS_MXC_OPENSHELL_VERSION: "0.0.12",
      NEMOCLAW_WINDOWS_MXC_ROOT: mxcRoot,
      NEMOCLAW_WINDOWS_MXC_WXC_EXEC: paths.wxc,
      NEMOCLAW_WINDOWS_MXC_WXC_EXEC_SHA256: sha256File(paths.wxc),
      NEMOCLAW_WINDOWS_MXC_WORK_ROOT: root,
    },
  };
}

function withProcessPlatform(platform: NodeJS.Platform, operation: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    operation();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("inactive Windows MXC OpenClaw process_container qualification", () => {
  it("removes a token-bearing MXC environment file after a runtime failure (#8178)", () => {
    const { root } = fixture();
    const runRoot = fs.mkdtempSync(path.join(root, "runtime-failure-"));
    const shareDirectory = fs.mkdtempSync(path.join(root, "runtime-share-"));
    const token = "runtime-only-secret";
    fs.writeFileSync(
      path.join(shareDirectory, "agent-env.txt"),
      `NEMOCLAW_MXC_E2E_TOKEN=${token}\n`,
      "utf8",
    );

    const result = removeWindowsMxcRuntimeArtifacts({
      runRoot,
      sensitivePaths: [],
      shareDirectory,
    });

    expect(result).toEqual({
      failures: [],
      runDirectoryRemoved: true,
      sensitiveRuntimeArtifactsRemoved: true,
    });
    expect(fs.existsSync(runRoot)).toBe(false);
    expect(fs.existsSync(shareDirectory)).toBe(false);
  });

  it("removes token-bearing setup state and closes descriptors after a setup failure (#8178)", async () => {
    const { root } = fixture();
    const receiptPath = path.join(root, "setup-failure-receipt.json");
    const token = "setup-only-secret";
    let descriptor = -1;
    let ownedRoot = "";

    await expect(
      withWindowsMxcLocalSetupOwnership({
        receiptPath,
        failureReceipt: (localArtifactsRemoved) => ({
          cleanup: { localArtifactsRemoved },
          verdict: "fail",
        }),
        operation: async (ownership) => {
          ownedRoot = ownership.trackRoot(fs.mkdtempSync(path.join(root, "owned-setup-")));
          const tokenFile = path.join(ownedRoot, "client-home", ".openclaw", "openclaw.json");
          fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
          fs.writeFileSync(tokenFile, JSON.stringify({ token }), "utf8");
          descriptor = ownership.trackDescriptor(
            fs.openSync(path.join(ownedRoot, "gateway.log"), "w"),
          );
          throw new Error("injected setup failure");
        },
      }),
    ).rejects.toThrow(/local setup failed/u);

    expect(fs.existsSync(ownedRoot)).toBe(false);
    expect(() => fs.fstatSync(descriptor)).toThrow();
    const receiptText = fs.readFileSync(receiptPath, "utf8");
    expect(receiptText).not.toContain(token);
    expect(JSON.parse(receiptText)).toEqual({
      cleanup: { localArtifactsRemoved: true },
      verdict: "fail",
    });
  });

  it("continues forward cleanup after a trusted process query fails (#8178)", async () => {
    const events: string[] = [];
    let processExitChecks = 0;
    const result = await runWindowsMxcForwardCleanup({
      childWasRunning: true,
      sandboxDeleteAccepted: true,
      stopChild: async () => {
        events.push("stop-child");
      },
      terminateTrustedProcessIfAlive: async () => {
        events.push("query-trusted-process");
        throw new Error("injected process query failure");
      },
      waitForProcessExit: async () => {
        events.push("wait-for-process-exit");
        processExitChecks += 1;
        return processExitChecks > 1;
      },
      waitForListenerClosed: async () => {
        events.push("wait-for-listener-close");
        return true;
      },
    });

    expect(events).toEqual([
      "wait-for-process-exit",
      "stop-child",
      "query-trusted-process",
      "wait-for-process-exit",
      "wait-for-listener-close",
    ]);
    expect(result).toMatchObject({
      emergencyTerminationNeeded: true,
      listenerStopped: true,
      processStopped: true,
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toEqual(new Error("injected process query failure"));
  });

  it("allows a bounded natural forward exit after sandbox deletion (#8178)", async () => {
    const events: string[] = [];
    const result = await runWindowsMxcForwardCleanup({
      childWasRunning: true,
      sandboxDeleteAccepted: true,
      stopChild: async () => {
        events.push("stop-child");
      },
      terminateTrustedProcessIfAlive: async () => {
        events.push("query-trusted-process");
        return false;
      },
      waitForProcessExit: async () => {
        events.push("wait-for-process-exit");
        return true;
      },
      waitForListenerClosed: async () => {
        events.push("wait-for-listener-close");
        return true;
      },
    });

    expect(events).toEqual([
      "wait-for-process-exit",
      "query-trusted-process",
      "wait-for-listener-close",
    ]);
    expect(result).toEqual({
      emergencyTerminationNeeded: false,
      failures: [],
      listenerStopped: true,
      processStopped: true,
    });
  });

  it("records the retained sandbox when cleanup cannot confirm deletion (#8178)", () => {
    const sandboxName = "mxc-oc-retained";
    const retainedSandboxName = retainedWindowsMxcSandboxName({
      registryRemovedAfterDelete: false,
      sandboxCreateStarted: true,
      sandboxName,
    });
    const receipt = { cleanup: { retainedSandboxName }, verdict: "fail" };
    const failure = createWindowsMxcQualificationFailure({
      failures: [new Error("injected sandbox delete failure")],
      openClawProcessStopped: true,
      receiptPath: "C:\\evidence\\receipt.json",
      retainedSandboxName,
      sandboxDeleteRetried: true,
    });

    expect(receipt.cleanup.retainedSandboxName).toBe(sandboxName);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.message).toContain(`retained sandbox=${sandboxName}`);
    expect(
      retainedWindowsMxcSandboxName({
        registryRemovedAfterDelete: true,
        sandboxCreateStarted: true,
        sandboxName,
      }),
    ).toBeNull();
  });

  it("requires exact identities and keeps the OpenClaw launch files under one artifact root (#8178)", () => {
    const { environment } = fixture();
    const parsed = parseWindowsMxcOpenClawQualificationEnvironment(environment);

    expect(parsed.openClaw.version).toBe("2026.7.1");
    expect(parsed.openShell.packageVersion).toBe("0.0.12");
    expect(parsed.expected.openShellDistributionSha256).toBe(
      environment.NEMOCLAW_WINDOWS_MXC_OPENSHELL_DISTRIBUTION_SHA256,
    );
    expect(parsed.expected.openClawArtifactTreeSha256).toBe(
      environment.NEMOCLAW_WINDOWS_MXC_OPENCLAW_ARTIFACT_TREE_SHA256,
    );
    expect(parsed.expected.wxcExecSha256).toBe(environment.NEMOCLAW_WINDOWS_MXC_WXC_EXEC_SHA256);
    expect(parsed.declaredHostPreparation).toBe("wxc-host-prep-prepare-system-drive");
  });

  it("projects exact separate OpenShell and MXC roots into attachment observation input (#8178)", () => {
    const { environment, root } = fixture();
    const gatewayConfigPath = path.join(root, "gateway.toml");
    fs.writeFileSync(gatewayConfigPath, "[gateway]\n", "utf8");
    const parsed = parseWindowsMxcOpenClawQualificationEnvironment(environment);

    expect(
      createWindowsMxcOpenShellAttachmentObservationRequest(parsed, gatewayConfigPath),
    ).toEqual({
      contractVersion: 2,
      providerId: "mxc",
      mode: "attach-existing",
      observedDistribution: {
        version: "0.0.12",
        revision: "b".repeat(40),
      },
      observedGateway: { driver: "mxc", backend: "process_container" },
      installation: {
        distributionArtifactPath: parsed.openShell.distributionArtifactPath,
        distributionRoot: parsed.openShell.distributionRoot,
        mxcRoot: parsed.mxc.root,
        cliPath: parsed.openShell.cliPath,
        gatewayPath: parsed.openShell.gatewayPath,
        wxcExecPath: parsed.mxc.wxcExecPath,
        gatewayConfigPath: fs.realpathSync(gatewayConfigPath),
      },
    });
  });

  it("rejects OpenShell and MXC executables outside their declared roots (#8178)", () => {
    const { environment, root } = fixture();
    const outsideCli = path.join(root, "outside-openshell.exe");
    fs.writeFileSync(outsideCli, "cli", "utf8");
    environment.NEMOCLAW_WINDOWS_MXC_OPENSHELL_CLI = outsideCli;

    expect(() => parseWindowsMxcOpenClawQualificationEnvironment(environment)).toThrow(
      /OpenShell CLI must be a child of the OpenShell distribution root/u,
    );

    const second = fixture();
    const outsideWxc = path.join(second.root, "outside-wxc-exec.exe");
    fs.writeFileSync(outsideWxc, "wxc", "utf8");
    second.environment.NEMOCLAW_WINDOWS_MXC_WXC_EXEC = outsideWxc;

    expect(() => parseWindowsMxcOpenClawQualificationEnvironment(second.environment)).toThrow(
      /wxc-exec must be a child of the MXC root/u,
    );
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

  it("rejects a nested OpenClaw artifact root before qualification (#8178)", () => {
    const { environment, root } = fixture();
    const openClawRoot = path.join(root, "openclaw");
    const nestedRoot = path.join(root, "nested", "openclaw");
    fs.mkdirSync(path.dirname(nestedRoot), { recursive: true });
    fs.renameSync(openClawRoot, nestedRoot);
    environment.NEMOCLAW_WINDOWS_MXC_OPENCLAW_ROOT = nestedRoot;
    environment.NEMOCLAW_WINDOWS_MXC_NODE = path.join(nestedRoot, "node", "node.exe");
    environment.NEMOCLAW_WINDOWS_MXC_OPENCLAW_ENTRY = path.join(
      nestedRoot,
      "runtime",
      "openclaw.mjs",
    );

    expect(() => parseWindowsMxcOpenClawQualificationEnvironment(environment)).toThrow(
      /artifact root must be a direct child of the qualification work root/u,
    );
  });

  it("rejects an OpenClaw artifact root that is the work root parent (#8178)", () => {
    const { environment, root } = fixture();
    const openClawRoot = path.join(root, "openclaw");
    const workRoot = path.join(openClawRoot, "work");
    fs.mkdirSync(workRoot);
    environment.NEMOCLAW_WINDOWS_MXC_WORK_ROOT = workRoot;

    expect(() => parseWindowsMxcOpenClawQualificationEnvironment(environment)).toThrow(
      /artifact root must be a direct child of the qualification work root/u,
    );
  });

  it("rejects a nested Windows qualification work root during parsing (#8178)", () => {
    const { environment } = fixture();

    withProcessPlatform("win32", () => {
      expect(() => parseWindowsMxcOpenClawQualificationEnvironment(environment)).toThrow(
        /work root must be a drive root/u,
      );
    });
  });

  it("rejects moving aliases instead of exact digest and revision identities (#8178)", () => {
    const { environment } = fixture();
    environment.NEMOCLAW_WINDOWS_MXC_OPENSHELL_REVISION = "main";
    environment.NEMOCLAW_WINDOWS_MXC_WXC_EXEC_SHA256 = "latest";

    expect(() => parseWindowsMxcOpenClawQualificationEnvironment(environment)).toThrow(
      /unsupported format/u,
    );
  });

  it("rejects an unrecognized host-preparation declaration (#8178)", () => {
    const { environment } = fixture();
    environment.NEMOCLAW_WINDOWS_MXC_HOST_PREPARATION = "manual-acl-change";

    expect(() => parseWindowsMxcOpenClawQualificationEnvironment(environment)).toThrow(
      /HOST_PREPARATION has an unsupported value/u,
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

  it("rejects substitution of the original OpenShell distribution artifact (#8178)", () => {
    const { environment } = fixture();
    const parsed = parseWindowsMxcOpenClawQualificationEnvironment(environment);
    assertExactArtifactIdentities(parsed);

    fs.writeFileSync(parsed.openShell.distributionArtifactPath, "replacement", "utf8");

    expect(() => assertExactArtifactIdentities(parsed)).toThrow(
      /openShellDistributionSha256 does not match the expected exact identity/u,
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
    expect(normalizeReportedVersion("OpenClaw 2026.7.1 (2d2ddc4)\n")).toBe("2026.7.1");
    expect(
      normalizeReportedVersion("OpenClaw 2026.7.1 (0123456789abcdef0123456789abcdef01234567)\n"),
    ).toBe("2026.7.1");
    expect(normalizeReportedVersion("OpenClaw 2026.7.1 (2d2ddc)\n")).toBeNull();
    expect(
      normalizeReportedVersion("OpenClaw 2026.7.1 (0123456789abcdef0123456789abcdef012345678)\n"),
    ).toBeNull();
    expect(normalizeReportedVersion("OpenClaw 2026.7.1 (2d2ddcZ)\n")).toBeNull();
    expect(normalizeReportedVersion("2026.7.10\n")).toBe("2026.7.10");
    expect(normalizeReportedVersion("OpenClaw 2026.7.1 (local)\n")).toBeNull();
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

  it("requires the exact OpenShell forward command and loopback ports (#8178)", () => {
    const identity = {
      commandLine:
        '"C:\\package\\openshell.exe" forward service mxc-oc-123 --target-port 18889 --local 127.0.0.1:18790',
      creationDate: "20260804180000.000000-420",
      executablePath: "C:\\package\\openshell.exe",
      parentProcessId: 40,
      processId: 41,
    };
    expect(() =>
      assertExpectedOpenShellForwardProcessIdentity(identity, {
        cliPath: "C:\\package\\openshell.exe",
        localPort: 18790,
        sandboxName: "mxc-oc-123",
        targetPort: 18889,
      }),
    ).not.toThrow();
    expect(() =>
      assertExpectedOpenShellForwardProcessIdentity(
        { ...identity, commandLine: identity.commandLine.replace("mxc-oc-123", "other") },
        {
          cliPath: "C:\\package\\openshell.exe",
          localPort: 18790,
          sandboxName: "mxc-oc-123",
          targetPort: 18889,
        },
      ),
    ).toThrow(/forward process identity/u);
  });

  it("renders the exact inactive relay configuration without credential values (#8178)", () => {
    const config = renderWindowsMxcGatewayConfig({
      agentPath: "C:\\artifact\\node.exe",
      relayPath: "C:\\probe\\share\\openshell-supervisor-relay.exe",
      shareDirectory: "C:\\probe\\share",
      targetPort: 18889,
      wxcExecPath: "C:\\package\\wxc-exec.exe",
    });

    expect(config).toContain('backend = "process_container"');
    expect(config).toContain("pc_least_privilege = false");
    expect(config).toContain('pc_capabilities = ["privateNetworkClientServer"]');
    expect(config).toContain("egress_proxy = true");
    expect(config).toContain('egress_proxy_addr = "127.0.0.1:18080"');
    expect(config).toContain(
      'pc_relay_spawner_path = "C:/probe/share/openshell-supervisor-relay.exe"',
    );
    expect(config).toContain("pc_relay_target_port = 18889");
    expect(config).toContain('"NEMOCLAW_MXC_E2E_TOKEN"');
    expect(config).toContain('"TEMP=C:/probe/share/temp"');
    expect(config).toContain('"TMP=C:/probe/share/temp"');
    expect(config).not.toMatch(/^\s*"TEMP",$/mu);
    expect(config).not.toMatch(/^\s*"TMP",$/mu);
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
    expect(agent).toContain('required("NEMOCLAW_MXC_E2E_MOCK_PORT")');
    expect(agent).toContain('body?.model !== "mock-chat"');
    expect(agent).toContain('message.role === "user"');
    expect(agent).toContain("if (gateway.pid !== undefined)");
    expect(agent).toContain('gateway.once("error"');
    expect(agent).toContain("writeFileSync(outcomePath");
    expect(agent).toContain('"gateway",\n    "health"');
    expect(agent).not.toContain('"--token"');
    expect(agent).not.toMatch(/[A-Za-z0-9_-]{40,}/u);
  });

  it("serializes a generated probe spawn failure without raw diagnostics (#8178)", async () => {
    const { root } = fixture();
    const agentPath = path.join(root, "probe-agent.mjs");
    const home = path.join(root, "probe-home");
    const resultPath = path.join(root, "probe-result.json");
    const outcomePath = path.join(root, "probe-outcome.json");
    const token = "runtime-only-secret";
    const missingNodePath = path.join(root, "missing-node.exe");
    fs.writeFileSync(agentPath, renderWindowsMxcOpenClawProbeAgent(), "utf8");

    const executed = spawnSync(process.execPath, [agentPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        NEMOCLAW_MXC_E2E_DENY_PATH: path.join(root, "missing-parent", "denied.txt"),
        NEMOCLAW_MXC_E2E_ENTRY: path.join(root, "missing-openclaw.mjs"),
        NEMOCLAW_MXC_E2E_HEARTBEAT_PATH: path.join(root, "heartbeat.txt"),
        NEMOCLAW_MXC_E2E_HOME: home,
        NEMOCLAW_MXC_E2E_MOCK_PORT: "0",
        NEMOCLAW_MXC_E2E_NODE: missingNodePath,
        NEMOCLAW_MXC_E2E_OPENCLAW_PID_PATH: path.join(root, "openclaw.pid"),
        NEMOCLAW_MXC_E2E_OPENCLAW_PORT: "0",
        NEMOCLAW_MXC_E2E_OUTCOME_PATH: outcomePath,
        NEMOCLAW_MXC_E2E_READY_PATH: path.join(root, "ready.json"),
        NEMOCLAW_MXC_E2E_RESULT_PATH: resultPath,
        NEMOCLAW_MXC_E2E_STOP_PATH: path.join(root, "stop.txt"),
        NEMOCLAW_MXC_E2E_TOKEN: token,
      },
      timeout: 15_000,
      windowsHide: true,
    });

    expect(executed.status, executed.stderr).toBe(1);
    const resultText = fs.readFileSync(resultPath, "utf8");
    const outcomeText = fs.readFileSync(outcomePath, "utf8");
    const result = JSON.parse(resultText) as Record<string, unknown>;
    expect(result).toMatchObject({
      gatewaySpawnFailed: true,
      healthObserved: false,
      versionExitCode: 1,
    });
    expect(result).not.toHaveProperty("gatewaySpawnError");
    expect(Number.isSafeInteger(result.gatewayExitCode)).toBe(true);
    expect(classifyWindowsMxcOpenClawStartupObservation(result)).toEqual({
      outcome: "spawn-failed",
      gatewayExitCode: result.gatewayExitCode,
      versionExitCode: 1,
    });
    expect(outcomeText).toBe(resultText);
    expect(resultText).not.toContain(missingNodePath);
    expect(resultText).not.toContain(token);
  });

  it.each([
    {
      expected: { outcome: "ready", gatewayExitCode: null, versionExitCode: 0 },
      result: { healthObserved: true, versionExitCode: 0 },
    },
    {
      expected: { outcome: "spawn-failed", gatewayExitCode: null, versionExitCode: 0 },
      result: { gatewaySpawnFailed: true, versionExitCode: 0 },
    },
    {
      expected: {
        outcome: "exited-before-readiness",
        gatewayExitCode: 3221225794,
        versionExitCode: 0,
      },
      result: {
        gatewayExitCode: 3221225794,
        gatewayExitedBeforeReadiness: true,
        versionExitCode: 0,
      },
    },
    {
      expected: { outcome: "health-timeout", gatewayExitCode: null, versionExitCode: null },
      result: { healthObserved: false },
    },
    {
      expected: { outcome: "not-observed", gatewayExitCode: null, versionExitCode: null },
      result: {
        gatewayExitCode: "C:\\sensitive\\path",
        gatewaySpawnError: "token-bearing raw diagnostic",
        versionExitCode: 1.5,
      },
    },
  ])(
    "classifies bounded secret-free startup evidence for $expected.outcome (#8178)",
    ({ expected, result }) => {
      const observation = classifyWindowsMxcOpenClawStartupObservation(result);

      expect(observation).toEqual(expected);
      expect(JSON.stringify(observation)).not.toContain("sensitive");
      expect(JSON.stringify(observation)).not.toContain("token-bearing");
    },
  );

  it("accepts only authenticated health and one exact chat payload (#8178)", () => {
    expect(parseOpenClawHealthResult('notice\n{"ok":true}\n')).toBe(true);
    expect(parseOpenClawHealthResult('{"ok":false}')).toBe(false);
    expect(
      parseOpenClawExactChatReply(
        JSON.stringify({ status: "ok", result: { payloads: [{ text: "CHAT_OK" }] } }),
      ),
    ).toBe(true);
    expect(
      parseOpenClawExactChatReply(
        JSON.stringify({
          status: "ok",
          result: { payloads: [{ text: "CHAT_OK" }, { text: "extra" }] },
        }),
      ),
    ).toBe(false);
    expect(
      parseOpenClawExactChatReply(
        JSON.stringify({ status: "ok", result: { payloads: [{ text: "not exact" }] } }),
      ),
    ).toBe(false);
  });

  it("observes forwarded health again only after the exact relay readiness signal (#8178)", async () => {
    const results = [
      {
        exitCode: 1,
        stderr: "",
        stdout: JSON.stringify({
          ok: false,
          error: {
            type: "gateway_transport_error",
            kind: "closed",
            code: 1006,
            reason: "no close reason",
          },
        }),
      },
      { exitCode: 0, stderr: "", stdout: JSON.stringify({ ok: true }) },
    ];
    const delays: number[] = [];

    const observed = await observeWindowsMxcForwardHealthReadiness({
      attempts: 3,
      delayMs: 25,
      probe: async (attempt) => results[attempt - 1]!,
      sleep: async (delay) => {
        delays.push(delay);
      },
    });

    expect(observed.evidence).toEqual({
      schemaVersion: 1,
      operation: "windows-mxc-forward-authenticated-health",
      maxAttempts: 3,
      delayMs: 25,
      attempts: [
        { attempt: 1, outcome: "relay-not-ready" },
        { attempt: 2, outcome: "ready" },
      ],
      outcome: "ready",
    });
    expect(delays).toEqual([25]);
  });

  it.each([
    {
      scenario: "authentication failure",
      result: {
        exitCode: 1,
        stderr: "",
        stdout: JSON.stringify({
          ok: false,
          error: { type: "gateway_auth_error", message: "unauthorized" },
        }),
      },
    },
    {
      scenario: "transport timeout",
      result: {
        exitCode: 1,
        stderr: "",
        stdout: JSON.stringify({
          ok: false,
          error: {
            type: "gateway_transport_error",
            kind: "timeout",
            timeoutMs: 10_000,
          },
        }),
      },
    },
    {
      scenario: "different close reason",
      result: {
        exitCode: 1,
        stderr: "",
        stdout: JSON.stringify({
          ok: false,
          error: {
            type: "gateway_transport_error",
            kind: "closed",
            code: 1006,
            reason: "policy denied",
          },
        }),
      },
    },
    {
      scenario: "malformed output",
      result: { exitCode: 1, stderr: "", stdout: "not json" },
    },
  ])("does not observe forwarded health again after $scenario (#8178)", async ({ result }) => {
    let probes = 0;
    const observed = await observeWindowsMxcForwardHealthReadiness({
      attempts: 3,
      delayMs: 0,
      probe: async () => {
        probes += 1;
        return result;
      },
    });

    expect(classifyWindowsMxcForwardHealthObservation(result)).toBe("terminal");
    expect(observed.evidence.outcome).toBe("terminal");
    expect(observed.evidence.attempts).toEqual([{ attempt: 1, outcome: "terminal" }]);
    expect(probes).toBe(1);
  });

  it("fails forwarded health after the bounded relay readiness observations (#8178)", async () => {
    const relayNotReady = {
      exitCode: 1,
      stderr: "",
      stdout: JSON.stringify({
        ok: false,
        error: {
          type: "gateway_transport_error",
          kind: "closed",
          code: 1006,
          reason: "no close reason",
        },
      }),
    };

    const observed = await observeWindowsMxcForwardHealthReadiness({
      attempts: 2,
      delayMs: 0,
      probe: async () => relayNotReady,
    });

    expect(observed.evidence.outcome).toBe("exhausted");
    expect(observed.evidence.attempts).toEqual([
      { attempt: 1, outcome: "relay-not-ready" },
      { attempt: 2, outcome: "relay-not-ready" },
    ]);
  });

  it("stops forwarded health observations after the owned forward exits (#8178)", async () => {
    let probes = 0;
    const observed = await observeWindowsMxcForwardHealthReadiness({
      attempts: 3,
      delayMs: 0,
      forwardActive: () => false,
      probe: async () => {
        probes += 1;
        return { exitCode: 0, stderr: "", stdout: JSON.stringify({ ok: true }) };
      },
    });

    expect(observed.evidence.outcome).toBe("terminal");
    expect(observed.evidence.attempts).toEqual([{ attempt: 1, outcome: "terminal" }]);
    expect(probes).toBe(0);
  });

  it("does not probe again when the owned forward exits during the retry delay (#8178)", async () => {
    let forwardActive = true;
    let probes = 0;
    const observed = await observeWindowsMxcForwardHealthReadiness({
      attempts: 3,
      delayMs: 25,
      forwardActive: () => forwardActive,
      probe: async () => {
        probes += 1;
        return {
          exitCode: 1,
          stderr: "",
          stdout: JSON.stringify({
            ok: false,
            error: {
              type: "gateway_transport_error",
              kind: "closed",
              code: 1006,
              reason: "no close reason",
            },
          }),
        };
      },
      sleep: async () => {
        forwardActive = false;
      },
    });

    expect(observed.evidence.outcome).toBe("terminal");
    expect(observed.evidence.attempts).toEqual([
      { attempt: 1, outcome: "relay-not-ready" },
      { attempt: 2, outcome: "terminal" },
    ]);
    expect(probes).toBe(1);
  });

  it("rejects healthy output when the owned forward exits during the probe (#8178)", async () => {
    let forwardActive = true;
    const observed = await observeWindowsMxcForwardHealthReadiness({
      attempts: 3,
      delayMs: 0,
      forwardActive: () => forwardActive,
      probe: async () => {
        forwardActive = false;
        return { exitCode: 0, stderr: "", stdout: JSON.stringify({ ok: true }) };
      },
    });

    expect(observed.evidence.outcome).toBe("terminal");
    expect(observed.evidence.attempts).toEqual([{ attempt: 1, outcome: "terminal" }]);
  });

  it.each([
    "filesystemControlWrite",
    "filesystemDeniedWrite",
    "openClawHealth",
    "openClawProcessPresentWhileReady",
    "registryPresentWhileReady",
  ] as const)("does not start forwarding when %s fails (#8178)", (failedCheck) => {
    const checks = {
      filesystemControlWrite: true,
      filesystemDeniedWrite: true,
      openClawHealth: true,
      openClawProcessPresentWhileReady: true,
      registryPresentWhileReady: true,
      versionExitCode: 0,
    };
    checks[failedCheck] = false;

    expect(windowsMxcOpenClawStartupPreconditionsPass(checks)).toBe(false);
  });

  it("allows forwarding after all OpenClaw startup preconditions pass (#8178)", () => {
    expect(
      windowsMxcOpenClawStartupPreconditionsPass({
        filesystemControlWrite: true,
        filesystemDeniedWrite: true,
        openClawHealth: true,
        openClawProcessPresentWhileReady: true,
        registryPresentWhileReady: true,
        versionExitCode: 0,
      }),
    ).toBe(true);
  });

  it("rejects readiness when the OpenClaw version command fails (#8178)", () => {
    expect(
      windowsMxcOpenClawStartupPreconditionsPass({
        filesystemControlWrite: true,
        filesystemDeniedWrite: true,
        openClawHealth: true,
        openClawProcessPresentWhileReady: true,
        registryPresentWhileReady: true,
        versionExitCode: 1,
      }),
    ).toBe(false);
  });

  it.each([" CHAT_OK", "CHAT_OK ", "CHAT_OK\n", "\tCHAT_OK"])(
    "rejects a non-exact OpenClaw chat reply %j (#8178)",
    (text) => {
      expect(
        parseOpenClawExactChatReply(
          JSON.stringify({ status: "ok", result: { payloads: [{ text }] } }),
        ),
      ).toBe(false);
    },
  );

  it("passes only allowlisted Windows runtime variables to host child processes (#8178)", () => {
    const allowed = allowlistedWindowsProcessEnvironment({
      AWS_SECRET_ACCESS_KEY: "secret",
      Path: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      UNRELATED_CREDENTIAL: "secret",
    });

    expect(allowed).toEqual({ Path: "C:\\Windows\\System32", SystemRoot: "C:\\Windows" });
  });

  it("does not override the gateway selected in the isolated CLI state (#8178)", () => {
    expect(
      withoutOpenShellGatewaySelection({
        OpenShell_Gateway: "unexpected-gateway",
        OPENSHELL_GATEWAY_CONFIG: "C:\\probe\\gateway.toml",
      }),
    ).toEqual({ OPENSHELL_GATEWAY_CONFIG: "C:\\probe\\gateway.toml" });
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
