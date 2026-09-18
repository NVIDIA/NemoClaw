// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256WindowsOpenClawArtifactTree } from "../../../tools/e2e/windows-mxc-openclaw-artifact-tree.mts";
import {
  allowlistedWindowsProcessEnvironment,
  assertCleanCheckoutIdentity,
  assertExactArtifactIdentities,
  buildWindowsMxcSetupFailureReceipt,
  classifyWindowsMxcOpenClawStartupObservation,
  classifyWindowsMxcForwardHealthObservation,
  copyWindowsMxcOpenClawArchiveWithSha256,
  createWindowsMxcOpenShellAttachmentObservationRequest,
  createWindowsMxcQualificationFailure,
  normalizeReportedVersion,
  observeWindowsNativeArchitecture,
  observeWindowsMxcForwardHealthReadiness,
  parseWindowsMxcOpenClawQualificationEnvironment,
  parseWindowsMxcInteractiveHostContext,
  parseOpenClawExactChatReply,
  parseOpenClawHealthResult,
  parseWindowsProcessQueryResult,
  renderWindowsMxcFilesystemPolicy,
  createWindowsMxcGatewayConfiguration,
  renderWindowsMxcOpenClawCompatibilityPreload,
  renderWindowsMxcOpenClawProbeAgent,
  removeWindowsMxcRuntimeArtifacts,
  retainedWindowsMxcSandboxName,
  runWindowsMxcForwardCleanup,
  sanitizeWindowsMxcOpenClawGatewayOutput,
  readWindowsMxcOpenClawGatewayOutput,
  stageWindowsMxcOpenClawArtifact,
  sha256File,
  withWindowsMxcLocalSetupOwnership,
  windowsMxcAppContainerAclArguments,
  windowsMxcAppContainerReadOnlyAclArguments,
  windowsMxcOpenClawStartupPreconditionsPass,
  withoutOpenShellGatewaySelection,
} from "../live/windows-mxc-openclaw-process-container-helpers.ts";

const roots: string[] = [];

