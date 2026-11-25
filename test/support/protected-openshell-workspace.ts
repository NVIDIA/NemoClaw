// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import YAML from "yaml";
import { candidateSdkFixture } from "./candidate-openshell-sdk";
import { fixture as approvalFixture, identity } from "../helpers/candidate-openshell-trust";
import {
  CANDIDATE_OPENSHELL_SOURCES,
  CANDIDATE_OPENSHELL_TRUST_PATH,
} from "../../tools/e2e/candidate-openshell-trust.mts";
import {
  readOpenShellTrustRegistry,
  validateInstallerSources,
  validateOpenShellFeatureGateSource,
} from "../../scripts/checks/extract-installer-pins.mts";

const sources = [
  "nemoclaw-blueprint/blueprint.yaml",
  "scripts/install-openshell.sh",
  "scripts/brev-launchable-ci-cpu.sh",
  "src/lib/onboard/docker-driver-gateway-runtime.ts",
  "src/lib/onboard/openshell-feature-gate.ts",
  "src/lib/onboard/openshell-version.ts",
  "package.json",
  "package-lock.json",
  "ci/reviewed-npm-audit.json",
  "nemoclaw/package.json",
  "nemoclaw/package-lock.json",
];
export const roots: string[] = [];

export function git(root: string, ...args: string[]) {
  return execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-C",
      root,
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}
export function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "protected-openshell-workspace-"));
  roots.push(root);
  const trustedRoot = join(root, "trusted");
  const candidateRoot = join(root, "candidate");
  for (const target of [trustedRoot, candidateRoot]) {
    fs.mkdirSync(target);
    git(target, "init", "--quiet");
    for (const path of sources) {
      const file = join(target, path);
      fs.mkdirSync(dirname(file), { recursive: true });
      fs.copyFileSync(new URL(`../../${path}`, import.meta.url), file);
      fs.chmodSync(file, path.endsWith(".sh") ? 0o755 : 0o644);
    }
    fs.writeFileSync(join(target, "controller.txt"), "trusted fixture\n");
  }
  fs.writeFileSync(
    join(trustedRoot, "nemoclaw-blueprint/blueprint.yaml"),
    'name: fixture\nmin_openshell_version: "0.0.1"\nmax_openshell_version: "0.0.1"\n',
  );
  fs.writeFileSync(
    join(trustedRoot, "src/lib/onboard/openshell-version.ts"),
    'export const SUPPORTED_OPENSHELL_FALLBACK_VERSION = "0.0.1";\n',
  );
  git(trustedRoot, "add", ".");
  git(trustedRoot, "commit", "--quiet", "-m", "fixture");
  git(candidateRoot, "add", ".");
  git(candidateRoot, "commit", "--quiet", "-m", "fixture");
  return {
    trustedRoot,
    candidateRoot,
    workflowSha: git(trustedRoot, "rev-parse", "HEAD"),
    candidateSha: git(candidateRoot, "rev-parse", "HEAD"),
  };
}

export function executeWorkflowRestoration(input: ReturnType<typeof fixture>, outcome: string) {
  const parent = dirname(input.trustedRoot);
  const bin = join(parent, "recovery-bin");
  const artifacts = join(parent, "recovery-artifacts");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(artifacts, { recursive: true });
  fs.writeFileSync(
    join(bin, "node"),
    `#!/bin/sh
[ "$1" = tools/e2e/protected-openshell-workspace.mts ] || exit 91
shift
exec "$TEST_NODE_BIN" "$TEST_RECOVERY_HELPER" "$@"
`,
    { mode: 0o700 },
  );
  const workflow = YAML.parse(
    fs.readFileSync(new URL("../../.github/workflows/e2e.yaml", import.meta.url), "utf8"),
  );
  const step = workflow.jobs["managed-image-protected-runtime"].steps.find(
    (step: { name?: string }) => step.name === "Restore trusted OpenShell sources",
  );
  if (typeof step?.run !== "string") throw new Error("Missing protected workflow restoration step");
  const result = spawnSync("bash", ["-c", step.run], {
    cwd: input.trustedRoot,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      TEST_NODE_BIN: process.execPath,
      TEST_RECOVERY_HELPER: fileURLToPath(
        new URL("../../tools/e2e/protected-openshell-workspace.mts", import.meta.url),
      ),
      PROJECTION_OUTCOME: outcome,
      GITHUB_WORKSPACE: input.trustedRoot,
      NEMOCLAW_E2E_TESTED_ROOT: input.candidateRoot,
      CHECKOUT_SHA: input.candidateSha,
      NEMOCLAW_PROTECTED_MANAGED_IMAGE_WORKFLOW_SHA: input.workflowSha,
      E2E_ARTIFACT_DIR: artifacts,
    },
  });
  const report = join(artifacts, "openshell-projection-restored.json");
  return {
    ...result,
    condition: step.if,
    output: fs.existsSync(report) ? fs.readFileSync(report, "utf8") : "",
  };
}

