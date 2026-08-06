// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import {
  type CuaLifecycleRecord,
  type CuaRuntimeReadiness,
  type CuaTargetAttachment,
  type CuaTaskResult,
  getCuaRuntimeReadinessDigest,
} from "../../../src/lib/cua/contract.ts";
import {
  CUA_FRAMEWORK_FEATURE_ENV,
  CUA_QUALIFICATION_ARTIFACT_RUNNER_ENV,
  CUA_QUALIFICATION_ENVIRONMENT_ENV,
  CUA_QUALIFICATION_FEATURE_ENV,
  CUA_RUNTIME_MANIFEST_ENV,
  CUA_RUNTIME_MANIFEST_SHA256_ENV,
  CUA_SANDBOX_IMAGE_ENV,
} from "../../../src/lib/cua/feature.ts";
import { resolveCuaQualificationArtifactRunner } from "../../../src/lib/cua/qualification-artifact-runner.ts";
import {
  getCuaAdapterBindings,
  loadCuaRuntimeManifest,
  stageCuaRuntimePayload,
  verifyCuaRuntimeAuthorityPayload,
  verifyCuaRuntimePayload,
} from "../../../src/lib/cua/runtime-manifest.ts";
import {
  parseCuaLifecycleRecord,
  parseCuaRuntimeReadiness,
  parseCuaSecurityAttestation,
  parseCuaTargetAttachment,
  parseCuaTaskResult,
} from "../../../src/lib/cua/schema.ts";
import { parseOpenShellPolicy } from "../../../src/lib/policy/merge.ts";
import {
  assertCuaCandidateManifestBindings,
  assertCuaCandidateRuntimeBindings,
  assertCuaQualificationCleanupBindings,
  assertCuaQualificationCliInvocationUnchanged,
  assertCuaQualificationDenialBinding,
  assertCuaQualificationEnvironmentBindings,
  assertCuaQualificationFileDigests,
  assertCuaQualificationFixtureBinding,
  assertCuaQualificationGitCheckout,
  assertCuaQualificationGpuBindings,
  assertCuaQualificationHostToolBindingsUnchanged,
  assertCuaQualificationObservedScenarioBindings,
  assertCuaQualificationProbeImageReference,
  assertCuaQualificationStatusBindings,
  assertCuaQualificationTargetManifestBindings,
  assertCuaQualificationTaskInputExpectationFree,
  assertCuaReleaseBundleBindings,
  buildCuaQualificationArtifactEnvironment,
  buildCuaQualificationFixtureArgs,
  buildCuaQualificationGpuProbeArgs,
  buildCuaQualificationOracleArgs,
  CUA_QUALIFICATION_ARTIFACT_OUTPUT_MAX_BYTES,
  CUA_QUALIFICATION_FILE_MAX_BYTES,
  type CuaCandidateRuntimeBindings,
  type CuaQualificationAuthoritySnapshot,
  consumeBoundedCuaQualificationJson,
  hashBoundedCuaQualificationFile,
  parseCuaQualificationEnvironment,
  parseCuaQualificationReceipt,
  parseCuaReleaseBundleReceipt,
  prepareCuaQualificationAuthority,
  readBoundedCuaQualificationJson,
  resolveCuaQualificationCliInvocation,
  resolveCuaQualificationHostToolBindings,
  stageCuaQualificationAuthorityFiles,
} from "../../../tools/e2e/cua-qualification-receipt.mts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import type { ShellProbeResult, ShellProbeRunOptions } from "../fixtures/shell-probe.ts";
import {
  assertCuaQualificationInventoryTransition,
  assertCuaQualificationLocalRegistryAbsent,
  assertCuaQualificationSingletonInventory,
  buildCuaQualificationOnboardEnv,
  CUA_QUALIFICATION_OPENSHELL_INVENTORY_MAX_BYTES,
  collectCuaQualificationOnboardSecretEnv,
  isCuaQualificationGatewayUnavailable,
  parseCuaQualificationOpenShellInventory,
  registerCuaQualificationSandboxCleanup,
} from "./cua-gpu-qualification-onboard.ts";

const RAW_SHA256 = /^[0-9a-f]{64}$/;
const SANDBOX_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const IMMUTABLE_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:+-]*@sha256:[0-9a-f]{64}$/;
const MAX_COMPONENT_BYTES = 64 * 1024 * 1024;
const CUA_GPU_QUALIFICATION_TIMEOUT_MS = 30 * 60_000;
const CUA_ARTIFACT_ACCOUNT = "nemoclaw-cua-artifact";
const SYSTEMD_CGROUP_SLICE = "/sys/fs/cgroup/system.slice";

type QualificationNemoclaw = (
  args: string[],
  options?: ShellProbeRunOptions,
) => Promise<ShellProbeResult>;

function requiredEnv(name: string, pattern: RegExp): string {
  const value = process.env[name];
  if (!value || value.length > 4096 || !pattern.test(value)) {
    throw new Error(`${name} is required and invalid`);
  }
  return value;
}

