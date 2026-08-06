// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  CuaQualificationEnvironment,
  CuaQualificationReceipt,
} from "./qualification-evidence";
import type { CuaPayloadFileIdentity, CuaRuntimeManifest } from "./runtime-manifest";

const CANDIDATE_COMMIT = "a".repeat(40);
const FINAL_COMMIT = "b".repeat(40);
const BUNDLE_SHA256 = "c".repeat(64);
const SANDBOX_IMAGE_DIGEST = `sha256:${"d".repeat(64)}`;
const TARGET_IMAGE_DIGEST = `sha256:${"e".repeat(64)}`;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

export function canonicalJsonSha256(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function digest(bytes: Buffer | string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function fixtureDigest(label: string): string {
  return `sha256:${digest(`nemoclaw-cua-test-fixture:${label}`)}`;
}

function writePayload(root: string, filename: string, contents: string): CuaPayloadFileIdentity {
  const bytes = Buffer.from(contents);
  fs.writeFileSync(path.join(root, filename), bytes, {
    mode: filename.endsWith(".sh") ? 0o755 : 0o444,
  });
  return { filename, sizeBytes: bytes.length, sha256: digest(bytes) };
}

function agentManifest(): string {
  return [
    "name: nemocua",
    "display_name: NemoCUA",
    "description: NemoCUA terminal runtime",
    "binary_path: /usr/local/bin/nemocua",
    'version_command: "nemocua version"',
    "expected_version: 1.0.0",
    "version_scheme: semver",
    "runtime:",
    "  kind: terminal",
    "  interactive_command: nemocua interactive",
    "  headless_command: nemocua headless",
    "  smoke_commands:",
    "    - nemocua version",
    "    - nemocua smoke",
    "config:",
    "  dir: /sandbox/.nemocua",
    "  config_file: config.json",
    "  format: json",
    "state_dirs:",
    "  - nemocua-state",
    "device_pairing: false",
    "inference:",
    "  provider_type: openai_compatible",
    "  default_model: nvidia/nemotron-3-super-120b-a12b",
    "  proxy_support: implicit",
    "mcp:",
    "  support: disabled",
    "  reason: Managed lifecycle only",
    "",
  ].join("\n");
}

function environment(serviceBundleDigest: string): CuaQualificationEnvironment {
  return {
    schemaVersion: "1.0.0",
    kind: "cua-qualification-environment",
    launchable: {
      version: "1.0.0",
      digest: `sha256:${"1".repeat(64)}`,
    },
    gpu: {
      count: 1,
      model: "NVIDIA-H100",
      driverVersion: "580.1.2",
      cudaVersion: "13.0",
      containerToolkitVersion: "1.18.0",
      probeImageDigest: TARGET_IMAGE_DIGEST,
    },
    hostTools: {
      node: fixtureDigest("host-tool:node"),
      docker: fixtureDigest("host-tool:docker"),
      nvidiaSmi: fixtureDigest("host-tool:nvidia-smi"),
      nvidiaCtk: fixtureDigest("host-tool:nvidia-ctk"),
    },
    targetChannel: {
      schemaVersion: "1.0.0",
      kind: "cua-qualification-target-channel-identity",
      protocol: "cua.qualification.target-channel/v1",
      serviceBundleDigest,
      targetImageDigest: TARGET_IMAGE_DIGEST,
    },
    nemoclawCommit: CANDIDATE_COMMIT,
    bundleReceiptSha256: BUNDLE_SHA256,
  };
}

function receipt(
  env: CuaQualificationEnvironment,
  identities: {
    openshell: CuaPayloadFileIdentity;
    hostCli: CuaPayloadFileIdentity;
    targetServices: CuaPayloadFileIdentity;
    policy: CuaPayloadFileIdentity;
    target: CuaPayloadFileIdentity;
    task: CuaPayloadFileIdentity;
    security: CuaPayloadFileIdentity;
  },
  routeDigest: string,
): CuaQualificationReceipt {
  const scenario = () => {
    const stateDigest = fixtureDigest("browser:state");
    return {
      id: "browser" as const,
      taskId: "browser-task",
      status: "passed" as const,
      fixtureStateDigest: fixtureDigest("browser:fixture"),
      stateDigest,
      evidenceDigests: [stateDigest, fixtureDigest("browser:independent-evidence")],
    };
  };
  return {
    schemaVersion: "1.0.0",
    kind: "cua-qualification-receipt",
    status: "passed",
    launchable: env.launchable,
    gpu: env.gpu,
    hostTools: env.hostTools,
    targetChannel: env.targetChannel,
    nemoclawCommit: env.nemoclawCommit,
    bundleReceiptSha256: env.bundleReceiptSha256,
    inference: {
      provider: "nvidia",
      model: "nvidia/nemotron-3-super-120b-a12b",
      routeDigest,
    },
    components: {
      openshell: `sha256:${identities.openshell.sha256}`,
      runtime: `sha256:${identities.hostCli.sha256}`,
      sandboxImage: SANDBOX_IMAGE_DIGEST,
      targetAdapter: `sha256:${identities.target.sha256}`,
      targetImage: TARGET_IMAGE_DIGEST,
      serviceBundle: `sha256:${identities.targetServices.sha256}`,
      policy: `sha256:${identities.policy.sha256}`,
      taskProtocol: `sha256:${identities.task.sha256}`,
      securityVerifier: `sha256:${identities.security.sha256}`,
      fixture: `sha256:${"5".repeat(64)}`,
      oracle: `sha256:${"6".repeat(64)}`,
    },
    scenarios: [scenario()],
    denials: [
      { id: "target-adapter-substitution", outcomeDigest: `sha256:${"8".repeat(64)}` },
      { id: "task-adapter-substitution", outcomeDigest: `sha256:${"9".repeat(64)}` },
      { id: "security-adapter-substitution", outcomeDigest: `sha256:${"a".repeat(64)}` },
      { id: "policy-boundary-violation", outcomeDigest: `sha256:${"b".repeat(64)}` },
    ],
    cleanup: {
      targetDestroyObservationDigest: fixtureDigest("cleanup:target-destroy"),
      nemoclawDestroyObservationDigest: fixtureDigest("cleanup:nemoclaw-destroy"),
      nemoclawStatusAbsenceObservationDigest: fixtureDigest("cleanup:nemoclaw-status-absent"),
      nemoclawRegistryAbsenceObservationDigest: fixtureDigest("cleanup:nemoclaw-registry-absent"),
      openshellInventoryAbsenceObservationDigest: fixtureDigest(
        "cleanup:openshell-inventory-absent",
      ),
    },
  };
}

export interface CuaRuntimeTestFixture {
  root: string;
  manifestPath: string;
  environmentPath: string;
  openshellPath: string;
  env: NodeJS.ProcessEnv;
  manifest: CuaRuntimeManifest;
  candidateCommit: string;
  finalCommit: string;
  rewriteManifest: (mutate: (manifest: Record<string, unknown>) => void) => void;
  cleanup: () => void;
}

export function createCuaRuntimeTestFixture(
  input: {
    qualified?: boolean;
    routeDigest?: string;
    openshellContents?: string;
    targetAdapterContents?: string;
    taskAdapterContents?: string;
    securityAdapterContents?: string;
  } = {},
): CuaRuntimeTestFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-runtime-"));
  const payload = {
    openshell: writePayload(root, "openshell.sh", input.openshellContents ?? "#!/bin/sh\nexit 0\n"),
    manifest: writePayload(root, "manifest.yaml", agentManifest()),
    dockerfile: writePayload(
      root,
      "Dockerfile",
      "ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nCOPY agents/nemocua/nemocua-cli.tar.gz /tmp/nemocua-cli.tar.gz\n",
    ),
    baseDockerfile: writePayload(
      root,
      "Dockerfile.base",
      "ARG NEMOCUA_RUNTIME_IMAGE\nFROM ${NEMOCUA_RUNTIME_IMAGE}\n",
    ),
    policy: writePayload(root, "policy-additions.yaml", "version: 1\nnetwork_policies: {}\n"),
    hostCli: writePayload(root, "nemocua-cli.tar.gz", "host-cli-archive"),
    targetServices: writePayload(root, "target-services.tar.gz", "target-services-archive"),
    target: writePayload(
      root,
      "target-adapter.sh",
      input.targetAdapterContents ?? "#!/bin/sh\nexit 0\n",
    ),
    task: writePayload(root, "task-adapter.sh", input.taskAdapterContents ?? "#!/bin/sh\nexit 0\n"),
    security: writePayload(
      root,
      "security-adapter.sh",
      input.securityAdapterContents ?? "#!/bin/sh\nexit 0\n",
    ),
  };
  const qualificationEnvironment = environment(`sha256:${payload.targetServices.sha256}`);
  const qualificationReceipt = receipt(
    qualificationEnvironment,
    payload,
    input.routeDigest ?? `sha256:${"7".repeat(64)}`,
  );
  const qualified = input.qualified === true;
  const manifest: CuaRuntimeManifest = {
    schemaVersion: "1.0.0",
    kind: "cua-runtime-manifest",
    agent: {
      name: "nemocua",
      manifest: payload.manifest,
      dockerfile: payload.dockerfile,
      baseDockerfile: payload.baseDockerfile,
      policy: payload.policy,
    },
    compatibility: qualified
      ? {
          status: "qualified",
          issue: 7755,
          candidateSourceRevision: CANDIDATE_COMMIT,
          finalSourceRevision: FINAL_COMMIT,
          environmentSha256: canonicalJsonSha256(qualificationEnvironment),
          receiptSha256: canonicalJsonSha256(qualificationReceipt),
        }
      : {
          status: "candidate",
          issue: 7755,
          candidateSourceRevision: CANDIDATE_COMMIT,
        },
    bundleReceipt: {
      schema: "cua.release.bundle/v1",
      releaseId: "release-1",
      producerCommit: CANDIDATE_COMMIT,
      sha256: BUNDLE_SHA256,
    },
    artifacts: {
      hostCli: {
        name: "nemocua-runtime",
        version: "1.0.0",
        ...payload.hostCli,
      },
      sandboxImage: {
        name: "nemocua-sandbox",
        version: "1.0.0",
        platform: "linux/amd64",
        digest: SANDBOX_IMAGE_DIGEST,
      },
      targetImage: {
        name: "nemocua-target",
        version: "1.0.0",
        platform: "linux/amd64",
        digest: TARGET_IMAGE_DIGEST,
      },
      targetServices: {
        name: "nemocua-services",
        version: "1.0.0",
        ...payload.targetServices,
      },
      adapters: {
        target: { name: "target-adapter", version: "1.0.0", ...payload.target },
        task: { name: "task-adapter", version: "1.0.0", ...payload.task },
        security: { name: "security-adapter", version: "1.0.0", ...payload.security },
      },
    },
    qualificationEvidence: qualified
      ? { environment: qualificationEnvironment, receipt: qualificationReceipt }
      : null,
  };
  const manifestPath = path.join(root, "runtime-manifest.json");
  const environmentPath = path.join(root, "cua-qualification-environment.json");
  const openshellPath = path.join(root, payload.openshell.filename);
  fs.writeFileSync(environmentPath, JSON.stringify(qualificationEnvironment), { mode: 0o444 });

  const env: NodeJS.ProcessEnv = {
    NEMOCLAW_CUA_ENABLED: "1",
    NEMOCLAW_CUA_RUNTIME_MANIFEST: manifestPath,
    NEMOCLAW_CUA_RUNTIME_MANIFEST_SHA256: "",
    NEMOCLAW_CUA_SANDBOX_IMAGE_REF: `registry.invalid/nemocua@${SANDBOX_IMAGE_DIGEST}`,
    NEMOCLAW_CUA_QUALIFICATION_ENVIRONMENT: environmentPath,
    NEMOCLAW_OPENSHELL_BIN: openshellPath,
  };
  const writeManifest = (): void => {
    const raw = JSON.stringify(manifest);
    if (fs.existsSync(manifestPath)) fs.chmodSync(manifestPath, 0o644);
    fs.writeFileSync(manifestPath, raw, { mode: 0o444 });
    fs.chmodSync(manifestPath, 0o444);
    env.NEMOCLAW_CUA_RUNTIME_MANIFEST_SHA256 = digest(raw);
  };
  writeManifest();

  return {
    root,
    manifestPath,
    environmentPath,
    openshellPath,
    env,
    manifest,
    candidateCommit: CANDIDATE_COMMIT,
    finalCommit: FINAL_COMMIT,
    rewriteManifest: (mutate) => {
      mutate(manifest as unknown as Record<string, unknown>);
      writeManifest();
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