function templateDigest(check: () => unknown): string {
  try {
    check();
  } catch (error) {
    const digest = /actual_sha256=([a-f0-9]{64})/.exec(String(error))?.[1];
    if (digest) return digest;
    throw error;
  }
  throw new Error("Fixture must introduce an untrusted template");
}

export function approvedFixture() {
  const input = fixture();
  const approval = approvalFixture();
  const candidate = Object.fromEntries(
    Object.entries(CANDIDATE_OPENSHELL_SOURCES).map(([key, path]) => [
      key,
      fs.readFileSync(join(input.candidateRoot, path), "utf8"),
    ]),
  ) as Record<keyof typeof CANDIDATE_OPENSHELL_SOURCES, string>;
  const selected = validateInstallerSources(candidate);
  const release = structuredClone(selected.installerReleases[0]!);
  candidate.installerSource += "\n# Reviewed installer fixture change.\n";
  release.installerTemplateSha256 = [
    ...release.installerTemplateSha256,
    templateDigest(() => validateInstallerSources(candidate)),
  ];
  const featurePath = "src/lib/onboard/openshell-feature-gate.ts";
  const featureSource =
    fs.readFileSync(join(input.candidateRoot, featurePath), "utf8") +
    "\n// Reviewed feature gate fixture change.\n";
  release.featureGateTemplateSha256 = [
    ...(release.featureGateTemplateSha256 ?? []),
    templateDigest(() => validateOpenShellFeatureGateSource(featureSource, release.version)),
  ];
  for (const [key, path] of Object.entries(CANDIDATE_OPENSHELL_SOURCES))
    approval.files[path] = candidate[key as keyof typeof candidate];
  const registry = readOpenShellTrustRegistry();
  approval.files[CANDIDATE_OPENSHELL_TRUST_PATH] = JSON.stringify({
    ...registry,
    releases: [...registry.releases.filter((prior) => prior.version !== release.version), release],
  });
  for (const [path, source] of Object.entries(approval.files))
    fs.writeFileSync(join(input.candidateRoot, path), source);
  fs.writeFileSync(join(input.candidateRoot, featurePath), featureSource);
  git(input.candidateRoot, "add", ".");
  git(input.candidateRoot, "commit", "--quiet", "-m", "approved fixture");
  input.candidateSha = git(input.candidateRoot, "rev-parse", "HEAD");
  approval.approvals[0]!.commit_id = input.candidateSha;
  const request = vi.fn(async (path: string) => {
    const comparison = /\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})\?per_page=1$/u.exec(path);
    if (comparison)
      return {
        status: "ahead",
        base_commit: { sha: comparison[1] },
        merge_base_commit: { sha: comparison[1] },
        files:
          comparison[1] === identity.baseSha ? [] : [{ filename: CANDIDATE_OPENSHELL_TRUST_PATH }],
      };
    const result = await approval.request(path);
    if (path === "/repos/NVIDIA/NemoClaw/pulls/123") {
      const pr = result as { head: { sha: string } };
      return { ...pr, head: { ...pr.head, sha: input.candidateSha } };
    }
    return result;
  });
  return {
    input: Object.assign(input, {
      admission: { prNumber: identity.prNumber, baseSha: identity.baseSha, request },
    }),
    approval,
    request,
  };
}

