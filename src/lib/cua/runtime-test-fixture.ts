// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CuaQualificationEnvironment } from "./qualification-evidence";
import type { CuaPayloadFileIdentity, CuaRuntimeManifest } from "./runtime-manifest";

const CANDIDATE_COMMIT = "a".repeat(40);
const BUNDLE_SHA256 = "c".repeat(64);
const SANDBOX_IMAGE_DIGEST = `sha256:${"d".repeat(64)}`;
const TARGET_IMAGE_DIGEST = `sha256:${"e".repeat(64)}`;

function digest(bytes: Buffer | string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
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
    "  reason: Candidate install-and-inspect only",
    "",
  ].join("\n");
}

export interface CuaRuntimeTestFixture {
  root: string;
  manifestPath: string;
  environmentPath: string;
  openshellPath: string;
  env: NodeJS.ProcessEnv;
  manifest: CuaRuntimeManifest;
  candidateCommit: string;
  candidateEnvironment: CuaQualificationEnvironment;
  rewriteManifest: (mutate: (manifest: Record<string, unknown>) => void) => void;
  cleanup: () => void;
}

export function createCuaRuntimeTestFixture(
  input: {
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
    compatibility: {
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
      hostCli: { name: "nemocua-runtime", version: "1.0.0", ...payload.hostCli },
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
    qualificationEvidence: null,
  };

  const manifestPath = path.join(root, "runtime-manifest.json");
  const environmentPath = path.join(root, "cua-qualification-environment.json");
  const openshellPath = path.join(root, payload.openshell.filename);
  const env: NodeJS.ProcessEnv = {
    NEMOCLAW_CUA_ENABLED: "1",
    NEMOCLAW_CUA_RUNTIME_MANIFEST: manifestPath,
    NEMOCLAW_CUA_RUNTIME_MANIFEST_SHA256: "",
    NEMOCLAW_CUA_SANDBOX_IMAGE_REF: `registry.invalid/nemocua@${SANDBOX_IMAGE_DIGEST}`,
    NEMOCLAW_CUA_QUALIFICATION_ENVIRONMENT: environmentPath,
    NEMOCLAW_OPENSHELL_BIN: openshellPath,
  };

  const writeManifest = (): string => {
    const raw = JSON.stringify(manifest);
    const temporaryManifestPath = path.join(root, ".runtime-manifest.json.tmp");
    fs.writeFileSync(temporaryManifestPath, raw, { flag: "wx", mode: 0o444 });
    try {
      fs.renameSync(temporaryManifestPath, manifestPath);
    } catch (error) {
      fs.rmSync(temporaryManifestPath, { force: true });
      throw error;
    }
    const sha256 = digest(raw);
    env.NEMOCLAW_CUA_RUNTIME_MANIFEST_SHA256 = sha256;
    return sha256;
  };
  const manifestSha256 = writeManifest();
  const candidateEnvironment: CuaQualificationEnvironment = {
    schemaVersion: "1.0.0",
    kind: "cua-candidate-environment",
    nemoclawCommit: CANDIDATE_COMMIT,
    bundleReceiptSha256: BUNDLE_SHA256,
    runtimeManifestSha256: manifestSha256,
  };
  fs.writeFileSync(environmentPath, JSON.stringify(candidateEnvironment), { mode: 0o444 });

  return {
    root,
    manifestPath,
    environmentPath,
    openshellPath,
    env,
    manifest,
    candidateCommit: CANDIDATE_COMMIT,
    candidateEnvironment,
    rewriteManifest: (mutate) => {
      mutate(manifest as unknown as Record<string, unknown>);
      writeManifest();
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
