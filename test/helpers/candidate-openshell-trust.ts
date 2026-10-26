// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import {
  readOpenShellTrustRegistry,
  validateInstallerSources,
} from "../../scripts/checks/extract-installer-pins.mts";
import {
  CANDIDATE_OPENSHELL_SOURCES,
  CANDIDATE_OPENSHELL_TRUST_PATH,
} from "../../tools/e2e/candidate-openshell-trust.mts";
import { parseOpenShellTrustRegistry } from "../../scripts/checks/openshell-trust-data.mts";
import { copyTrustedInstallerVerifier } from "./openshell-installer-template";

export const identity = { prNumber: 123, candidateSha: "a".repeat(40), baseSha: "b".repeat(40) };
export const version = "9.8.7";

export function fixture() {
  const sources = Object.fromEntries(
    Object.entries(CANDIDATE_OPENSHELL_SOURCES).map(([key, path]) => [
      key,
      readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"),
    ]),
  ) as Record<keyof typeof CANDIDATE_OPENSHELL_SOURCES, string>;
  const current = validateInstallerSources(sources);
  const release = structuredClone(current.installerReleases[0]!);
  const prior = release.version;
  release.version = version;
  release.formula.url = `https://github.com/NVIDIA/OpenShell/releases/download/v${version}/openshell.rb`;
  release.sandboxBuilds = [{ required: false, sha256: "f".repeat(64) }];
  sources.blueprintSource = sources.blueprintSource.replaceAll(`"${prior}"`, `"${version}"`);
  sources.installerSource = sources.installerSource
    .replaceAll(`v${prior}:`, `v${version}:`)
    .replaceAll(`MIN_VERSION="${prior}"`, `MIN_VERSION="${version}"`)
    .replaceAll(`MAX_VERSION="${prior}"`, `MAX_VERSION="${version}"`)
    .replace(
      '  case "$digest" in',
      `  case "$digest" in\n    ${"f".repeat(64)})\n      printf '%s\\n' "${version}"\n      ;;`,
    );
  sources.brevInstallerSource = sources.brevInstallerSource
    .replaceAll(`v${prior}:`, `v${version}:`)
    .replaceAll(`OPENSHELL_VERSION="v${prior}"`, `OPENSHELL_VERSION="v${version}"`);
  const supervisorHeader =
    "const OPENSHELL_SUPERVISOR_MANIFEST_DIGESTS: Readonly<Record<string, string>> = {\n";
  sources.supervisorRuntimeSource = sources.supervisorRuntimeSource
    .replace(
      supervisorHeader,
      `${supervisorHeader}  "${version}": "${release.supervisor!.manifestDigest}",\n`,
    )
    .replace(
      `QUALIFIED_STABLE_OPENSHELL_VERSION = "${prior}"`,
      `QUALIFIED_STABLE_OPENSHELL_VERSION = "${version}"`,
    );
  const normalizedSupervisor = sources.supervisorRuntimeSource.replace(
    /(?<=const OPENSHELL_SUPERVISOR_MANIFEST_DIGESTS: Readonly<Record<string, string>> = \{\n)[\s\S]*?(?=\n\};)/u,
    "<normalized-supervisor-manifest-pins>",
  );
  release.supervisor!.runtimeTemplateSha256 = [
    createHash("sha256").update(normalizedSupervisor).digest("hex"),
  ];
  const files: Record<string, string> = Object.fromEntries(
    Object.entries(CANDIDATE_OPENSHELL_SOURCES).map(([key, path]) => [
      path,
      sources[key as keyof typeof sources],
    ]),
  );
  const registry = readOpenShellTrustRegistry();
  files[CANDIDATE_OPENSHELL_TRUST_PATH] = JSON.stringify({
    ...registry,
    releases: [...registry.releases, release],
  });
  const repository = { full_name: "NVIDIA/NemoClaw" };
  const approvals = [
    {
      id: 50,
      user: { type: "User", login: "reviewer" },
      created_at: "2026-10-14T00:00:00Z",
      updated_at: "2026-10-14T00:00:00Z",
      body: `NemoClaw-Upgrade-E2E: approve ${identity.candidateSha} ${identity.baseSha}`,
    },
  ];
  const routes: Record<string, unknown> = {
    "/repos/NVIDIA/NemoClaw/pulls/123": {
      number: 123,
      state: "open",
      user: { login: "author" },
      head: { sha: identity.candidateSha, repo: repository },
      base: { sha: identity.baseSha, ref: "main", repo: repository },
    },
    "/repos/NVIDIA/NemoClaw/issues/123/comments?per_page=100&page=1": approvals,
    "/repos/NVIDIA/NemoClaw/collaborators/reviewer/permission": { role_name: "maintain" },
  };
  const request = vi.fn(async (path: string): Promise<unknown> => {
    const sourcePath = new URL(path, "https://api.github.com").pathname.replace(
      "/repos/NVIDIA/NemoClaw/contents/",
      "",
    );
    const content = files[sourcePath];
    if (sourcePath === "ci")
      return Object.keys(files)
        .filter((path) => path.startsWith("ci/"))
        .map((path) => ({ path, type: "file" }));
    return content === undefined
      ? routes[path]
      : {
          type: "file",
          path: sourcePath,
          encoding: "base64",
          size: Buffer.byteLength(content),
          content: Buffer.from(content).toString("base64"),
        };
  });
  return { files, sources, release, approvals, request };
}