export function admittedSdkFixture() {
  const input = fixture();
  const sdk = candidateSdkFixture();
  const name = "@nvidia/openshell-sdk";
  const config = JSON.parse(
    fs.readFileSync(join(input.trustedRoot, "ci/reviewed-npm-audit.json"), "utf8"),
  );
  const baseline = config.sourceRegistryPackageReplacement;
  config.sourceRegistryPackage = baseline;
  delete config.sourceRegistryPackageReplacement;
  fs.writeFileSync(join(input.trustedRoot, "ci/reviewed-npm-audit.json"), JSON.stringify(config));
  const version = JSON.parse(fs.readFileSync(join(input.candidateRoot, "package.json"), "utf8"))
    .optionalDependencies[name];
  const selected = JSON.parse(JSON.stringify(sdk.sdk).replaceAll("9.8.7", version));
  for (const [root, identity] of [
    [input.trustedRoot, baseline],
    [input.candidateRoot, selected],
  ] as const) {
    const pin = identity.packageSpec.split("@").at(-1);
    const packagePath = join(root, "package.json");
    const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    manifest.optionalDependencies[name] = pin;
    if (root === input.candidateRoot) manifest.description = "Candidate-only description";
    fs.writeFileSync(packagePath, JSON.stringify(manifest));
    const lockPath = join(root, "package-lock.json");
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    lock.packages[""].optionalDependencies[name] = pin;
    Object.assign(lock.packages[`node_modules/${name}`], {
      version: pin,
      resolved: identity.tarballUrl,
      integrity: identity.integrity,
    });
    fs.writeFileSync(lockPath, JSON.stringify(lock));
  }
  const admittedConfig = { ...config, sourceRegistryPackage: selected };
  fs.writeFileSync(
    join(input.candidateRoot, "ci/reviewed-npm-audit.json"),
    JSON.stringify(admittedConfig),
  );
  for (const root of [input.trustedRoot, input.candidateRoot]) {
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "SDK fixture");
  }
  input.workflowSha = git(input.trustedRoot, "rev-parse", "HEAD");
  input.candidateSha = git(input.candidateRoot, "rev-parse", "HEAD");
  for (const path of [
    "ci/reviewed-npm-audit.json",
    "package.json",
    "package-lock.json",
    "nemoclaw/package.json",
    "nemoclaw/package-lock.json",
  ])
    sdk.sources[path] = fs.readFileSync(join(input.candidateRoot, path), "utf8");
  sdk.pr.head.sha = input.candidateSha;
  sdk.records[0]!.commit_id = input.candidateSha;
  const request = vi.fn(async (route: string) =>
    sdk.request(route.replaceAll(input.candidateSha, "a".repeat(40))),
  );
  const parent = join(input.trustedRoot, "..");
  const artifactDirectory = join(parent, "artifacts");
  const cacheDirectory = join(parent, "cache");
  fs.mkdirSync(artifactDirectory);
  fs.mkdirSync(cacheDirectory);
  fs.writeFileSync(join(artifactDirectory, selected.artifactName), sdk.bytes);
  const preparation = {
    targetRoot: input.trustedRoot,
    artifactDirectory,
    cacheDirectory,
    mode: "artifact" as const,
  };
  return {
    input: { ...input, admission: { prNumber: 123, baseSha: sdk.pr.base.sha, request } },
    sdk,
    request,
    selected,
    preparation,
    stage: vi.fn(),
    manifest: () => JSON.parse(fs.readFileSync(join(input.trustedRoot, "package.json"), "utf8")),
    mutate: (kind: string) => {
      const mutations: Record<string, () => void> = {
        "missing-approval": () => {
          sdk.records.splice(0);
        },
        "tampered-archive": () =>
          fs.writeFileSync(join(artifactDirectory, selected.artifactName), "tampered"),
        "projection-drift": () => fs.appendFileSync(join(input.trustedRoot, "package.json"), " "),
        "plugin-drift": () =>
          fs.appendFileSync(join(input.trustedRoot, "nemoclaw/package.json"), " "),
        "wrong-target": () => {
          preparation.targetRoot = input.candidateRoot;
        },
        "registry-mode": () => {
          Object.assign(preparation, { mode: "registry" });
        },
        "admitted-source-drift": () => {
          sdk.sources["package.json"] = JSON.stringify({
            ...JSON.parse(sdk.sources["package.json"]!),
            description: "API differs from committed bytes",
          });
        },
      };
      mutations[kind]!();
    },
    revokingRequest: () => {
      let reads = 0;
      return async (route: string) => {
        if (route.endsWith("/pulls/123") && ++reads === 3) sdk.records.splice(0);
        return request(route);
      };
    },
  };
}
