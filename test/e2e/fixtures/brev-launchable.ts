// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ArtifactSink } from "./artifacts.ts";
import type { HostCliClient } from "./clients/host.ts";
import { resultText } from "./clients/command.ts";
import type { SecretStore } from "./secrets.ts";
import type { ShellProbeResult } from "./shell-probe.ts";

export interface BrevWorkspaceRecord {
  id: string;
  name: string;
  status: string;
  buildStatus: string;
  shellStatus: string;
}

export interface BrevRuntimeIdentity {
  bootImage: string;
  imageRepositorySha: string;
  provisionSha: string;
  repoClean: boolean;
  repoSha: string;
  runtimeOverrides: boolean;
  sourcePath: string;
  sourceRepository: string;
}

export interface StagingHandoff {
  bootImage: string;
  imageRepositorySha: string;
  nemoclawSha: string;
  producerRunId: string;
}

export interface BrevWorkspaceOwnership {
  accepted: boolean;
  createRequested: boolean;
  id?: string;
  name: string;
}

export interface BrevLaunchableFixtureOptions {
  artifacts: ArtifactSink;
  host: HostCliClient;
  pollMs?: number;
  secrets: SecretStore;
}

const IMAGE_REPOSITORY = "brevdev/nemoclaw-image";
const IMAGE_WORKFLOW = "build-launchable-e2e-image.yml";
const DEFAULT_POLL_MS = 15_000;
export const DEFAULT_BREV_WORKSPACE_DELETE_TIMEOUT_MS = 12 * 60_000;

export class BrevLaunchableFixture {
  private readonly artifacts: ArtifactSink;
  private readonly host: HostCliClient;
  private readonly secrets: SecretStore;
  private readonly pollMs: number;

  constructor(options: BrevLaunchableFixtureOptions) {
    this.artifacts = options.artifacts;
    this.host = options.host;
    this.secrets = options.secrets;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  }

  async resolveLatestStagingHandoff(): Promise<StagingHandoff> {
    const token = this.secrets.required("NEMOCLAW_IMAGE_DISPATCH_TOKEN");
    const runs = await this.host.command(
      "gh",
      [
        "api",
        `repos/${IMAGE_REPOSITORY}/actions/workflows/${IMAGE_WORKFLOW}/runs?branch=main&event=workflow_dispatch&status=success&per_page=20`,
      ],
      {
        artifactName: "brev-staging-producer-runs",
        env: { GH_TOKEN: token },
        redactionValues: [token],
        timeoutMs: 60_000,
      },
    );
    expectExitZero(runs, "list successful staging producer runs");
    const parsed = JSON.parse(runs.stdout) as {
      workflow_runs?: Array<{ id?: unknown; created_at?: unknown; display_title?: unknown }>;
    };
    const candidates = (parsed.workflow_runs ?? [])
      .filter(
        (run) =>
          typeof run.id === "number" &&
          typeof run.created_at === "string" &&
          typeof run.display_title === "string" &&
          run.display_title.startsWith("Build Launchable E2E image for NemoClaw "),
      )
      .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
    const latest = candidates.at(-1);
    if (!latest || typeof latest.id !== "number") {
      throw new Error("latest successful staging image producer run is unavailable");
    }
    const producerRunId = String(latest.id);
    const handoffRoot = this.artifacts.pathFor("staging-handoff");
    fs.mkdirSync(handoffRoot, { recursive: true, mode: 0o700 });
    const download = await this.host.command(
      "gh",
      [
        "run",
        "download",
        producerRunId,
        "--repo",
        IMAGE_REPOSITORY,
        "--name",
        `nemoclaw-image-handoff-v1-${producerRunId}-1`,
        "--dir",
        handoffRoot,
      ],
      {
        artifactName: "brev-staging-handoff-download",
        env: { GH_TOKEN: token },
        redactionValues: [token],
        timeoutMs: 60_000,
      },
    );
    expectExitZero(download, "download latest staging image handoff");
    const manifestPath = path.join(handoffRoot, "nemoclaw-image-manifest.v1.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    assertStagingManifest(manifest, producerRunId);
    return {
      producerRunId,
      bootImage: `projects/${String(manifest.project)}/global/images/${String(manifest.imageName)}`,
      imageRepositorySha: String(manifest.imageRepositorySha),
      nemoclawSha: String(manifest.nemoclawSha),
    };
  }

  ownership(name: string): BrevWorkspaceOwnership {
    validateName(name);
    return { name, createRequested: false, accepted: false };
  }

  async create(
    ownership: BrevWorkspaceOwnership,
    launchableId: string,
  ): Promise<BrevWorkspaceRecord> {
    const name = ownership.name;
    validateName(name);
    if (!/^env-[A-Za-z0-9]+$/u.test(launchableId)) {
      throw new Error("Brev Launchable ID is invalid");
    }
    const existing = await this.workspace(name);
    if (existing) throw new Error(`Brev workspace already exists: ${name}`);
    ownership.createRequested = true;
    const create = await this.host.command(
      "brev",
      ["create", name, "--launchable", launchableId, "--detached", "--timeout", "900"],
      {
        artifactName: "brev-workspace-create",
        timeoutMs: 15 * 60_000,
      },
    );
    expectExitZero(create, "create staging Brev workspace");
    ownership.accepted = true;
    const workspace = await this.waitForWorkspace(ownership, 20 * 60_000);
    return workspace;
  }

  async waitForExec(name: string, timeoutMs = 15 * 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const result = await this.exec(name, "true", {
        artifactName: "brev-exec-readiness",
        persistArtifacts: false,
        timeoutMs: Math.min(30_000, remaining),
      });
      if (result.exitCode === 0) return;
      await delay(Math.min(this.pollMs, Math.max(1, deadline - Date.now())));
    }
    throw new Error("Brev exec readiness timed out");
  }

