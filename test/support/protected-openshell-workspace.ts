// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { vi } from "vitest";
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
  // Revocations belong to the registry; resolved releases carry a derived copy.
  delete release.revokedTemplateSha256;
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
  approval.approvals[0]!.body = `NemoClaw-Upgrade-E2E: approve ${input.candidateSha} ${identity.baseSha}`;
  const request = vi.fn(async (path: string) => {
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