export function runCoveredRegistry(
  consumer: "installer" | "version",
  scenario:
    | "older"
    | "empty"
    | "absent"
    | "absent-revoked"
    | "absent-untrusted"
    | "symlink"
    | "revoked"
    | "new-template"
    | "changed-artifact",
  temporaryRoots: string[],
) {
  const f = fixture();
  const root = mkdtempSync(join(tmpdir(), "older-candidate-trust-"));
  temporaryRoots.push(root);
  const trusted = join(root, "trusted");
  const candidate = join(root, "candidate");
  copyTrustedInstallerVerifier(new URL("../../", import.meta.url).pathname, trusted);
  const oldRegistry = parseOpenShellTrustRegistry(f.files[CANDIDATE_OPENSHELL_TRUST_PATH]!);
  const nextRelease = {
    ...structuredClone(f.release),
    version: "9.8.8",
    formula: {
      ...f.release.formula,
      url: "https://github.com/NVIDIA/OpenShell/releases/download/v9.8.8/openshell.rb",
    },
  };
  writeFileSync(
    join(trusted, CANDIDATE_OPENSHELL_TRUST_PATH),
    JSON.stringify({
      ...oldRegistry,
      releases: scenario === "absent-untrusted" ? [] : [...oldRegistry.releases, nextRelease],
      revokedTemplateSha256: scenario.endsWith("revoked") ? f.release.installerTemplateSha256 : [],
    }),
  );
  const candidateRegistry = structuredClone(oldRegistry);
  const candidateRelease = candidateRegistry.releases.find((entry) => entry.version === version)!;
  if (scenario === "empty") candidateRegistry.releases = [];
  if (scenario === "new-template") candidateRelease.installerTemplateSha256 = ["0".repeat(64)];
  if (scenario === "changed-artifact") candidateRelease.formula.sha256 = "0".repeat(64);
  f.files[CANDIDATE_OPENSHELL_TRUST_PATH] = JSON.stringify(candidateRegistry);
  Object.entries(f.files).forEach(([path, source]) => {
    mkdirSync(dirname(join(candidate, path)), { recursive: true });
    writeFileSync(join(candidate, path), source);
  });
  if (scenario.startsWith("absent") || scenario === "symlink")
    rmSync(join(candidate, CANDIDATE_OPENSHELL_TRUST_PATH));
  if (scenario === "symlink")
    symlinkSync("missing.json", join(candidate, CANDIDATE_OPENSHELL_TRUST_PATH));
  // Exercise both real consumers against a distinct trusted checkout. Approval reads
  // fail so an older candidate cannot pass by accidentally obtaining fresh admission.
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { readFileSync, readdirSync } from 'node:fs';
       import { verifyCandidateInstallerTrust } from ${JSON.stringify(pathToFileURL(join(trusted, "tools/e2e/candidate-openshell-trust.mts")).href)};
       import { candidateOpenShellVersion } from ${JSON.stringify(pathToFileURL(join(trusted, "tools/e2e/candidate-openshell-version.mts")).href)};
       const identity = ${JSON.stringify(identity)};
       const root = ${JSON.stringify(candidate)};
       const request = async (url) => {
         const parsed = new URL(url, 'https://api.github.com');
         if (!parsed.pathname.startsWith('/repos/NVIDIA/NemoClaw/contents/'))
           throw new Error('fresh approval required');
         const path = parsed.pathname.slice('/repos/NVIDIA/NemoClaw/contents/'.length);
         if (path === 'ci') return readdirSync(root + '/ci', { withFileTypes: true }).map(entry => ({ path: 'ci/' + entry.name, type: entry.isFile() ? 'file' : 'symlink' }));
         const content = readFileSync(root + '/' + path);
         return { type: 'file', path, encoding: 'base64', size: content.length, content: content.toString('base64') };
       };
       const selected = ${JSON.stringify(consumer)} === 'installer'
         ? (await verifyCandidateInstallerTrust(root, identity, request)).releaseVersion
         : await candidateOpenShellVersion('NVIDIA/NemoClaw', identity.candidateSha, request, identity);
       process.stdout.write(selected);`,
    ],
    { cwd: candidate, encoding: "utf8" },
  );
}