  async exec(
    name: string,
    command: string,
    options: Parameters<HostCliClient["command"]>[2] = {},
  ): Promise<ShellProbeResult> {
    return this.host.command("brev", ["exec", name, command], options);
  }

  async execScript(
    name: string,
    script: string,
    options: Parameters<HostCliClient["command"]>[2] = {},
  ): Promise<ShellProbeResult> {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-brev-script-"));
    fs.chmodSync(directory, 0o700);
    const file = path.join(directory, "run.sh");
    fs.writeFileSync(file, script, { mode: 0o600 });
    try {
      return await this.host.command("brev", ["exec", name, `@${file}`], options);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  async verifyIdentity(name: string, expected: StagingHandoff): Promise<BrevRuntimeIdentity> {
    const result = await this.exec(name, identityCommand(), {
      artifactName: "brev-runtime-identity",
      timeoutMs: 5 * 60_000,
    });
    expectExitZero(result, "read staging runtime identity");
    const identity = JSON.parse(lastJsonLine(result.stdout)) as BrevRuntimeIdentity;
    if (
      identity.sourceRepository !== "NVIDIA/NemoClaw" ||
      identity.sourcePath !== "/opt/nemoclaw-image/NemoClaw" ||
      identity.provisionSha !== expected.nemoclawSha ||
      identity.repoSha !== expected.nemoclawSha ||
      identity.imageRepositorySha !== expected.imageRepositorySha ||
      identity.bootImage !== expected.bootImage ||
      identity.repoClean !== true ||
      identity.runtimeOverrides !== false
    ) {
      throw new Error("standing Launchable runtime identity does not match the staging handoff");
    }
    await this.artifacts.writeJson("brev-runtime-identity.json", identity);
    return identity;
  }

  async delete(
    ownership: BrevWorkspaceOwnership,
    timeoutMs = DEFAULT_BREV_WORKSPACE_DELETE_TIMEOUT_MS,
  ): Promise<void> {
    if (!ownership.createRequested) return;
    const name = ownership.name;
    const current = await this.workspace(name);
    if (current && !ownership.id) {
      throw new Error(`Brev workspace identity was not recorded before cleanup: ${name}`);
    }
    if (current && current.id !== ownership.id) {
      throw new Error(`Brev workspace identity changed before cleanup: ${name}`);
    }
    if (current) {
      await this.host.command("brev", ["delete", name], {
        artifactName: "brev-workspace-delete",
        timeoutMs: 60_000,
      });
    }
    const deadline = Date.now() + timeoutMs;
    let absent = 0;
    while (Date.now() < deadline) {
      const record = await this.workspace(name);
      absent = record ? 0 : absent + 1;
      if (absent >= 2) {
        await this.artifacts.writeJson("brev-workspace-cleanup.json", {
          workspaceName: name,
          workspaceId: ownership.id ?? current?.id ?? "",
          status: "ABSENT",
        });
        return;
      }
      await this.host.command("brev", ["refresh"], {
        artifactName: "brev-cleanup-refresh",
        persistArtifacts: false,
        timeoutMs: 30_000,
      });
      await delay(Math.min(this.pollMs, Math.max(1, deadline - Date.now())));
    }
    throw new Error(`Brev workspace cleanup did not confirm absence: ${name}`);
  }

  private async waitForWorkspace(
    ownership: BrevWorkspaceOwnership,
    timeoutMs: number,
  ): Promise<BrevWorkspaceRecord> {
    const name = ownership.name;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const record = await this.workspace(name);
      if (record?.id) {
        if (ownership.id && record.id !== ownership.id) {
          throw new Error(`Brev workspace identity changed during readiness: ${name}`);
        }
        ownership.id ??= record.id;
      }
      if (
        record?.status === "RUNNING" &&
        record.shellStatus === "READY" &&
        record.buildStatus === "COMPLETED"
      ) {
        return record;
      }
      if (
        record &&
        /FAILURE|FAILED|ERROR|CREATE_FAILED/u.test(`${record.status}:${record.buildStatus}`)
      ) {
        throw new Error(
          `Brev workspace entered terminal state: ${record.status}:${record.buildStatus}`,
        );
      }
      await delay(Math.min(this.pollMs, Math.max(1, deadline - Date.now())));
    }
    throw new Error(`Brev workspace readiness timed out: ${name}`);
  }

  private async workspace(name: string): Promise<BrevWorkspaceRecord | null> {
    const result = await this.host.command("brev", ["ls", "--json"], {
      artifactName: "brev-workspace-list",
      persistArtifacts: false,
      timeoutMs: 30_000,
    });
    expectExitZero(result, "list Brev workspaces");
    const root = JSON.parse(result.stdout) as unknown;
    const rows = Array.isArray(root)
      ? root
      : root &&
          typeof root === "object" &&
          Array.isArray((root as { workspaces?: unknown }).workspaces)
        ? (root as { workspaces: unknown[] }).workspaces
        : [];
    const matches = rows
      .map(normalizeWorkspace)
      .filter((record): record is BrevWorkspaceRecord => record?.name === name);
    if (matches.length > 1) throw new Error(`Brev workspace name is ambiguous: ${name}`);
    return matches[0] ?? null;
  }
}

function normalizeWorkspace(value: unknown): BrevWorkspaceRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const name = record.name ?? record.workspaceName ?? record.instanceName;
  if (typeof name !== "string" || !name) return null;
  return {
    name,
    id: String(record.id ?? ""),
    status: String(record.status ?? ""),
    buildStatus: String(record.build_status ?? record.buildStatus ?? ""),
    shellStatus: String(record.shell_status ?? record.shellStatus ?? ""),
  };
}