function requiredAbsoluteFile(name: string): string {
  const value = process.env[name];
  if (!value || value.length > 4096 || !path.isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${name} must name one absolute file`);
  }
  return value;
}

function qualificationHostToolPath(name: string, fallback: string, basename: string): string {
  const value = process.env[name] ?? fallback;
  if (
    value.length > 4096 ||
    !path.isAbsolute(value) ||
    value.includes("\0") ||
    path.basename(value) !== basename
  ) {
    throw new Error(`${name} must name one absolute executable`);
  }
  return value;
}

function uniqueLines(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ].sort();
}

function positiveIdentity(result: ShellProbeResult, label: string): number {
  expect(result.exitCode, result.stderr).toBe(0);
  const value = result.stdout.trim();
  expect(value, label).toMatch(/^[1-9][0-9]{0,9}$/);
  return Number(value);
}

function hostProcessesUsingIdentity(uid: number, gid: number): number[] {
  const matches: number[] = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let status: string;
    try {
      status = fs.readFileSync(`/proc/${entry}/status`, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const uids = status
      .match(/^Uid:\s+(.+)$/m)?.[1]
      ?.trim()
      .split(/\s+/);
    const gids = status
      .match(/^Gid:\s+(.+)$/m)?.[1]
      ?.trim()
      .split(/\s+/);
    const groups =
      status
        .match(/^Groups:\s*(.*)$/m)?.[1]
        ?.trim()
        .split(/\s+/) ?? [];
    if (uids === undefined || gids === undefined) {
      throw new Error(`host process ${entry} omitted UID/GID status`);
    }
    if (uids.includes(String(uid)) || gids.includes(String(gid)) || groups.includes(String(gid))) {
      matches.push(Number(entry));
    }
  }
  return matches.sort((left, right) => left - right);
}

function cuaArtifactCgroups(): string[] {
  if (!fs.existsSync(SYSTEMD_CGROUP_SLICE)) {
    throw new Error("systemd cgroup-v2 slice is unavailable");
  }
  return fs
    .readdirSync(SYSTEMD_CGROUP_SLICE)
    .filter((entry) => /^nemoclaw-cua-artifact-[A-Za-z0-9]+\.service$/.test(entry))
    .sort();
}

async function listCuaArtifactUnits(
  host: HostCliClient,
  env: NodeJS.ProcessEnv,
  artifactName: string,
): Promise<string[]> {
  const result = await host.command(
    "/usr/bin/systemctl",
    [
      "list-units",
      "--all",
      "--plain",
      "--no-legend",
      "--no-pager",
      "nemoclaw-cua-artifact-*.service",
    ],
    {
      artifactName,
      captureLimitBytes: 4096,
      env,
      redactionValues: [],
      timeoutMs: 5_000,
    },
  );
  expect(result.exitCode, result.stderr).toBe(0);
  return uniqueLines(result.stdout);
}

function jsonRecord(result: ShellProbeResult, operation: string): CuaLifecycleRecord {
  expect(result.exitCode, result.stderr).toBe(0);
  let value: unknown;
  try {
    value = JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error(`${operation} did not return bounded JSON`);
  }
  const record = parseCuaLifecycleRecord(value);
  if (record.kind === "failure") {
    throw new Error(`${operation} failed with ${record.family}`);
  }
  return record;
}

async function runCuaLifecycle(
  nemoclaw: QualificationNemoclaw,
  operation: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  redactionValues: string[],
  exercisedOperations: Set<string>,
): Promise<CuaLifecycleRecord> {
  const result = await nemoclaw(["sandbox", "cua", ...args, "--json"], {
    artifactName: `cua-qualification-${operation.replaceAll(".", "-")}`,
    captureLimitBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
    env,
    redactionValues,
    timeoutMs: 90_000,
  });
  const record = jsonRecord(result, operation);
  exercisedOperations.add(operation.split(".").slice(0, 2).join("."));
  return record;
}

async function runCuaDenial(
  nemoclaw: QualificationNemoclaw,
  id: Parameters<typeof assertCuaQualificationDenialBinding>[1],
  args: string[],
  env: NodeJS.ProcessEnv,
  redactionValues: string[],
  receipt: ReturnType<typeof parseCuaQualificationReceipt>,
  exercisedDenials: Set<string>,
): Promise<void> {
  const result = await nemoclaw(["sandbox", "cua", ...args, "--json"], {
    artifactName: `cua-qualification-denial-${id}`,
    captureLimitBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
    env,
    redactionValues,
    timeoutMs: 30_000,
  });
  expect(result.exitCode).not.toBe(0);
  const value = JSON.parse(result.stdout) as unknown;
  expect(assertCuaQualificationDenialBinding(receipt, id, value).kind).toBe("failure");
  exercisedDenials.add(id);
}

async function withQualificationAuthority<T>(
  authority: CuaQualificationAuthoritySnapshot,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } finally {
    authority.cleanup();
  }
}

function buildPolicyBoundaryViolation(basePolicyYaml: string): string {
  const parsed: unknown = YAML.parse(basePolicyYaml);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("CUA qualification base policy must be a YAML mapping");
  }
  const policy = parsed as Record<string, unknown>;
  const existing = policy.network_policies;
  if (
    existing !== undefined &&
    (typeof existing !== "object" || existing === null || Array.isArray(existing))
  ) {
    throw new Error("CUA qualification network policies must be a mapping");
  }
  policy.network_policies = {
    ...((existing as Record<string, unknown> | undefined) ?? {}),
    cua_qualification_undeclared_full_access: {
      name: "cua_qualification_undeclared_full_access",
      endpoints: [
        {
          host: "qualification.invalid",
          port: 443,
          access: "full",
          tls: "skip",
        },
      ],
      binaries: [{ path: "/usr/local/bin/nemocua" }],
    },
  };
  return YAML.stringify(policy);
}

async function exercisePolicyBoundaryDenial(options: {
  host: HostCliClient;
  nemoclaw: QualificationNemoclaw;
  openshellBinaryPath: string;
  sandboxName: string;
  securityAdapterPath: string;
  runtimeEnv: NodeJS.ProcessEnv;
  redactionValues: string[];
  receipt: ReturnType<typeof parseCuaQualificationReceipt>;
  exercisedDenials: Set<string>;
}): Promise<void> {
  const base = await options.host.command(
    options.openshellBinaryPath,
    ["policy", "get", "--base", options.sandboxName],
    {
      artifactName: "cua-qualification-policy-boundary-base",
      captureLimitBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
      env: options.runtimeEnv,
      redactionValues: options.redactionValues,
      timeoutMs: 30_000,
    },
  );
  expect(base.exitCode, base.stderr).toBe(0);
  const basePolicy = parseOpenShellPolicy(base.stdout);
  const invalidPolicyYaml = buildPolicyBoundaryViolation(basePolicy.yamlBody);
  const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-policy-denial-"));
  fs.chmodSync(sourceDirectory, 0o700);
  const baseSourcePath = path.join(sourceDirectory, "base.yaml");
  const invalidSourcePath = path.join(sourceDirectory, "invalid.yaml");
  fs.writeFileSync(baseSourcePath, basePolicy.yamlBody, { mode: 0o600 });
  fs.writeFileSync(invalidSourcePath, invalidPolicyYaml, { mode: 0o600 });
  let policyAuthority: ReturnType<typeof stageCuaQualificationAuthorityFiles> | undefined;
  try {
    policyAuthority = stageCuaQualificationAuthorityFiles({
      basePolicy: {
        sourcePath: baseSourcePath,
        maxBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
        expectedDigest: hashBoundedCuaQualificationFile(baseSourcePath).sha256,
      },
      invalidPolicy: {
        sourcePath: invalidSourcePath,
        maxBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
        expectedDigest: hashBoundedCuaQualificationFile(invalidSourcePath).sha256,
      },
    });
    policyAuthority.seal();
    options.redactionValues.push(
      baseSourcePath,
      invalidSourcePath,
      policyAuthority.files.basePolicy!,
      policyAuthority.files.invalidPolicy!,
    );
    let mutationAttempted = false;
    try {
      mutationAttempted = true;
      const applied = await options.host.command(
        options.openshellBinaryPath,
        [
          "policy",
          "set",
          "--policy",
          policyAuthority.files.invalidPolicy!,
          "--wait",
          options.sandboxName,
        ],
        {
          artifactName: "cua-qualification-policy-boundary-apply",
          captureLimitBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
          env: options.runtimeEnv,
          redactionValues: options.redactionValues,
          timeoutMs: 90_000,
        },
      );
      expect(applied.exitCode, applied.stderr).toBe(0);
      await runCuaDenial(
        options.nemoclaw,
        "policy-boundary-violation",
        ["security", "verify", options.sandboxName, "--adapter", options.securityAdapterPath],
        options.runtimeEnv,
        options.redactionValues,
        options.receipt,
        options.exercisedDenials,
      );
    } finally {
      if (mutationAttempted) {
        const restored = await options.host.command(
          options.openshellBinaryPath,
          [
            "policy",
            "set",
            "--policy",
            policyAuthority.files.basePolicy!,
            "--wait",
            options.sandboxName,
          ],
          {
            artifactName: "cua-qualification-policy-boundary-restore",
            captureLimitBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
            env: options.runtimeEnv,
            redactionValues: options.redactionValues,
            timeoutMs: 90_000,
          },
        );
        expect(restored.exitCode, restored.stderr).toBe(0);
        const observed = await options.host.command(
          options.openshellBinaryPath,
          ["policy", "get", "--base", options.sandboxName],
          {
            artifactName: "cua-qualification-policy-boundary-restored",
            captureLimitBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
            env: options.runtimeEnv,
            redactionValues: options.redactionValues,
            timeoutMs: 30_000,
          },
        );
        expect(observed.exitCode, observed.stderr).toBe(0);
        expect(parseOpenShellPolicy(observed.stdout).policy).toEqual(basePolicy.policy);
      }
    }
  } finally {
    policyAuthority?.cleanup();
    fs.rmSync(sourceDirectory, { recursive: true, force: true });
  }
}

function expectAttachedTarget(
  record: CuaLifecycleRecord,
  receipt: ReturnType<typeof parseCuaQualificationReceipt>,
  readinessDigest: string,
): CuaTargetAttachment {
  const target = parseCuaTargetAttachment(record);
  expect(target.status).toBe("attached");
  expect(target.runtimeReadinessDigest).toBe(readinessDigest);
  expect(target.target).not.toBeNull();
  expect(target.target?.image.digest).toBe(receipt.components.targetImage);
  expect(target.target?.serviceBundle.digest).toBe(receipt.components.serviceBundle);
  expect(target.target?.capabilities.map(({ id }) => id).sort()).toEqual([
    "browser",
    "computer",
    "terminal",
  ]);
  expect(target.target?.capabilities.every(({ health }) => health === "healthy")).toBe(true);
  return target;
}

function expectTaskResultBindings(
  record: CuaLifecycleRecord,
  taskId: string,
  expectedStatus: "succeeded" | "cancelled",
  runtime: CuaRuntimeReadiness,
  target: NonNullable<CuaTargetAttachment["target"]>,
): CuaTaskResult {
  const result = parseCuaTaskResult(record);
  expect(result.taskId).toBe(taskId);
  expect(result.status).toBe(expectedStatus);
  expect(result.agentResult.status).toBe(expectedStatus);
  expect(result.runtimeReadinessDigest).toBe(getCuaRuntimeReadinessDigest(runtime));
  expect(result.targetIdentityDigest).toBe(target.identityDigest);
  expect(result.inference).toEqual(runtime.inference);
  expect(result.components).toEqual({
    openshell: runtime.components.openshell,
    runtime: runtime.components.runtime,
    sandboxImage: runtime.components.sandboxImage,
    targetImage: target.image,
    serviceBundle: target.serviceBundle,
    policy: runtime.components.policy,
    taskProtocol: runtime.components.taskProtocol,
  });
  if (expectedStatus === "succeeded") {
    expect(result.verification.status).toBe("passed");
    expect(result.capabilities.map(({ id }) => id)).toEqual(["browser"]);
    expect(result.receipts.map(({ capability }) => capability)).toEqual(["browser"]);
    expect(result.receipts.every(({ status }) => status === "completed")).toBe(true);
  }
  return result;
}

test("CUA GPU qualification binds one exact candidate and completes the browser slice (#7755)", {
  timeout: CUA_GPU_QUALIFICATION_TIMEOUT_MS,
  meta: {
    e2ePhases: [
      "require explicit CUA GPU qualification selection",
      "read bounded qualification environment receipt manifest and payload identities",
      "verify exact clean candidate source and one immutable qualification identity",
      "prove the dedicated qualification sandbox name is locally absent",
      "onboard the candidate through the canonical public NemoCUA path",
      "verify onboarding created one OpenShell sandbox and public candidate readiness",
      "probe the image-provided target channel through the isolated artifact UID",
      "exercise every required target lifecycle operation",
      "exercise every required security lifecycle operation",
      "exercise every required task lifecycle operation",
      "re-observe complete GPU toolkit and immutable probe image identity",
      "verify final target and canonical sandbox cleanup with unchanged authority payload",
    ],
  },
}, async ({ cleanup, host, progress, skip }) => {
  progress.phase("require explicit CUA GPU qualification selection");
  if (process.env.NEMOCLAW_RUN_CUA_GPU_QUALIFICATION !== "1") {
    skip("set NEMOCLAW_RUN_CUA_GPU_QUALIFICATION=1 on the qualification Launchable");
  }

  const sourceEnvironmentPath = requiredAbsoluteFile(CUA_QUALIFICATION_ENVIRONMENT_ENV);
  const sourceReceiptPath = requiredAbsoluteFile("NEMOCLAW_CUA_QUALIFICATION_RECEIPT");
  const sourceBundleReceiptPath = requiredAbsoluteFile("NEMOCLAW_CUA_BUNDLE_RECEIPT");
  const sourceRuntimeManifestPath = requiredAbsoluteFile(CUA_RUNTIME_MANIFEST_ENV);
  const sourceTargetManifestPath = requiredAbsoluteFile("NEMOCLAW_CUA_TARGET_MANIFEST");
  const sourceTaskInputPath = requiredAbsoluteFile("NEMOCLAW_CUA_TASK_INPUT");
  const sourceLaunchableScriptPath = requiredAbsoluteFile("NEMOCLAW_CUA_LAUNCHABLE_SCRIPT");
  const sourceOpenshellBinaryPath = fs.realpathSync(
    requiredAbsoluteFile("NEMOCLAW_CUA_OPENSHELL_BINARY"),
  );
  const sourceFixturePath = requiredAbsoluteFile("NEMOCLAW_CUA_FIXTURE_ARTIFACT");
  const sourceOraclePath = requiredAbsoluteFile("NEMOCLAW_CUA_ORACLE_ARTIFACT");
  const sourceArtifactRunnerPath = fs.realpathSync(
    requiredAbsoluteFile(CUA_QUALIFICATION_ARTIFACT_RUNNER_ENV),
  );
  const expectedEnvironmentSha256 = requiredEnv(
    "NEMOCLAW_CUA_QUALIFICATION_ENVIRONMENT_SHA256",
    RAW_SHA256,
  );
  const expectedReceiptSha256 = requiredEnv(
    "NEMOCLAW_CUA_QUALIFICATION_RECEIPT_SHA256",
    RAW_SHA256,
  );
  const expectedBundleReceiptSha256 = requiredEnv("NEMOCLAW_CUA_BUNDLE_RECEIPT_SHA256", RAW_SHA256);
  const expectedRuntimeManifestSha256 = requiredEnv(CUA_RUNTIME_MANIFEST_SHA256_ENV, RAW_SHA256);
  const expectedTargetManifestSha256 = requiredEnv(
    "NEMOCLAW_CUA_TARGET_MANIFEST_SHA256",
    RAW_SHA256,
  );
  const expectedTaskInputSha256 = requiredEnv("NEMOCLAW_CUA_TASK_INPUT_SHA256", RAW_SHA256);
  const sandboxName = requiredEnv("NEMOCLAW_CUA_SANDBOX_NAME", SANDBOX_NAME);
  const sandboxImage = requiredEnv(CUA_SANDBOX_IMAGE_ENV, IMMUTABLE_IMAGE);
  const probeImage = requiredEnv("NEMOCLAW_CUA_GPU_PROBE_IMAGE", IMMUTABLE_IMAGE);

  progress.phase("read bounded qualification environment receipt manifest and payload identities");
  const sourceRawReceipt = consumeBoundedCuaQualificationJson(sourceReceiptPath);
  expect(sourceRawReceipt.sha256).toBe(`sha256:${expectedReceiptSha256}`);
  const sourceReceipt = parseCuaQualificationReceipt(sourceRawReceipt.value);
  expect(
    assertCuaQualificationTaskInputExpectationFree(sourceTaskInputPath, sourceReceipt, [
      sourceReceiptPath,
      sourceRawReceipt.consumedPath,
    ]).sha256,
  ).toBe(`sha256:${expectedTaskInputSha256}`);
  const qualificationRoot = fs.realpathSync(process.cwd());
  assertCuaQualificationGitCheckout(qualificationRoot, sourceReceipt.nemoclawCommit);
  const sourceIsolationProbePath = path.join(
    qualificationRoot,
    "tools/e2e/cua-qualification-isolation-probe.sh",
  );
  const isolationProbeDigest = hashBoundedCuaQualificationFile(sourceIsolationProbePath).sha256;
  const sourceTargetChannelProbePath = path.join(
    qualificationRoot,
    "scripts/cua-qualification-target-channel-probe.ts",
  );
  const targetChannelProbeDigest = hashBoundedCuaQualificationFile(
    sourceTargetChannelProbePath,
  ).sha256;
  const controllerSentinel = crypto.randomBytes(32);
  const cliInvocation = resolveCuaQualificationCliInvocation(qualificationRoot, process.env);
  const sourceRuntimeEnv: NodeJS.ProcessEnv = {
    ...buildAvailabilityProbeEnv(),
    PATH: cliInvocation.path,
    [CUA_FRAMEWORK_FEATURE_ENV]: "1",
    [CUA_QUALIFICATION_FEATURE_ENV]: "1",
    [CUA_RUNTIME_MANIFEST_ENV]: sourceRuntimeManifestPath,
    [CUA_RUNTIME_MANIFEST_SHA256_ENV]: expectedRuntimeManifestSha256,
    [CUA_QUALIFICATION_ENVIRONMENT_ENV]: sourceEnvironmentPath,
    [CUA_QUALIFICATION_ARTIFACT_RUNNER_ENV]: sourceArtifactRunnerPath,
    [CUA_SANDBOX_IMAGE_ENV]: sandboxImage,
    NEMOCLAW_OPENSHELL_BIN: sourceOpenshellBinaryPath,
  };
  const sourceLoadedManifest = loadCuaRuntimeManifest(sourceRuntimeEnv);
  verifyCuaRuntimePayload(sourceLoadedManifest);
  assertCuaCandidateManifestBindings(sourceLoadedManifest.manifest, sourceReceipt);
  const payloads = sourceLoadedManifest.manifest;
  const authority = prepareCuaQualificationAuthority(
    {
      environment: {
        sourcePath: sourceEnvironmentPath,
        maxBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
        expectedDigest: `sha256:${expectedEnvironmentSha256}`,
      },
      bundleReceipt: {
        sourcePath: sourceBundleReceiptPath,
        maxBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
        expectedDigest: `sha256:${expectedBundleReceiptSha256}`,
      },
      runtimeManifest: {
        sourcePath: sourceRuntimeManifestPath,
        maxBytes: 256 * 1024,
        expectedDigest: `sha256:${expectedRuntimeManifestSha256}`,
      },
      targetManifest: {
        sourcePath: sourceTargetManifestPath,
        maxBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
        expectedDigest: `sha256:${expectedTargetManifestSha256}`,
      },
      taskInput: {
        sourcePath: sourceTaskInputPath,
        maxBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
        expectedDigest: `sha256:${expectedTaskInputSha256}`,
      },
      launchableScript: {
        sourcePath: sourceLaunchableScriptPath,
        maxBytes: MAX_COMPONENT_BYTES,
        expectedDigest: sourceReceipt.launchable.digest,
        executable: true,
      },
      openshell: {
        sourcePath: sourceOpenshellBinaryPath,
        maxBytes: MAX_COMPONENT_BYTES,
        expectedDigest: sourceReceipt.components.openshell,
        executable: true,
      },
      fixture: {
        sourcePath: sourceFixturePath,
        maxBytes: MAX_COMPONENT_BYTES,
        expectedDigest: sourceReceipt.components.fixture,
        executable: true,
      },
      oracle: {
        sourcePath: sourceOraclePath,
        maxBytes: MAX_COMPONENT_BYTES,
        expectedDigest: sourceReceipt.components.oracle,
        executable: true,
      },
      isolationProbe: {
        sourcePath: sourceIsolationProbePath,
        maxBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
        expectedDigest: isolationProbeDigest,
        executable: true,
      },
      targetChannelProbe: {
        sourcePath: sourceTargetChannelProbePath,
        maxBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
        expectedDigest: targetChannelProbeDigest,
        executable: true,
      },
    },
    (snapshot) => {
      stageCuaRuntimePayload(snapshot.directory, sourceRuntimeEnv);
      for (const identity of [
        payloads.agent.manifest,
        payloads.agent.dockerfile,
        payloads.agent.baseDockerfile,
        payloads.agent.policy,
        payloads.artifacts.hostCli,
        payloads.artifacts.targetServices,
      ]) {
        fs.chmodSync(path.join(snapshot.directory, identity.filename), 0o400);
      }
      for (const identity of Object.values(payloads.artifacts.adapters)) {
        fs.chmodSync(path.join(snapshot.directory, identity.filename), 0o500);
      }
      const denialAdapterPath = path.join(snapshot.directory, ".unregistered-adapter");
      fs.writeFileSync(denialAdapterPath, "denied\n", { flag: "wx", mode: 0o400 });
      fs.chmodSync(denialAdapterPath, 0o400);
      const controllerSentinelPath = path.join(snapshot.directory, ".controller-sentinel");
      fs.writeFileSync(controllerSentinelPath, controllerSentinel, { flag: "wx", mode: 0o400 });
      fs.chmodSync(controllerSentinelPath, 0o400);
      snapshot.seal([
        payloads.agent.manifest.filename,
        payloads.agent.dockerfile.filename,
        payloads.agent.baseDockerfile.filename,
        payloads.agent.policy.filename,
        payloads.artifacts.hostCli.filename,
        payloads.artifacts.targetServices.filename,
        ...Object.values(payloads.artifacts.adapters).map(({ filename }) => filename),
        path.basename(denialAdapterPath),
        path.basename(controllerSentinelPath),
      ]);
    },
  );
  const unregisteredAdapterPath = path.join(authority.directory, ".unregistered-adapter");

  await withQualificationAuthority(authority, async () => {
    const environmentPath = authority.files.environment!;
    const bundleReceiptPath = authority.files.bundleReceipt!;
    const runtimeManifestPath = authority.files.runtimeManifest!;
    const targetManifestPath = authority.files.targetManifest!;
    const taskInputPath = authority.files.taskInput!;
    const launchableScriptPath = authority.files.launchableScript!;
    const openshellBinaryPath = authority.files.openshell!;
    const fixturePath = authority.files.fixture!;
    const oraclePath = authority.files.oracle!;
    const isolationProbePath = authority.files.isolationProbe!;
    const targetChannelProbePath = authority.files.targetChannelProbe!;
    const controllerSentinelPath = path.join(authority.directory, ".controller-sentinel");
    expect(authority.files.receipt).toBeUndefined();
    expect(fs.existsSync(sourceReceiptPath)).toBe(false);
    expect(fs.existsSync(sourceRawReceipt.consumedPath)).toBe(false);
    expect(
      assertCuaQualificationTaskInputExpectationFree(taskInputPath, sourceReceipt, [
        sourceReceiptPath,
        sourceRawReceipt.consumedPath,
      ]).sha256,
    ).toBe(`sha256:${expectedTaskInputSha256}`);
    const runtimeEnv: NodeJS.ProcessEnv = {
      ...sourceRuntimeEnv,
      PATH: cliInvocation.path,
      [CUA_RUNTIME_MANIFEST_ENV]: runtimeManifestPath,
      [CUA_QUALIFICATION_ENVIRONMENT_ENV]: environmentPath,
      NEMOCLAW_OPENSHELL_BIN: openshellBinaryPath,
    };
    const onboardingRuntimeEnv: NodeJS.ProcessEnv = {
      PATH: cliInvocation.path,
      [CUA_FRAMEWORK_FEATURE_ENV]: "1",
      [CUA_QUALIFICATION_FEATURE_ENV]: "1",
      [CUA_RUNTIME_MANIFEST_ENV]: runtimeManifestPath,
      [CUA_RUNTIME_MANIFEST_SHA256_ENV]: expectedRuntimeManifestSha256,
      [CUA_QUALIFICATION_ENVIRONMENT_ENV]: environmentPath,
      [CUA_QUALIFICATION_ARTIFACT_RUNNER_ENV]: sourceArtifactRunnerPath,
      [CUA_SANDBOX_IMAGE_ENV]: sandboxImage,
      NEMOCLAW_OPENSHELL_BIN: openshellBinaryPath,
    };
    const artifactEnv = buildCuaQualificationArtifactEnvironment(cliInvocation.path);
    const artifactRunnerPath = resolveCuaQualificationArtifactRunner(runtimeEnv);
    expect(artifactRunnerPath).toBe(sourceArtifactRunnerPath);
    const artifactUser = await host.command("/usr/bin/id", ["-u", CUA_ARTIFACT_ACCOUNT], {
      artifactName: "cua-qualification-artifact-user",
      captureLimitBytes: 128,
      env: artifactEnv,
      redactionValues: [],
      timeoutMs: 5_000,
    });
    const artifactGroup = await host.command("/usr/bin/id", ["-g", CUA_ARTIFACT_ACCOUNT], {
      artifactName: "cua-qualification-artifact-group",
      captureLimitBytes: 128,
      env: artifactEnv,
      redactionValues: [],
      timeoutMs: 5_000,
    });
    const artifactUid = positiveIdentity(artifactUser, "artifact UID");
    const artifactGid = positiveIdentity(artifactGroup, "artifact GID");
    expect(hostProcessesUsingIdentity(artifactUid, artifactGid)).toEqual([]);
    expect(cuaArtifactCgroups()).toEqual([]);
    expect(
      await listCuaArtifactUnits(
        host,
        artifactEnv,
        "cua-qualification-artifact-units-before-isolation",
      ),
    ).toEqual([]);
    const isolation = await host.command(
      artifactRunnerPath!,
      [
        "--no-target-channel",
        "--artifact-sha256",
        isolationProbeDigest.slice("sha256:".length),
        "--",
        isolationProbePath,
        authority.directory,
        controllerSentinelPath,
        sourceReceiptPath,
        sourceRawReceipt.consumedPath,
      ],
      {
        artifactName: "cua-qualification-artifact-isolation",
        captureLimitBytes: CUA_QUALIFICATION_ARTIFACT_OUTPUT_MAX_BYTES,
        env: artifactEnv,
        redactionValues: [
          authority.directory,
          controllerSentinelPath,
          sourceReceiptPath,
          sourceRawReceipt.consumedPath,
        ],
        timeoutMs: 30_000,
      },
    );
    expect(isolation.exitCode, isolation.stderr).toBe(0);
    const isolationRecord = JSON.parse(isolation.stdout) as Record<string, unknown>;
    expect(Object.keys(isolationRecord).sort()).toEqual(["kind", "schemaVersion", "status", "uid"]);
    expect(isolationRecord).toMatchObject({
      schemaVersion: "1.0.0",
      kind: "cua-qualification-isolation-probe",
      status: "isolated",
      uid: artifactUid,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(hostProcessesUsingIdentity(artifactUid, artifactGid)).toEqual([]);
    expect(cuaArtifactCgroups()).toEqual([]);
    expect(
      await listCuaArtifactUnits(
        host,
        artifactEnv,
        "cua-qualification-artifact-units-after-isolation",
      ),
    ).toEqual([]);
    const nemoclaw: QualificationNemoclaw = (args, options = {}) =>
      host.command(cliInvocation.command, [...cliInvocation.argsPrefix, ...args], {
        ...options,
        cwd: cliInvocation.cwd,
      });
    const rawEnvironment = readBoundedCuaQualificationJson(environmentPath);
    const rawReceipt = sourceRawReceipt;
    const rawBundleReceipt = readBoundedCuaQualificationJson(bundleReceiptPath);
    const rawTargetManifest = readBoundedCuaQualificationJson(targetManifestPath);
    assertCuaQualificationFileDigests(
      {
        environment: rawEnvironment.sha256,
        receipt: rawReceipt.sha256,
        bundleReceipt: rawBundleReceipt.sha256,
      },
      {
        environment: `sha256:${expectedEnvironmentSha256}`,
        receipt: `sha256:${expectedReceiptSha256}`,
        bundleReceipt: `sha256:${expectedBundleReceiptSha256}`,
      },
    );
    const environment = parseCuaQualificationEnvironment(rawEnvironment.value);
    const receipt = parseCuaQualificationReceipt(rawReceipt.value);
    const bundleReceipt = parseCuaReleaseBundleReceipt(rawBundleReceipt.value);
    const hostToolPaths = {
      node: cliInvocation.command,
      docker: qualificationHostToolPath("NEMOCLAW_CUA_DOCKER_BIN", "/usr/bin/docker", "docker"),
      nvidiaSmi: qualificationHostToolPath(
        "NEMOCLAW_CUA_NVIDIA_SMI_BIN",
        "/usr/bin/nvidia-smi",
        "nvidia-smi",
      ),
      nvidiaCtk: qualificationHostToolPath(
        "NEMOCLAW_CUA_NVIDIA_CTK_BIN",
        "/usr/bin/nvidia-ctk",
        "nvidia-ctk",
      ),
    };
    const hostTools = resolveCuaQualificationHostToolBindings(environment.hostTools, hostToolPaths);
    const trustedHostPath = [
      ...new Set([
        path.dirname(hostTools.node.path),
        path.dirname(hostTools.docker.path),
        path.dirname(hostTools.nvidiaSmi.path),
        path.dirname(hostTools.nvidiaCtk.path),
        path.dirname(hostToolPaths.docker),
        path.dirname(hostToolPaths.nvidiaSmi),
        path.dirname(hostToolPaths.nvidiaCtk),
        "/usr/sbin",
        "/usr/bin",
        "/sbin",
        "/bin",
      ]),
    ].join(":");
    runtimeEnv.PATH = trustedHostPath;
    onboardingRuntimeEnv.PATH = trustedHostPath;
    const onboardingProvider = process.env.NEMOCLAW_PROVIDER ?? "";
    const onboarding = buildCuaQualificationOnboardEnv({
      baseEnv: process.env,
      expectedModel: receipt.inference.model,
      model: process.env.NEMOCLAW_MODEL ?? "",
      provider: onboardingProvider,
      runtimeEnv: onboardingRuntimeEnv,
      secretEnv: collectCuaQualificationOnboardSecretEnv(process.env, onboardingProvider),
    });
    assertCuaQualificationEnvironmentBindings(environment, receipt);
    expect(rawBundleReceipt.sha256).toBe(`sha256:${receipt.bundleReceiptSha256}`);
    assertCuaReleaseBundleBindings(bundleReceipt, receipt);
    const loadedManifest = loadCuaRuntimeManifest(runtimeEnv);
    verifyCuaRuntimePayload(loadedManifest);
    assertCuaCandidateManifestBindings(loadedManifest.manifest, receipt);
    assertCuaQualificationTargetManifestBindings(rawTargetManifest.value, receipt);
    const adapters = getCuaAdapterBindings(runtimeEnv);
    expect(adapters.target.digest).toBe(receipt.components.targetAdapter);
    expect(adapters.task.digest).toBe(receipt.components.taskProtocol);
    expect(adapters.security.digest).toBe(receipt.components.securityVerifier);
    const redactionValues = [
      ...Object.values(authority.files),
      sourceEnvironmentPath,
      sourceReceiptPath,
      sourceRawReceipt.consumedPath,
      sourceBundleReceiptPath,
      sourceRuntimeManifestPath,
      sourceTargetManifestPath,
      sourceTaskInputPath,
      sourceLaunchableScriptPath,
      sourceOpenshellBinaryPath,
      sourceFixturePath,
      sourceOraclePath,
      adapters.target.path,
      adapters.task.path,
      adapters.security.path,
      unregisteredAdapterPath,
      ...onboarding.redactionValues,
    ];
    const exercisedOperations = new Set<string>();
    const exercisedDenials = new Set<string>();
    const exercisedFixtures = new Set<string>();
    const exercisedOracles = new Set<string>();
    const runLifecycle = (operation: string, args: string[]) =>
      runCuaLifecycle(nemoclaw, operation, args, runtimeEnv, redactionValues, exercisedOperations);
    let candidateReady = false;
    try {
      progress.phase(
        "verify exact clean candidate source and one immutable qualification identity",
      );
      assertCuaQualificationGitCheckout(qualificationRoot, receipt.nemoclawCommit);
      const sourceRevision = receipt.nemoclawCommit;
      const sourceClean = true;

      progress.phase("prove the dedicated qualification sandbox name is locally absent");
      const onboardingHome = onboarding.env.HOME;
      if (!onboardingHome) {
        throw new Error("CUA qualification onboarding requires HOME in the minimal child env");
      }
      assertCuaQualificationLocalRegistryAbsent({ home: onboardingHome, sandboxName });

      const preOnboardInventory = await host.command(
        openshellBinaryPath,
        ["sandbox", "list", "-o", "json"],
        {
          artifactName: "cua-qualification-pre-onboard-openshell-inventory",
          captureLimitBytes: CUA_QUALIFICATION_OPENSHELL_INVENTORY_MAX_BYTES,
          env: onboarding.env,
          redactionValues,
          timeoutMs: 30_000,
        },
      );
      let preOnboardInventoryNames: string[] | null = null;
      if (preOnboardInventory.exitCode === 0) {
        preOnboardInventoryNames = parseCuaQualificationOpenShellInventory(
          preOnboardInventory.stdout,
        );
        if (preOnboardInventoryNames.includes(sandboxName)) {
          throw new Error(`CUA qualification sandbox '${sandboxName}' already exists in OpenShell`);
        }
      } else if (!isCuaQualificationGatewayUnavailable(preOnboardInventory)) {
        throw new Error(
          `CUA qualification could not prove pre-onboard OpenShell inventory: ${preOnboardInventory.stderr}`,
        );
      }

      registerCuaQualificationSandboxCleanup(cleanup, sandboxName, {
        openshell: async () => {
          const result = await host.command(
            openshellBinaryPath,
            ["sandbox", "delete", sandboxName],
            {
              artifactName: "cleanup-cua-qualification-openshell-sandbox",
              captureLimitBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
              env: onboarding.env,
              redactionValues,
              timeoutMs: 15 * 60_000,
            },
          );
          if (
            result.exitCode !== 0 &&
            !/\bNotFound\b|\bNot Found\b|sandbox[^\n]*(?:not found|not present|does not exist)|no such sandbox/i.test(
              `${result.stdout}\n${result.stderr}`,
            )
          ) {
            throw new Error(`OpenShell qualification sandbox cleanup failed: ${result.stderr}`);
          }
        },
        nemoclaw: async () => {
          const result = await nemoclaw([sandboxName, "destroy", "--yes"], {
            artifactName: "cleanup-cua-qualification-nemoclaw-sandbox",
            captureLimitBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
            env: onboarding.env,
            redactionValues,
            timeoutMs: 15 * 60_000,
          });
          if (
            result.exitCode !== 0 &&
            !/Sandbox '.+' does not exist|Run 'nemoclaw onboard' to create one|sandbox .* not found|no such sandbox/i.test(
              `${result.stdout}\n${result.stderr}`,
            )
          ) {
            throw new Error(`NemoClaw qualification sandbox cleanup failed: ${result.stderr}`);
          }
        },
      });

      progress.phase("onboard the candidate through the canonical public NemoCUA path");
      const onboard = await nemoclaw(
        [
          "onboard",
          "--agent",
          "nemocua",
          "--name",
          sandboxName,
          "--fresh",
          "--non-interactive",
          "--yes",
        ],
        {
          artifactName: "cua-qualification-canonical-onboard",
          captureLimitBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
          env: onboarding.env,
          redactionValues,
          timeoutMs: 15 * 60_000,
        },
      );
      expect(onboard.exitCode, onboard.stderr).toBe(0);

      progress.phase(
        "verify onboarding created one OpenShell sandbox and public candidate readiness",
      );
      const openshellInventory = await host.command(
        openshellBinaryPath,
        ["sandbox", "list", "-o", "json"],
        {
          artifactName: "cua-qualification-post-onboard-openshell-inventory",
          captureLimitBytes: CUA_QUALIFICATION_OPENSHELL_INVENTORY_MAX_BYTES,
          env: onboarding.env,
          redactionValues,
          timeoutMs: 30_000,
        },
      );
      expect(openshellInventory.exitCode, openshellInventory.stderr).toBe(0);
      const postOnboardInventoryNames = parseCuaQualificationOpenShellInventory(
        openshellInventory.stdout,
      );
      if (preOnboardInventoryNames) {
        assertCuaQualificationInventoryTransition(
          preOnboardInventoryNames,
          postOnboardInventoryNames,
          sandboxName,
        );
      } else {
        assertCuaQualificationSingletonInventory(postOnboardInventoryNames, sandboxName);
      }
      const publicStatus = await nemoclaw([sandboxName, "status", "--json"], {
        artifactName: "cua-qualification-public-candidate-status",
        captureLimitBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
        env: onboarding.env,
        redactionValues,
        timeoutMs: 30_000,
      });
      expect(publicStatus.exitCode, publicStatus.stderr).toBe(0);
      const statusValue = JSON.parse(publicStatus.stdout) as Record<string, unknown>;
      expect(statusValue.agent).toBe("nemocua");
      const bindings: CuaCandidateRuntimeBindings = {
        sourceRevision,
        sourceClean,
        runtimeManifestDigest: `sha256:${loadedManifest.sha256}`,
        environmentDigest: rawEnvironment.sha256,
        bundleReceiptDigest: rawBundleReceipt.sha256,
      };
      assertCuaCandidateRuntimeBindings(receipt, statusValue.cuaRuntime, bindings);
      const runtime = parseCuaRuntimeReadiness(statusValue.cuaRuntime);
      candidateReady = true;
      const readinessDigest = getCuaRuntimeReadinessDigest(runtime);

      progress.phase("probe the image-provided target channel through the isolated artifact UID");
      const probeTargetChannel = async (artifactName: string): Promise<void> => {
        const targetChannelProbe = await host.command(
          artifactRunnerPath!,
          [
            "--require-target-channel",
            "--artifact-sha256",
            targetChannelProbeDigest.slice("sha256:".length),
            "--",
            targetChannelProbePath,
            "--isolated",
            String(artifactGid),
            environment.targetChannel.serviceBundleDigest,
            environment.targetChannel.targetImageDigest,
          ],
          {
            artifactName,
            captureLimitBytes: CUA_QUALIFICATION_ARTIFACT_OUTPUT_MAX_BYTES,
            env: artifactEnv,
            redactionValues,
            timeoutMs: 10_000,
          },
        );
        expect(targetChannelProbe.exitCode, targetChannelProbe.stderr).toBe(0);
        expect(JSON.parse(targetChannelProbe.stdout)).toEqual(environment.targetChannel);
      };
      await probeTargetChannel("cua-qualification-target-channel-identity-initial");
      expect(environment.targetChannel).toEqual(receipt.targetChannel);

      await runCuaDenial(
        nemoclaw,
        "target-adapter-substitution",
        ["target", "health", sandboxName, "--adapter", unregisteredAdapterPath],
        runtimeEnv,
        redactionValues,
        receipt,
        exercisedDenials,
      );
      await runCuaDenial(
        nemoclaw,
        "task-adapter-substitution",
        [
          "task",
          "status",
          sandboxName,
          "--adapter",
          unregisteredAdapterPath,
          "--task-id",
          "cua-denial-probe",
        ],
        runtimeEnv,
        redactionValues,
        receipt,
        exercisedDenials,
      );
      await runCuaDenial(
        nemoclaw,
        "security-adapter-substitution",
        ["security", "verify", sandboxName, "--adapter", unregisteredAdapterPath],
        runtimeEnv,
        redactionValues,
        receipt,
        exercisedDenials,
      );

      progress.phase("exercise every required target lifecycle operation");
      const initialDestroy = await runLifecycle("target.destroy.initial", [
        "target",
        "destroy",
        sandboxName,
        "--adapter",
        adapters.target.path,
      ]);
      expect(parseCuaTargetAttachment(initialDestroy).status).toBe("detached");
      const attached = expectAttachedTarget(
        await runLifecycle("target.attach", [
          "target",
          "attach",
          sandboxName,
          "--adapter",
          adapters.target.path,
          "--target-manifest",
          targetManifestPath,
        ]),
        receipt,
        readinessDigest,
      );
      expectAttachedTarget(
        await runLifecycle("target.status", ["target", "status", sandboxName]),
        receipt,
        readinessDigest,
      );
      expectAttachedTarget(
        await runLifecycle("target.health", [
          "target",
          "health",
          sandboxName,
          "--adapter",
          adapters.target.path,
        ]),
        receipt,
        readinessDigest,
      );
      await exercisePolicyBoundaryDenial({
        host,
        nemoclaw,
        openshellBinaryPath,
        sandboxName,
        securityAdapterPath: adapters.security.path,
        runtimeEnv,
        redactionValues,
        receipt,
        exercisedDenials,
      });

      progress.phase("exercise every required security lifecycle operation");
      const verified = parseCuaSecurityAttestation(
        await runLifecycle("security.verify", [
          "security",
          "verify",
          sandboxName,
          "--adapter",
          adapters.security.path,
        ]),
      );
      expect(verified.status).toBe("enforced");
      const securityStatus = parseCuaSecurityAttestation(
        await runLifecycle("security.status", ["security", "status", sandboxName]),
      );
      expect(securityStatus).toEqual(verified);
      const boundStatus = await nemoclaw([sandboxName, "status", "--json"], {
        artifactName: "cua-qualification-public-bound-status",
        captureLimitBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
        env: runtimeEnv,
        redactionValues,
        timeoutMs: 30_000,
      });
      expect(boundStatus.exitCode, boundStatus.stderr).toBe(0);
      assertCuaQualificationStatusBindings(
        receipt,
        JSON.parse(boundStatus.stdout) as unknown,
        bindings,
      );

      progress.phase("exercise every required task lifecycle operation");
      const exerciseScenario = async (
        scenario: (typeof receipt.scenarios)[number],
        scenarioTarget: CuaTargetAttachment,
        epoch: "initial",
      ): Promise<void> => {
        const scenarioBinding = {
          scenario: scenario.id,
          taskId: scenario.taskId,
          sandboxName,
          targetIdentityDigest: scenarioTarget.target!.identityDigest,
          runtimeReadinessDigest: readinessDigest,
        } as const;
        const fixtureArgs = buildCuaQualificationFixtureArgs(scenarioBinding);
        const forbiddenArtifactInputs = [
          taskInputPath,
          sourceReceiptPath,
          sourceRawReceipt.consumedPath,
          scenario.fixtureStateDigest,
          scenario.stateDigest,
          ...scenario.evidenceDigests,
        ];
        const fixtureInputs = JSON.stringify({ argv: fixtureArgs, env: artifactEnv });
        expect(
          forbiddenArtifactInputs.every((value) => !fixtureInputs.includes(value)),
          "fixture argv and env must not inject receipt paths or expected observations",
        ).toBe(true);
        const fixtureSetup = await host.command(
          artifactRunnerPath!,
          [
            "--require-target-channel",
            "--artifact-sha256",
            sourceReceipt.components.fixture.slice("sha256:".length),
            "--ingress-task-input",
            taskInputPath,
            "--ingress-task-input-sha256",
            expectedTaskInputSha256,
            "--",
            fixturePath,
            ...fixtureArgs,
          ],
          {
            artifactName: `cua-qualification-fixture-${epoch}-${scenario.id}`,
            captureLimitBytes: CUA_QUALIFICATION_ARTIFACT_OUTPUT_MAX_BYTES,
            env: artifactEnv,
            redactionValues,
            timeoutMs: 30_000,
          },
        );
        expect(fixtureSetup.exitCode, fixtureSetup.stderr).toBe(0);
        assertCuaQualificationFixtureBinding(scenario, scenarioBinding, fixtureSetup.stdout);
        expect(
          assertCuaQualificationTaskInputExpectationFree(taskInputPath, receipt, [
            sourceReceiptPath,
            sourceRawReceipt.consumedPath,
          ]).sha256,
        ).toBe(`sha256:${expectedTaskInputSha256}`);
        exercisedFixtures.add(scenario.taskId);

        const taskStart = expectAttachedTarget(
          await runLifecycle(`task.start.${epoch}.${scenario.id}`, [
            "task",
            "start",
            sandboxName,
            "--adapter",
            adapters.task.path,
            "--task-id",
            scenario.taskId,
            "--mode",
            "headless",
            "--input-file",
            taskInputPath,
          ]),
          receipt,
          readinessDigest,
        );
        expect(taskStart.activeTask?.taskId).toBe(scenario.taskId);
        const taskStatus = expectAttachedTarget(
          await runLifecycle(`task.status.${epoch}`, [
            "task",
            "status",
            sandboxName,
            "--adapter",
            adapters.task.path,
            "--task-id",
            scenario.taskId,
          ]),
          receipt,
          readinessDigest,
        );
        expect(taskStatus.activeTask?.taskId).toBe(scenario.taskId);

        const taskResult = expectTaskResultBindings(
          await runLifecycle(`task.result.${epoch}.${scenario.id}`, [
            "task",
            "result",
            sandboxName,
            "--adapter",
            adapters.task.path,
            "--task-id",
            scenario.taskId,
          ]),
          scenario.taskId,
          "succeeded",
          runtime,
          scenarioTarget.target!,
        );
        const oracleArgs = buildCuaQualificationOracleArgs(scenarioBinding);
        const oracleInputs = JSON.stringify({ argv: oracleArgs, env: artifactEnv });
        expect(
          forbiddenArtifactInputs.every((value) => !oracleInputs.includes(value)),
          "oracle argv and env must not inject receipt paths or expected observations",
        ).toBe(true);
        const oracleObservation = await host.command(
          artifactRunnerPath!,
          [
            "--require-target-channel",
            "--artifact-sha256",
            sourceReceipt.components.oracle.slice("sha256:".length),
            "--",
            oraclePath,
            ...oracleArgs,
          ],
          {
            artifactName: `cua-qualification-oracle-${epoch}-${scenario.id}`,
            captureLimitBytes: CUA_QUALIFICATION_ARTIFACT_OUTPUT_MAX_BYTES,
            env: artifactEnv,
            redactionValues,
            timeoutMs: 30_000,
          },
        );
        expect(oracleObservation.exitCode, oracleObservation.stderr).toBe(0);
        expect(
          assertCuaQualificationObservedScenarioBindings(
            receipt,
            scenario,
            scenarioBinding,
            oracleObservation.stdout,
            taskResult,
          ),
        ).toEqual(taskResult);
        exercisedOracles.add(scenario.taskId);
      };
      for (const scenario of receipt.scenarios) {
        await exerciseScenario(scenario, attached, "initial");
      }

      const cancelledTaskId = "cua-required-cancel-probe";
      if (receipt.scenarios.some(({ taskId }) => taskId === cancelledTaskId)) {
        throw new Error("qualification receipt task IDs collide with the cancellation probe");
      }
      expectAttachedTarget(
        await runLifecycle("task.start.cancel", [
          "task",
          "start",
          sandboxName,
          "--adapter",
          adapters.task.path,
          "--task-id",
          cancelledTaskId,
          "--mode",
          "headless",
          "--input-file",
          taskInputPath,
        ]),
        receipt,
        readinessDigest,
      );
      expectTaskResultBindings(
        await runLifecycle("task.cancel", [
          "task",
          "cancel",
          sandboxName,
          "--adapter",
          adapters.task.path,
          "--task-id",
          cancelledTaskId,
        ]),
        cancelledTaskId,
        "cancelled",
        runtime,
        attached.target!,
      );

      progress.phase("re-observe complete GPU toolkit and immutable probe image identity");
      const liveNames = await host.command(
        hostTools.nvidiaSmi.path,
        ["--query-gpu=name", "--format=csv,noheader"],
        { artifactName: "cua-qualification-gpu-models", timeoutMs: 10_000 },
      );
      const liveDrivers = await host.command(
        hostTools.nvidiaSmi.path,
        ["--query-gpu=driver_version", "--format=csv,noheader"],
        { artifactName: "cua-qualification-gpu-drivers", timeoutMs: 10_000 },
      );
      const liveSummary = await host.command(hostTools.nvidiaSmi.path, [], {
        artifactName: "cua-qualification-gpu-summary",
        captureLimitBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
        timeoutMs: 10_000,
      });
      const liveToolkit = await host.command(hostTools.nvidiaCtk.path, ["--version"], {
        artifactName: "cua-qualification-container-toolkit",
        timeoutMs: 10_000,
      });
      const liveProbeImage = await host.command(
        hostTools.docker.path,
        ["image", "inspect", "--format", "{{json .RepoDigests}}", probeImage],
        {
          artifactName: "cua-qualification-probe-image",
          captureLimitBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
          timeoutMs: 30_000,
        },
      );
      const probeNames = await host.command(
        hostTools.docker.path,
        buildCuaQualificationGpuProbeArgs(probeImage, environment.gpu.probeImageDigest, "model"),
        { artifactName: "cua-qualification-probe-gpu-models", timeoutMs: 60_000 },
      );
      const probeDrivers = await host.command(
        hostTools.docker.path,
        buildCuaQualificationGpuProbeArgs(probeImage, environment.gpu.probeImageDigest, "driver"),
        { artifactName: "cua-qualification-probe-gpu-drivers", timeoutMs: 60_000 },
      );
      const probeSummary = await host.command(
        hostTools.docker.path,
        buildCuaQualificationGpuProbeArgs(probeImage, environment.gpu.probeImageDigest, "summary"),
        {
          artifactName: "cua-qualification-probe-gpu-summary",
          captureLimitBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
          timeoutMs: 60_000,
        },
      );
      for (const result of [
        liveNames,
        liveDrivers,
        liveSummary,
        liveToolkit,
        liveProbeImage,
        probeNames,
        probeDrivers,
        probeSummary,
      ]) {
        expect(result.exitCode, result.stderr).toBe(0);
      }
      const hostModels = uniqueLines(liveNames.stdout);
      const hostDrivers = uniqueLines(liveDrivers.stdout);
      const probeModels = uniqueLines(probeNames.stdout);
      const probeDriverVersions = uniqueLines(probeDrivers.stdout);
      const hostGpuCount = liveNames.stdout.split(/\r?\n/).filter((line) => line.trim()).length;
      const probeGpuCount = probeNames.stdout.split(/\r?\n/).filter((line) => line.trim()).length;
      expect(hostModels).toHaveLength(1);
      expect(hostDrivers).toHaveLength(1);
      expect(probeGpuCount).toBe(hostGpuCount);
      expect(probeModels).toEqual(hostModels);
      expect(probeDriverVersions).toEqual(hostDrivers);
      const cudaVersion = /CUDA Version:\s*([0-9][0-9.]*)/.exec(liveSummary.stdout)?.[1];
      const probeCudaVersion = /CUDA Version:\s*([0-9][0-9.]*)/.exec(probeSummary.stdout)?.[1];
      expect(probeCudaVersion).toBe(cudaVersion);
      const toolkitVersion = /[0-9]+\.[0-9]+\.[0-9]+/.exec(liveToolkit.stdout)?.[0];
      const repoDigests = JSON.parse(liveProbeImage.stdout) as unknown;
      const probeImageDigest = assertCuaQualificationProbeImageReference(probeImage, repoDigests);
      const hostModel = hostModels[0];
      const hostDriver = hostDrivers[0];
      const probeModel = probeModels[0];
      const probeDriver = probeDriverVersions[0];
      if (
        !hostModel ||
        !hostDriver ||
        !probeModel ||
        !probeDriver ||
        !cudaVersion ||
        !probeCudaVersion ||
        !toolkitVersion
      ) {
        throw new Error("live GPU identity discovery returned an incomplete record");
      }
      assertCuaQualificationGpuBindings(environment, receipt, {
        host: {
          count: hostGpuCount,
          model: hostModel,
          driverVersion: hostDriver,
          cudaVersion,
          containerToolkitVersion: toolkitVersion,
          probeImageDigest,
        },
        probe: {
          count: probeGpuCount,
          model: probeModel,
          driverVersion: probeDriver,
          cudaVersion: probeCudaVersion,
          probeImageDigest,
        },
      });
      await probeTargetChannel("cua-qualification-target-channel-identity-final");

      progress.phase(
        "verify final target and canonical sandbox cleanup with unchanged authority payload",
      );
      expect(
        parseCuaTargetAttachment(
          await runLifecycle("target.detach", [
            "target",
            "detach",
            sandboxName,
            "--adapter",
            adapters.target.path,
          ]),
        ).status,
      ).toBe("detached");
      expectAttachedTarget(
        await runLifecycle("target.attach.cleanup", [
          "target",
          "attach",
          sandboxName,
          "--adapter",
          adapters.target.path,
          "--target-manifest",
          targetManifestPath,
        ]),
        receipt,
        readinessDigest,
      );
      const finalTargetDestroy = await runLifecycle("target.destroy", [
        "target",
        "destroy",
        sandboxName,
        "--adapter",
        adapters.target.path,
      ]);
      expect(parseCuaTargetAttachment(finalTargetDestroy).status).toBe("detached");
      expect([...exercisedOperations].sort()).toEqual(
        [
          ...runtime.targetOperations,
          ...runtime.securityOperations,
          ...runtime.taskOperations,
        ].sort(),
      );
      expect([...exercisedDenials].sort()).toEqual(receipt.denials.map(({ id }) => id).sort());
      const qualifiedScenarioTaskIds = receipt.scenarios.map(({ taskId }) => taskId).sort();
      expect([...exercisedFixtures].sort()).toEqual(qualifiedScenarioTaskIds);
      expect([...exercisedOracles].sort()).toEqual(qualifiedScenarioTaskIds);
      assertCuaQualificationGitCheckout(qualificationRoot, bindings.sourceRevision);
      assertCuaQualificationCliInvocationUnchanged(cliInvocation);
      assertCuaQualificationHostToolBindingsUnchanged(hostTools);
      expect(getCuaAdapterBindings(runtimeEnv)).toEqual(adapters);
      expect(resolveCuaQualificationArtifactRunner(runtimeEnv)).toBe(artifactRunnerPath);
      verifyCuaRuntimeAuthorityPayload(runtimeEnv);
      expect(readBoundedCuaQualificationJson(environmentPath).sha256).toBe(rawEnvironment.sha256);
      expect(fs.existsSync(sourceReceiptPath)).toBe(false);
      expect(fs.existsSync(sourceRawReceipt.consumedPath)).toBe(false);
      expect(readBoundedCuaQualificationJson(bundleReceiptPath).sha256).toBe(
        rawBundleReceipt.sha256,
      );
      expect(readBoundedCuaQualificationJson(targetManifestPath).sha256).toBe(
        rawTargetManifest.sha256,
      );
      expect(hashBoundedCuaQualificationFile(taskInputPath).sha256).toBe(
        `sha256:${expectedTaskInputSha256}`,
      );
      expect(
        hashBoundedCuaQualificationFile(launchableScriptPath, MAX_COMPONENT_BYTES).sha256,
      ).toBe(receipt.launchable.digest);
      expect(hashBoundedCuaQualificationFile(openshellBinaryPath, MAX_COMPONENT_BYTES).sha256).toBe(
        receipt.components.openshell,
      );
      expect(hashBoundedCuaQualificationFile(fixturePath, MAX_COMPONENT_BYTES).sha256).toBe(
        receipt.components.fixture,
      );
      expect(hashBoundedCuaQualificationFile(oraclePath, MAX_COMPONENT_BYTES).sha256).toBe(
        receipt.components.oracle,
      );
      expect(
        hashBoundedCuaQualificationFile(isolationProbePath, CUA_QUALIFICATION_FILE_MAX_BYTES)
          .sha256,
      ).toBe(isolationProbeDigest);
      expect(
        hashBoundedCuaQualificationFile(targetChannelProbePath, CUA_QUALIFICATION_FILE_MAX_BYTES)
          .sha256,
      ).toBe(targetChannelProbeDigest);

      const sandboxDestroy = await nemoclaw([sandboxName, "destroy", "--yes"], {
        artifactName: "cua-qualification-final-nemoclaw-destroy",
        captureLimitBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
        env: onboarding.env,
        redactionValues,
        timeoutMs: 15 * 60_000,
      });
      expect(sandboxDestroy.exitCode, sandboxDestroy.stderr).toBe(0);
      candidateReady = false;
      const absentStatus = await nemoclaw([sandboxName, "status", "--json"], {
        artifactName: "cua-qualification-final-nemoclaw-status-absent",
        captureLimitBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
        env: onboarding.env,
        redactionValues,
        timeoutMs: 30_000,
      });
      expect(absentStatus.exitCode).not.toBe(0);
      expect(`${absentStatus.stdout}\n${absentStatus.stderr}`).toMatch(
        /Sandbox '.+' does not exist|Run 'nemoclaw onboard' to create one|sandbox .* not found|no such sandbox/i,
      );
      assertCuaQualificationLocalRegistryAbsent({ home: onboardingHome, sandboxName });
      const finalOpenShellInventory = await host.command(
        openshellBinaryPath,
        ["sandbox", "list", "-o", "json"],
        {
          artifactName: "cua-qualification-final-openshell-inventory-absent",
          captureLimitBytes: CUA_QUALIFICATION_OPENSHELL_INVENTORY_MAX_BYTES,
          env: onboarding.env,
          redactionValues,
          timeoutMs: 30_000,
        },
      );
      expect(finalOpenShellInventory.exitCode, finalOpenShellInventory.stderr).toBe(0);
      expect(parseCuaQualificationOpenShellInventory(finalOpenShellInventory.stdout)).not.toContain(
        sandboxName,
      );
      assertCuaQualificationCleanupBindings(receipt, {
        targetDestroy: finalTargetDestroy,
        sandboxName,
        nemoclawDestroy: "completed",
        nemoclawStatus: "absent",
        nemoclawRegistry: "absent",
        openshellInventory: "absent",
      });
      assertCuaQualificationGitCheckout(qualificationRoot, bindings.sourceRevision);
      assertCuaQualificationCliInvocationUnchanged(cliInvocation);
      assertCuaQualificationHostToolBindingsUnchanged(hostTools);
      verifyCuaRuntimeAuthorityPayload(runtimeEnv);
      expect(hashBoundedCuaQualificationFile(openshellBinaryPath, MAX_COMPONENT_BYTES).sha256).toBe(
        receipt.components.openshell,
      );
    } finally {
      if (candidateReady) {
        const result = await nemoclaw(
          [
            "sandbox",
            "cua",
            "target",
            "destroy",
            sandboxName,
            "--adapter",
            adapters.target.path,
            "--json",
          ],
          {
            artifactName: "cleanup-cua-qualification-target",
            captureLimitBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
            env: runtimeEnv,
            redactionValues,
            timeoutMs: 90_000,
          },
        );
        if (result.exitCode !== 0) {
          throw new Error(`CUA qualification target cleanup failed: ${result.stderr}`);
        }
      }
    }
  });
});