function fixture(): {
  readonly environment: NodeJS.ProcessEnv;
  readonly root: string;
} {
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
    openClawArchive: path.join(distributionDirectory, "openclaw-2026.7.1-windows.zip"),
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
      NEMOCLAW_WINDOWS_MXC_OPENCLAW_ARCHIVE: paths.openClawArchive,
      NEMOCLAW_WINDOWS_MXC_OPENCLAW_ARCHIVE_SHA256: sha256File(paths.openClawArchive),
      NEMOCLAW_WINDOWS_MXC_OPENCLAW_ENTRY: paths.entry,
      NEMOCLAW_WINDOWS_MXC_OPENCLAW_ENTRY_SHA256: sha256File(paths.entry),
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

function withProcessPlatform<T>(platform: NodeJS.Platform, operation: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return operation();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

function parseFixtureEnvironment(environment: NodeJS.ProcessEnv) {
  return withProcessPlatform("linux", () =>
    parseWindowsMxcOpenClawQualificationEnvironment(environment),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("inactive Windows MXC OpenClaw process_container qualification", () => {
  it.each([undefined, "1"])(
    "records authoritative schema 10 receipts with retired diagnostic option=%s (#8178)",
    (diagnosticOption) => {
      const { environment } = fixture();
      environment.NEMOCLAW_WINDOWS_MXC_ALLOW_NAME_DELETE_DIAGNOSTIC = diagnosticOption;
      const inputs = parseFixtureEnvironment(environment);

      const context = {
        processElevated: false,
        processSessionId: 19,
        processUserInteractive: true,
      };
      const receipt = buildWindowsMxcSetupFailureReceipt(inputs, context, true);

      expect(receipt.schemaVersion).toBe(10);
      expect(receipt.configuration.artifactStaging).toBe("pinned-archive-read-only-reused");
      expect(receipt.identities.host).toMatchObject(context);
      expect(receipt.qualificationMode).toBe("authoritative");
      expect(inputs).not.toHaveProperty("allowDiagnosticNameDeletion");
    },
  );

  it.each([true, false])(
    "accepts an interactive session independently of elevation=%s (#8178)",
    (processElevated) => {
      const context = { processElevated, processSessionId: 19, processUserInteractive: true };
      expect(
        parseWindowsMxcInteractiveHostContext({
          exitCode: 0,
          stdout: JSON.stringify({ ...context, unrelated: "private-value" }),
          stderr: "",
        }),
      ).toEqual(context);
    },
  );

  it.each([
    { processElevated: true, processSessionId: 0, processUserInteractive: false },
    { processElevated: false, processSessionId: 0, processUserInteractive: true },
    { processElevated: true, processSessionId: 19, processUserInteractive: false },
  ])(
    "rejects session $processSessionId with interactive=$processUserInteractive before qualification (#8178)",
    (context) => {
      expect(() =>
        parseWindowsMxcInteractiveHostContext({
          exitCode: 0,
          stdout: JSON.stringify(context),
          stderr: "",
        }),
      ).toThrow("requires a logged-in interactive Windows session");
    },
  );

  it.each([
    null,
    [],
    true,
    false,
    0,
    19,
    "private-value",
    {},
    { processElevated: true, processSessionId: "19", processUserInteractive: true },
    { processElevated: true, processSessionId: -1, processUserInteractive: true },
    { processElevated: true, processSessionId: 1.5, processUserInteractive: true },
    { processElevated: true, processSessionId: 0x100000000, processUserInteractive: true },
    { processSessionId: 19, processUserInteractive: true },
    { processElevated: true, processSessionId: 19 },
  ])("rejects incomplete or malformed launch-context evidence %j (#8178)", (context) => {
    expect(() =>
      parseWindowsMxcInteractiveHostContext({
        exitCode: 0,
        stdout: JSON.stringify(context),
        stderr: "",
      }),
    ).toThrow("Windows host launch-context output is invalid");
  });

  it("rejects failed queries and invalid JSON without exposing raw diagnostics (#8178)", () => {
    expect(() =>
      parseWindowsMxcInteractiveHostContext({
        exitCode: 1,
        stdout: "private-value",
        stderr: "private-value",
      }),
    ).toThrow(/^Windows host launch-context query failed$/u);
    expect(() =>
      parseWindowsMxcInteractiveHostContext({
        exitCode: 0,
        stdout: "private-value",
        stderr: "private-value",
      }),
    ).toThrow(/^Windows host launch-context output is invalid$/u);
  });

  it("removes credential values from preserved startup diagnostics (#8178)", () => {
    const { root } = fixture();
    const log = path.join(root, "gateway.log");
    const token = "runtime-only-secret";
    fs.writeFileSync(
      log,
      `token=${token}\nAuthorization: ${token}\napi_key='also-sensitive'\nstatus=failed`,
    );
    const sanitized = readWindowsMxcOpenClawGatewayOutput(log, token);

    expect(sanitized).toBe(
      "token=[redacted]\nAuthorization: [redacted]\napi_key=[redacted]\nstatus=failed",
    );
    expect(sanitized).not.toContain(token);
    expect(() => sanitizeWindowsMxcOpenClawGatewayOutput("text", "")).toThrow(
      "gateway token is required",
    );
  });

  it("skips missing diagnostics but preserves empty logs and read failures (#8178)", () => {
    const { root } = fixture();
    const log = path.join(root, "gateway.log");
    expect(readWindowsMxcOpenClawGatewayOutput(log, "test-token")).toBeNull();
    fs.writeFileSync(log, "");
    expect(readWindowsMxcOpenClawGatewayOutput(log, "test-token")).toBe("");
    const denied = Object.assign(new Error("read denied"), { code: "EACCES" });
    vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
      throw denied;
    });
    expect(() => readWindowsMxcOpenClawGatewayOutput(log, "test-token")).toThrow(denied);
  });

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
      providerRecoveryAttempted: true,
      receiptPath: "C:\\evidence\\receipt.json",
      retainedSandboxName,
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
    const parsed = parseFixtureEnvironment(environment);

    expect(parsed.openClaw.version).toBe("2026.7.1");
    expect(parsed.openShell.packageVersion).toBe("0.0.12");
    expect(parsed.expected.openShellDistributionSha256).toBe(
      environment.NEMOCLAW_WINDOWS_MXC_OPENSHELL_DISTRIBUTION_SHA256,
    );
    expect(parsed.expected.openClawArchiveSha256).toBe(
      environment.NEMOCLAW_WINDOWS_MXC_OPENCLAW_ARCHIVE_SHA256,
    );
    expect(parsed.expected.wxcExecSha256).toBe(environment.NEMOCLAW_WINDOWS_MXC_WXC_EXEC_SHA256);
    expect(parsed.declaredHostPreparation).toBe("wxc-host-prep-prepare-system-drive");
  });

  it("accepts an exact OpenShell version with SemVer build metadata (#10585)", () => {
    const { environment } = fixture();
    environment.NEMOCLAW_WINDOWS_MXC_OPENSHELL_VERSION = "0.0.59-dev.837+g0e92923f5";

    expect(parseFixtureEnvironment(environment).openShell.packageVersion).toBe(
      "0.0.59-dev.837+g0e92923f5",
    );
  });

  it("records a pre-existing compatible system-drive ACL without claiming host prep ran (#10585)", () => {
    const { environment } = fixture();
    environment.NEMOCLAW_WINDOWS_MXC_HOST_PREPARATION = "preexisting-compatible-system-drive-acl";

    expect(parseFixtureEnvironment(environment).declaredHostPreparation).toBe(
      "preexisting-compatible-system-drive-acl",
    );
  });

  it("projects exact separate OpenShell and MXC roots into attachment observation input (#8178)", () => {
    const { environment, root } = fixture();
    const gatewayConfigPath = path.join(root, "gateway.toml");
    fs.writeFileSync(gatewayConfigPath, "[gateway]\n", "utf8");
    const parsed = parseFixtureEnvironment(environment);

    expect(
      createWindowsMxcOpenShellAttachmentObservationRequest(parsed, gatewayConfigPath),
    ).toEqual({
      contractVersion: 3,
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

    expect(() => parseFixtureEnvironment(environment)).toThrow(
      /OpenShell CLI must be a child of the OpenShell distribution root/u,
    );

    const second = fixture();
    const outsideWxc = path.join(second.root, "outside-wxc-exec.exe");
    fs.writeFileSync(outsideWxc, "wxc", "utf8");
    second.environment.NEMOCLAW_WINDOWS_MXC_WXC_EXEC = outsideWxc;

    expect(() => parseFixtureEnvironment(second.environment)).toThrow(
      /wxc-exec must be a child of the MXC root/u,
    );
  });

  it("rejects an OpenClaw executable outside the staged artifact root (#8178)", () => {
    const { environment, root } = fixture();
    const outside = path.join(root, "outside-node.exe");
    fs.writeFileSync(outside, "node", "utf8");
    environment.NEMOCLAW_WINDOWS_MXC_NODE = outside;
    environment.NEMOCLAW_WINDOWS_MXC_NODE_SHA256 = sha256File(outside);

    expect(() => parseFixtureEnvironment(environment)).toThrow(
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

    expect(() => parseFixtureEnvironment(environment)).toThrow(
      /artifact root must be a direct child of the qualification work root/u,
    );
  });

  it("rejects an OpenClaw artifact root that is the work root parent (#8178)", () => {
    const { environment, root } = fixture();
    const openClawRoot = path.join(root, "openclaw");
    const workRoot = path.join(openClawRoot, "work");
    fs.mkdirSync(workRoot);
    environment.NEMOCLAW_WINDOWS_MXC_WORK_ROOT = workRoot;

    expect(() => parseFixtureEnvironment(environment)).toThrow(
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

    expect(() => parseFixtureEnvironment(environment)).toThrow(/unsupported format/u);
  });

  it("rejects an unrecognized host-preparation declaration (#8178)", () => {
    const { environment } = fixture();
    environment.NEMOCLAW_WINDOWS_MXC_HOST_PREPARATION = "manual-acl-change";

    expect(() => parseFixtureEnvironment(environment)).toThrow(
      /HOST_PREPARATION has an unsupported value/u,
    );
  });

  it("rejects an artifact replaced after its initial identity check (#8178)", () => {
    const { environment } = fixture();
    const parsed = parseFixtureEnvironment(environment);
    assertExactArtifactIdentities(parsed);

    fs.writeFileSync(parsed.openShell.cliPath, "replacement", "utf8");

    expect(() => assertExactArtifactIdentities(parsed)).toThrow(
      /openShellCliSha256 does not match the expected exact identity/u,
    );
  });

  it("rejects substitution of the original OpenShell distribution artifact (#8178)", () => {
    const { environment } = fixture();
    const parsed = parseFixtureEnvironment(environment);
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

  it("selects the combined upstream package for the live relay configuration without credentials (#8178)", () => {
    const input = {
      distributionRevision: "acd2a57219811b21bafa0a15938041c1b6f8bcc5",
      distributionVersion: "0.0.117-dev.154+gacd2a5721",
      egressProxyPort: 18080,
      relayPath: "C:\\probe\\share\\openshell-supervisor-relay.exe",
      shareDirectory: "C:\\probe\\share",
      targetPort: 18889,
      wxcExecPath: "C:\\package\\wxc-exec.exe",
    };
    const { content: config, distributionAuthority } = createWindowsMxcGatewayConfiguration(input);
    expect(config).toMatch(/^\[openshell\]\nversion = 2\n/u);
    expect(distributionAuthority).toMatchObject({
      profileId: "openshell-windows-tip-acd2a572-mxc-v0-8-0-qualification",
      acceptance: "qualification",
      nativeArchitecture: "arm64",
    });
    expect(() =>
      createWindowsMxcGatewayConfiguration({
        ...input,
        distributionRevision: "0c1e7ba92dde5e3a30c57e5e3729e182d67492de",
        distributionVersion: "0.0.59-dev.909+g0c1e7ba92",
      }),
    ).toThrow(/does not match the provider-owned profile/u);

    expect(config).toContain('backend = "process_container"');
    expect(config).toContain("pc_least_privilege = false");
    expect(config).toContain('pc_capabilities = ["privateNetworkClientServer"]');
    expect(config).not.toContain("pc_allow_local_network");
    expect(config).not.toContain("pc_network_allow");
    expect(config).toContain("egress_proxy = true");
    expect(config).toContain('egress_proxy_addr = "127.0.0.1:18080"');
    expect(config).toContain(
      'pc_relay_spawner_path = "C:/probe/share/openshell-supervisor-relay.exe"',
    );
    expect(config).toContain("pc_relay_target_port = 18889");
    expect(config).not.toContain("agent_command");
    expect(config).not.toContain("agent_cwd");
    expect(config).not.toContain("agent_env");
    expect(config).not.toContain("share_dir");
    expect(config).not.toContain("credential-value");
    expect(config).not.toContain("--token");
  });

  it("grants the required filesystem and restricted UI policy for OpenClaw (#8178)", () => {
    const policy = renderWindowsMxcFilesystemPolicy({
      openClawRoot: "C:\\artifact",
      shareDirectory: "C:\\probe\\share",
    });

    expect(policy).toContain('read_only:\n    - "C:/artifact"');
    expect(policy).toContain('read_write:\n    - "C:/probe/share"');
    expect(policy).toContain("include_workdir: false");
    expect(policy).toContain("ui:\n  allow_graphical_ui: true");
    expect(policy).toContain("clipboard: none");
    expect(policy).toContain("allow_input_injection: false");
  });

  it("keeps the ephemeral readiness token out of OpenClaw arguments and source literals (#8178)", () => {
    const agent = renderWindowsMxcOpenClawProbeAgent();

    expect(agent).toContain('required("NEMOCLAW_MXC_E2E_TOKEN")');
    expect(agent).toContain('required("NEMOCLAW_MXC_E2E_COMPAT_PRELOAD")');
    expect(agent).toContain('"--import"');
    expect(agent).toContain('required("NEMOCLAW_MXC_E2E_MOCK_PORT")');
    expect(agent).toContain('body?.model !== "mock-chat"');
    expect(agent).toContain('message.role === "user"');
    expect(agent).toContain("if (gateway.pid !== undefined)");
    expect(agent).toContain('gateway.once("error"');
    expect(agent).toContain("writeFileSync(outcomePath");
    expect(agent).toContain("/\\[gateway\\] ready(?:\\r?\\n|$)/u");
    expect(agent).toContain("startupReadyObserved");
    expect(agent).toContain("const deadline = Date.now() + 300000");
    expect(agent).not.toContain('getJson("http://127.0.0.1:" + port + "/readyz")');
    expect(agent).toContain("await Promise.race([");
    expect(agent).toContain('openSync(gatewayOutputPath, "w", 0o600)');
    expect(agent).toContain('stdio: ["ignore", gatewayOutput, gatewayOutput]');
    expect(agent).toContain('readFileSync(join(dirname(entry), "package.json"), "utf8")');
    expect(agent).toContain('OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1"');
    expect(agent).toContain('OPENCLAW_NO_AUTO_UPDATE: "1"');
    expect(agent).toContain('OPENCLAW_SKIP_CHANNELS: "1"');
    expect(agent).toContain('OPENCLAW_SKIP_PROVIDERS: "1"');
    expect(agent).toContain("OPENCLAW_CONFIG_PATH: openClawConfigPath");
    expect(agent).toContain("OPENCLAW_STATE_DIR: openClawStateDirectory");
    expect(agent).not.toContain("execFile");
    expect(agent).not.toContain('"--dev"');
    expect(agent).not.toContain('"--allow-unconfigured"');
    expect(agent).not.toContain('"--token"');
    expect(agent).not.toMatch(/[A-Za-z0-9_-]{40,}/u);
  });

  it("preloads the AppContainer-safe realpath implementation before OpenClaw (#8178)", () => {
    const preload = renderWindowsMxcOpenClawCompatibilityPreload();

    expect(preload).toContain("fs.promises.realpath = promisify(fs.realpath)");
    expect(preload).toContain("syncBuiltinESMExports()");
    expect(preload).not.toContain("NODE_OPTIONS");
  });

  it("scopes AppContainer package-group DACL grants to the requested writable directory (#8178)", () => {
    expect(windowsMxcAppContainerAclArguments("C:\\probe\\share\\home")).toEqual([
      "C:\\probe\\share\\home",
      "/grant",
      "*S-1-15-2-1:(OI)(CI)(M)",
      "*S-1-15-2-2:(OI)(CI)(M)",
      "/T",
      "/C",
      "/Q",
    ]);
  });

  it("grants AppContainer package groups read and execute access to the immutable artifact (#8178)", () => {
    expect(windowsMxcAppContainerReadOnlyAclArguments("C:\\artifact", "YUKON\\lab")).toEqual([
      "C:\\artifact",
      "/inheritance:r",
      "/grant:r",
      "YUKON\\lab:(OI)(CI)(F)",
      "*S-1-5-18:(OI)(CI)(F)",
      "*S-1-5-32-544:(OI)(CI)(F)",
      "*S-1-15-2-1:(OI)(CI)(RX)",
      "*S-1-15-2-2:(OI)(CI)(RX)",
      "/T",
      "/C",
      "/Q",
    ]);
    expect(() =>
      windowsMxcAppContainerReadOnlyAclArguments("C:\\artifact", "YUKON\\lab:injected"),
    ).toThrow(/owner identity is invalid/u);
  });

  it("copies and pins one OpenClaw archive in a single source pass (#8178)", async () => {
    const { root } = fixture();
    const source = path.join(root, "packages", "openclaw-2026.7.1-windows.zip");
    const destination = path.join(root, "copied-openclaw.zip");
    const expected = sha256File(source);

    await expect(
      copyWindowsMxcOpenClawArchiveWithSha256(source, destination, expected),
    ).resolves.toBe(expected);
    expect(fs.readFileSync(destination)).toEqual(fs.readFileSync(source));
  });

  it("removes a copied OpenClaw archive when its pinned digest is wrong (#8178)", async () => {
    const { root } = fixture();
    const source = path.join(root, "packages", "openclaw-2026.7.1-windows.zip");
    const destination = path.join(root, "rejected-openclaw.zip");

    await expect(
      copyWindowsMxcOpenClawArchiveWithSha256(source, destination, "0".repeat(64)),
    ).rejects.toThrow(/expected exact identity/u);
    expect(fs.existsSync(destination)).toBe(false);
  });

  it("prepares an empty staging root before copying the artifact (#10585)", async () => {
    const { root } = fixture();
    const source = path.join(root, "openclaw");
    const staged = path.join(root, "staged");
    const digest = sha256WindowsOpenClawArtifactTree(source);
    const prepareAccess = vi.fn(async (directory: string) => {
      expect(directory).toBe(staged);
      expect(fs.readdirSync(directory)).toEqual([]);
    });
    await stageWindowsMxcOpenClawArtifact(source, staged, prepareAccess);
    expect(prepareAccess).toHaveBeenCalledOnce();
    expect(sha256WindowsOpenClawArtifactTree(staged)).toBe(digest);
    expect(sha256WindowsOpenClawArtifactTree(source)).toBe(digest);
  });

  it("rejects an existing staging root without changing its contents or permissions (#10585)", async () => {
    const { root } = fixture();
    const staged = path.join(root, "staged");
    fs.mkdirSync(staged);
    fs.writeFileSync(path.join(staged, "existing"), "keep");
    const prepareAccess = vi.fn();
    await expect(
      stageWindowsMxcOpenClawArtifact(path.join(root, "openclaw"), staged, prepareAccess),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(prepareAccess).not.toHaveBeenCalled();
    expect(fs.readdirSync(staged)).toEqual(["existing"]);
    expect(fs.readFileSync(path.join(staged, "existing"), "utf8")).toBe("keep");
  });

  it("rejects a destination entry created during access preparation without overwriting it (#10585)", async () => {
    const { root } = fixture();
    const staged = path.join(root, "staged");
    await expect(
      stageWindowsMxcOpenClawArtifact(path.join(root, "openclaw"), staged, async (directory) => {
        fs.mkdirSync(path.join(directory, "node"));
        fs.writeFileSync(path.join(directory, "node", "node.exe"), "keep");
      }),
    ).rejects.toMatchObject({ code: "ERR_FS_CP_EEXIST" });
    expect(fs.readFileSync(path.join(staged, "node", "node.exe"), "utf8")).toBe("keep");
  });

  it("removes the owned empty root after a permission failure without copying artifacts (#10585)", async () => {
    const { root } = fixture();
    const staged = path.join(root, "staged");
    await expect(
      withWindowsMxcLocalSetupOwnership({
        receiptPath: path.join(root, "setup-failure.json"),
        failureReceipt: (removed) => ({ removed }),
        operation: async (ownership) =>
          await stageWindowsMxcOpenClawArtifact(
            path.join(root, "openclaw"),
            staged,
            async (directory) => {
              ownership.trackRoot(directory);
              expect(fs.readdirSync(directory)).toEqual([]);
              throw new Error("permission failure");
            },
          ),
      }),
    ).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: "permission failure" })],
    });
    expect(fs.existsSync(staged)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(root, "setup-failure.json"), "utf8"))).toEqual({
      removed: true,
    });
  });

  it.skipIf(process.platform !== "win32")(
    "inherits package-group modify access on copied and newly created files (#10585)",
    async () => {
      const { root } = fixture();
      const source = path.join(root, "openclaw");
      const staged = path.join(root, "staged");
      const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
      const inspect = (script: string) => {
        const result = spawnSync(
          powershell,
          ["-NoProfile", "-NonInteractive", "-Command", script],
          {
            encoding: "utf8",
            windowsHide: true,
            timeout: 30_000,
            env: {
              ...allowlistedWindowsProcessEnvironment(process.env),
              NEMOCLAW_ACL_FIXTURE: root,
            },
          },
        );
        expect(result.status, result.stderr).toBe(0);
        return JSON.parse(result.stdout);
      };
      const sourceAcl = inspect(
        "(Get-Acl -LiteralPath (Join-Path $env:NEMOCLAW_ACL_FIXTURE 'openclaw')).Sddl | ConvertTo-Json -Compress",
      );
      await stageWindowsMxcOpenClawArtifact(source, staged, async (directory) => {
        expect(fs.readdirSync(directory)).toEqual([]);
        const result = spawnSync(
          "C:\\Windows\\System32\\icacls.exe",
          windowsMxcAppContainerAclArguments(directory),
          { encoding: "utf8", windowsHide: true, timeout: 30_000 },
        );
        expect(result.status).toBe(0);
      });
      fs.writeFileSync(path.join(staged, "runtime", "later.txt"), "new");
      const grants = inspect(
        "$ErrorActionPreference='Stop'; $sids=@('S-1-15-2-1','S-1-15-2-2'); $paths=@('staged/node/node.exe','staged/runtime/openclaw.mjs','staged/runtime/later.txt'); $rows=@(foreach($relative in $paths) { $acl=Get-Acl -LiteralPath (Join-Path $env:NEMOCLAW_ACL_FIXTURE $relative); foreach($sid in $sids) { $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object {$_.IdentityReference.Value -eq $sid -and $_.AccessControlType -eq 'Allow'}); [pscustomobject]@{sid=$sid; inheritedModify=[bool](@($rules | Where-Object {$_.IsInherited -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Modify) -eq [Security.AccessControl.FileSystemRights]::Modify}).Count -gt 0); fullControl=[bool](@($rules | Where-Object {($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl}).Count -gt 0)} } }); ConvertTo-Json -InputObject $rows -Compress",
      );
      expect(grants).toEqual(
        Array.from({ length: 3 }, () => [
          { sid: "S-1-15-2-1", inheritedModify: true, fullControl: false },
          { sid: "S-1-15-2-2", inheritedModify: true, fullControl: false },
        ]).flat(),
      );
      expect(
        inspect(
          "(Get-Acl -LiteralPath (Join-Path $env:NEMOCLAW_ACL_FIXTURE 'openclaw')).Sddl | ConvertTo-Json -Compress",
        ),
      ).toBe(sourceAcl);
      expect(sha256WindowsOpenClawArtifactTree(source)).not.toBe(
        sha256WindowsOpenClawArtifactTree(staged),
      );
    },
    90_000,
  );

  it("serializes a generated probe spawn failure without raw diagnostics (#8178)", async () => {
    const { root } = fixture();
    const agentPath = path.join(root, "probe-agent.mjs");
    const home = path.join(root, "probe-home");
    const resultPath = path.join(root, "probe-result.json");
    const outcomePath = path.join(root, "probe-outcome.json");
    const token = "runtime-only-secret";
    const missingNodePath = path.join(root, "missing-node.exe");
    const missingEntryPath = path.join(root, "missing-openclaw.mjs");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.7.1" }));
    fs.writeFileSync(agentPath, renderWindowsMxcOpenClawProbeAgent(), "utf8");

    const executed = spawnSync(process.execPath, [agentPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        NEMOCLAW_MXC_E2E_COMPAT_PRELOAD: path.join(root, "openclaw-appcontainer-preload.mjs"),
        NEMOCLAW_MXC_E2E_DENY_PATH: path.join(root, "missing-parent", "denied.txt"),
        NEMOCLAW_MXC_E2E_ENTRY: missingEntryPath,
        NEMOCLAW_MXC_E2E_HEARTBEAT_PATH: path.join(root, "heartbeat.txt"),
        NEMOCLAW_MXC_E2E_HOME: home,
        NEMOCLAW_MXC_E2E_MOCK_PORT: "0",
        NEMOCLAW_MXC_E2E_NODE: missingNodePath,
        NEMOCLAW_MXC_E2E_OPENCLAW_PID_PATH: path.join(root, "openclaw.pid"),
        NEMOCLAW_MXC_E2E_OPENCLAW_STATE_DIR: path.join(root, "openclaw-state"),
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
      startupReadyObserved: false,
      versionExitCode: 0,
    });
    expect(result).not.toHaveProperty("gatewaySpawnError");
    expect(Number.isSafeInteger(result.gatewayExitCode)).toBe(true);
    expect(classifyWindowsMxcOpenClawStartupObservation(result)).toEqual({
      outcome: "spawn-failed",
      gatewayExitCode: result.gatewayExitCode,
      versionExitCode: 0,
    });
    expect(outcomeText).toBe(resultText);
    expect(resultText).not.toContain(missingNodePath);
    expect(resultText).not.toContain(token);
  });

  it.each([undefined, "", "*", "localhost,example.com"])(
    "routes only the bound mock endpoint directly with inherited NO_PROXY=%s (#8178)",
    (inheritedNoProxy) => {
      const { root } = fixture();
      const agentPath = path.join(root, "probe-agent.mjs");
      const entryPath = path.join(root, "fake-gateway.mjs");
      const preloadPath = path.join(root, "preload.mjs");
      const observationPath = path.join(root, "child-observation.json");
      const stopPath = path.join(root, "stop.txt");
      const proxy = "http://fixture-user:fixture-password@127.0.0.1:18080";
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.7.1" }));
      fs.writeFileSync(agentPath, renderWindowsMxcOpenClawProbeAgent());
      fs.writeFileSync(preloadPath, "export {};\n");
      fs.writeFileSync(
        entryPath,
        `import { readFileSync, writeFileSync } from "node:fs";
const config = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
const baseUrl = config.models.providers.mock.baseUrl;
const response = await fetch(baseUrl + "/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "mock-chat", messages: [{ role: "user", content: "probe" }] }),
});
writeFileSync(${JSON.stringify(observationPath)}, JSON.stringify({
  baseUrl, status: response.status, chat: await response.json(),
  env: Object.fromEntries(["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"].map((key) => [key, process.env[key]])),
}));
console.log("[gateway] ready");
writeFileSync(${JSON.stringify(stopPath)}, "stop");
setInterval(() => {}, 1000);
`,
      );

      const executed = spawnSync(process.execPath, [agentPath], {
        encoding: "utf8",
        env: {
          ...process.env,
          HTTP_PROXY: proxy,
          http_proxy: proxy,
          HTTPS_PROXY: proxy,
          https_proxy: proxy,
          NO_PROXY: inheritedNoProxy,
          no_proxy: inheritedNoProxy,
          NEMOCLAW_MXC_E2E_COMPAT_PRELOAD: preloadPath,
          NEMOCLAW_MXC_E2E_DENY_PATH: path.join(root, "missing-parent", "denied.txt"),
          NEMOCLAW_MXC_E2E_ENTRY: entryPath,
          NEMOCLAW_MXC_E2E_HEARTBEAT_PATH: path.join(root, "heartbeat.txt"),
          NEMOCLAW_MXC_E2E_HOME: path.join(root, "probe-home"),
          NEMOCLAW_MXC_E2E_MOCK_PORT: "0",
          NEMOCLAW_MXC_E2E_NODE: process.execPath,
          NEMOCLAW_MXC_E2E_OPENCLAW_PID_PATH: path.join(root, "openclaw.pid"),
          NEMOCLAW_MXC_E2E_OPENCLAW_STATE_DIR: path.join(root, "state"),
          NEMOCLAW_MXC_E2E_OPENCLAW_PORT: "0",
          NEMOCLAW_MXC_E2E_OUTCOME_PATH: path.join(root, "outcome.json"),
          NEMOCLAW_MXC_E2E_READY_PATH: path.join(root, "ready.json"),
          NEMOCLAW_MXC_E2E_RESULT_PATH: path.join(root, "result.json"),
          NEMOCLAW_MXC_E2E_STOP_PATH: stopPath,
          NEMOCLAW_MXC_E2E_TOKEN: "fixture-token",
        },
        timeout: 15_000,
        windowsHide: true,
      });

      expect(executed.status, executed.stderr).toBe(0);
      const observation = JSON.parse(fs.readFileSync(observationPath, "utf8"));
      const endpoint = new URL(observation.baseUrl);
      expect(endpoint.hostname).toBe("127.0.0.1");
      expect(Number(endpoint.port)).toBeGreaterThan(0);
      expect(observation.env).toEqual({
        HTTP_PROXY: proxy,
        http_proxy: proxy,
        HTTPS_PROXY: proxy,
        https_proxy: proxy,
        NO_PROXY: endpoint.host,
        no_proxy: endpoint.host,
      });
      expect(observation.status).toBe(200);
      expect(observation.chat.choices[0].message.content).toBe("CHAT_OK");
      expect(JSON.parse(fs.readFileSync(path.join(root, "ready.json"), "utf8"))).toMatchObject({
        startupReadyObserved: true,
        deniedWrite: true,
        versionExitCode: 0,
      });
    },
  );

  it.each([
    {
      expected: { outcome: "ready", gatewayExitCode: null, versionExitCode: 0 },
      result: { startupReadyObserved: true, versionExitCode: 0 },
    },
    {
      expected: {
        outcome: "spawn-failed",
        gatewayExitCode: null,
        versionExitCode: 0,
      },
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
      expected: {
        outcome: "readiness-timeout",
        gatewayExitCode: null,
        versionExitCode: null,
      },
      result: { startupReadyObserved: false },
    },
    {
      expected: {
        outcome: "not-observed",
        gatewayExitCode: null,
        versionExitCode: null,
      },
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
        JSON.stringify({
          status: "ok",
          result: { payloads: [{ text: "CHAT_OK" }], meta: {} },
        }),
      ),
    ).toBe(true);
    expect(
      parseOpenClawExactChatReply(
        JSON.stringify({
          status: "ok",
          result: {
            payloads: [{ text: "CHAT_OK" }, { text: "extra" }],
            meta: {},
          },
        }),
      ),
    ).toBe(false);
    expect(
      parseOpenClawExactChatReply(
        JSON.stringify({
          status: "ok",
          result: { payloads: [{ text: "not exact" }], meta: {} },
        }),
      ),
    ).toBe(false);
    expect(
      parseOpenClawExactChatReply(
        JSON.stringify({
          status: "ok",
          result: { payloads: [{ text: "CHAT_OK" }], meta: {} },
          tool_calls: [{ function: { name: "read", arguments: "{}" } }],
        }),
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
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({ ok: true }),
        };
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
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({ ok: true }),
        };
      },
    });

    expect(observed.evidence.outcome).toBe("terminal");
    expect(observed.evidence.attempts).toEqual([{ attempt: 1, outcome: "terminal" }]);
  });

  it.each([
    "filesystemControlWrite",
    "filesystemDeniedWrite",
    "openClawStartupReady",
    "openClawProcessPresentWhileReady",
    "registryPresentWhileReady",
  ] as const)("does not start forwarding when %s fails (#8178)", (failedCheck) => {
    const checks = {
      filesystemControlWrite: true,
      filesystemDeniedWrite: true,
      openClawStartupReady: true,
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
        openClawStartupReady: true,
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
        openClawStartupReady: true,
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
          JSON.stringify({
            status: "ok",
            result: { payloads: [{ text }], meta: {} },
          }),
        ),
      ).toBe(false);
    },
  );

  it("passes only allowlisted Windows runtime variables to host child processes (#8178)", () => {
    const allowed = allowlistedWindowsProcessEnvironment({
      AWS_SECRET_ACCESS_KEY: "secret",
      Path: "C:\\Windows\\System32",
      PROCESSOR_IDENTIFIER: "ARMv8 (64-bit) Family 8 Model D87 Revision 1, NVIDIA",
      SystemRoot: "C:\\Windows",
      UNRELATED_CREDENTIAL: "secret",
    });

    expect(allowed).toEqual({
      Path: "C:\\Windows\\System32",
      PROCESSOR_IDENTIFIER: "ARMv8 (64-bit) Family 8 Model D87 Revision 1, NVIDIA",
      SystemRoot: "C:\\Windows",
    });
  });

  it("observes native ARM64 when x64 emulation omits the WOW64 marker (#10585)", () => {
    expect(
      observeWindowsNativeArchitecture({
        PROCESSOR_ARCHITECTURE: "AMD64",
        PROCESSOR_IDENTIFIER: "ARMv8 (64-bit) Family 8 Model D87 Revision 1, NVIDIA",
      }),
    ).toBe("arm64");
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
      parseWindowsProcessQueryResult({
        exitCode: 1,
        stderr: "query failed",
        stdout: "",
      }),
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
