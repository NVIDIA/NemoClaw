// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { AgentDefinition } from "../agent/defs";
import {
  CUA_CAPABILITIES,
  CUA_LIFECYCLE_SCHEMA_VERSION,
  CUA_TARGET_OPERATIONS,
  CUA_TASK_OPERATIONS,
  type CuaComponentIdentity,
  type CuaRuntimeReadiness,
} from "./contract";
import { parseCuaRuntimeReadiness } from "./schema";

const NEMOCUA_AGENT = "nemocua";
const ROOT = path.resolve(__dirname, "..", "..", "..");
const ARTIFACT_MANIFEST = "runtime-artifacts.json";
const POLICY_FILE = "policy-additions.yaml";
const TASK_PROTOCOL_FILE = path.join(ROOT, "schemas", "cua-lifecycle.schema.json");

type ArtifactIdentity = Readonly<{
  name: string;
  version: string;
}>;

type ArchiveArtifactIdentity = ArtifactIdentity &
  Readonly<{
    filename: string;
    sizeBytes: number;
    sha256: string;
    sourceRevision: string;
  }>;

type ImageArtifactIdentity = ArtifactIdentity &
  Readonly<{
    platform: "linux/amd64";
    digest: string;
  }>;

export interface CuaReleaseArtifactManifest {
  schemaVersion: 1;
  compatibility: {
    status: "qualified" | "awaiting-live-qualification";
    issue: number;
  };
  hostCli: ArchiveArtifactIdentity;
  sandboxImage: ImageArtifactIdentity;
  targetServices: ArchiveArtifactIdentity;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function readArchiveArtifactIdentity(value: unknown, label: string): ArchiveArtifactIdentity {
  if (!isObjectRecord(value)) throw new Error(`${label} must be an object`);
  const sha256 = requireString(value, "sha256", label);
  const sourceRevision = requireString(value, "sourceRevision", label);
  const sizeBytes = value.sizeBytes;
  if (!/^[a-f0-9]{64}$/.test(sha256) || !/^[a-f0-9]{40}$/.test(sourceRevision)) {
    throw new Error(`${label} must declare lowercase SHA-256 and source revision identities`);
  }
  if (!Number.isSafeInteger(sizeBytes) || Number(sizeBytes) <= 0) {
    throw new Error(`${label}.sizeBytes must be a positive safe integer`);
  }
  return {
    name: requireString(value, "name", label),
    version: requireString(value, "version", label),
    filename: requireString(value, "filename", label),
    sizeBytes: Number(sizeBytes),
    sha256,
    sourceRevision,
  };
}

function readImageArtifactIdentity(value: unknown, label: string): ImageArtifactIdentity {
  if (!isObjectRecord(value)) throw new Error(`${label} must be an object`);
  const digest = requireString(value, "digest", label);
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`${label} must declare one lowercase SHA-256 identity`);
  }
  if (value.platform !== "linux/amd64") {
    throw new Error(`${label}.platform must be linux/amd64`);
  }
  return {
    name: requireString(value, "name", label),
    version: requireString(value, "version", label),
    platform: "linux/amd64",
    digest,
  };
}

export function loadCuaReleaseArtifactManifest(
  agent: Pick<AgentDefinition, "name" | "agentDir">,
): CuaReleaseArtifactManifest {
  if (agent.name !== NEMOCUA_AGENT) {
    throw new Error(`CUA runtime artifacts are not defined for agent '${agent.name}'`);
  }
  const manifestPath = path.join(agent.agentDir, ARTIFACT_MANIFEST);
  const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!isObjectRecord(parsed) || parsed.schemaVersion !== 1) {
    throw new Error("NemoCUA runtime artifacts must use schema version 1");
  }
  if (!isObjectRecord(parsed.compatibility)) {
    throw new Error("NemoCUA runtime artifacts must declare compatibility state");
  }
  const status = parsed.compatibility.status;
  if (status !== "qualified" && status !== "awaiting-live-qualification") {
    throw new Error("NemoCUA runtime artifact compatibility state is invalid");
  }
  if (!Number.isInteger(parsed.compatibility.issue) || parsed.compatibility.issue !== 7755) {
    throw new Error("NemoCUA runtime artifact compatibility must be owned by issue #7755");
  }
  return {
    schemaVersion: 1,
    compatibility: { status, issue: 7755 },
    hostCli: readArchiveArtifactIdentity(parsed.hostCli, "hostCli"),
    sandboxImage: readImageArtifactIdentity(parsed.sandboxImage, "sandboxImage"),
    targetServices: readArchiveArtifactIdentity(parsed.targetServices, "targetServices"),
  };
}

function fileIdentity(name: string, version: string, filePath: string): CuaComponentIdentity {
  return {
    name,
    version,
    digest: `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`,
    owner: "NVIDIA NemoClaw",
  };
}

function archiveComponent(identity: ArchiveArtifactIdentity, owner: string): CuaComponentIdentity {
  return {
    name: identity.name,
    version: identity.version,
    digest: `sha256:${identity.sha256}`,
    owner,
  };
}

function imageComponent(identity: ImageArtifactIdentity, owner: string): CuaComponentIdentity {
  return {
    name: identity.name,
    version: identity.version,
    digest: identity.digest,
    owner,
  };
}

export function buildCuaRuntimeReadiness(
  agent: Pick<AgentDefinition, "name" | "agentDir">,
  provider: string,
  model: string,
): CuaRuntimeReadiness {
  const artifacts = loadCuaReleaseArtifactManifest(agent);
  const policyPath = path.join(agent.agentDir, POLICY_FILE);
  const readiness: CuaRuntimeReadiness = {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "runtime-readiness",
    mode: "standalone",
    status: artifacts.compatibility.status === "qualified" ? "available" : "unavailable",
    components: {
      runtime: archiveComponent(artifacts.hostCli, "NVIDIA NemoCUA"),
      sandboxImage: imageComponent(artifacts.sandboxImage, "NVIDIA NemoCUA"),
      policy: fileIdentity("nemocua-policy", "1", policyPath),
      taskProtocol: fileIdentity(
        "nemoclaw-cua-lifecycle",
        CUA_LIFECYCLE_SCHEMA_VERSION,
        TASK_PROTOCOL_FILE,
      ),
    },
    inference: { provider, model },
    commands: { interactive: true, headless: true, version: true, smoke: true },
    limits: { targetsPerWorker: 1, activeTasksPerTarget: 1 },
    requiredCapabilities: [...CUA_CAPABILITIES],
    targetOperations: [...CUA_TARGET_OPERATIONS],
    taskOperations: [...CUA_TASK_OPERATIONS],
  };
  return parseCuaRuntimeReadiness(readiness);
}

export function requireQualifiedCuaRuntimeReadiness(
  agent: Pick<AgentDefinition, "name" | "agentDir">,
  provider: string,
  model: string,
): CuaRuntimeReadiness {
  const readiness = buildCuaRuntimeReadiness(agent, provider, model);
  if (readiness.status !== "available") {
    throw new Error(
      "NemoCUA release artifacts are pinned but have not passed live tuple qualification for issue #7755",
    );
  }
  return readiness;
}