function assertStagingManifest(manifest: Record<string, unknown>, producerRunId: string): void {
  const sha = /^[0-9a-f]{40}$/u;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== "nemoclaw-exact-image-manifest" ||
    manifest.imageRepository !== IMAGE_REPOSITORY ||
    manifest.producerWorkflow !== `.github/workflows/${IMAGE_WORKFLOW}` ||
    String(manifest.workflowRunId) !== producerRunId ||
    manifest.workflowRunAttempt !== 1 ||
    manifest.status !== "READY" ||
    manifest.channel !== "staging" ||
    manifest.variant !== "cpu" ||
    manifest.observedFamily !== "nemoclaw-brev-staging-cpu" ||
    typeof manifest.project !== "string" ||
    manifest.project.length === 0 ||
    typeof manifest.imageName !== "string" ||
    manifest.imageName.length === 0 ||
    typeof manifest.nemoclawSha !== "string" ||
    !sha.test(manifest.nemoclawSha) ||
    typeof manifest.imageRepositorySha !== "string" ||
    !sha.test(manifest.imageRepositorySha)
  ) {
    throw new Error("latest staging image handoff is invalid");
  }
}

function identityCommand(): string {
  return `set -euo pipefail
source_path=$(sudo -n jq -er .sourcePath /etc/nemoclaw/provision.json)
source_repository=$(sudo -n jq -er .sourceRepository /etc/nemoclaw/provision.json)
provision_sha=$(sudo -n jq -er .gitSha /etc/nemoclaw/provision.json)
image_repository_sha=$(sudo -n jq -er .imageRepositorySha /etc/nemoclaw/provision.json)
repo_sha=$(git -C "$source_path" rev-parse HEAD)
repo_clean=true
[ -n "$(git -C "$source_path" status --porcelain --untracked-files=normal)" ] && repo_clean=false
runtime_overrides=false
sudo -n test ! -e /etc/nemoclaw/runtime-overrides.json || runtime_overrides=true
boot_image=$(curl -fsS --max-time 10 -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/image)
jq -cn --arg sourceRepository "$source_repository" --arg sourcePath "$source_path" --arg provisionSha "$provision_sha" --arg imageRepositorySha "$image_repository_sha" --arg repoSha "$repo_sha" --arg bootImage "$boot_image" --argjson repoClean "$repo_clean" --argjson runtimeOverrides "$runtime_overrides" '{sourceRepository:$sourceRepository,sourcePath:$sourcePath,provisionSha:$provisionSha,imageRepositorySha:$imageRepositorySha,repoSha:$repoSha,bootImage:$bootImage,repoClean:$repoClean,runtimeOverrides:$runtimeOverrides}'`;
}

function lastJsonLine(text: string): string {
  const line = text
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) throw new Error("Brev runtime identity output is missing");
  return line;
}

function validateName(name: string): void {
  if (!/^[a-z][a-z0-9-]{0,62}$/u.test(name)) throw new Error("Brev workspace name is invalid");
}

function expectExitZero(result: ShellProbeResult, operation: string): void {
  if (result.exitCode !== 0) throw new Error(`${operation} failed: ${resultText(result)}`);
}

async function delay(ms: number): Promise<void> {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}
