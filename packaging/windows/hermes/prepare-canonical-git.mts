// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Preserve the complete initialized official Git tree; derive three loader images in CI.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  deriveImage,
  imageEvidenceNames,
  inventory,
  originals,
} from "../mxc-bash/prepare-msys-aslr.mts";

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const inventorySha256 = "c6255066a9d6ab620c6d6627bb97b2f96f74430c034f8b2016ecc02aa530af70";
const initializedFiles = [
  "clangarm64/libexec/git-core/dlls-copied",
  "etc/hosts",
  "etc/mtab",
  "etc/networks",
  "etc/protocols",
  "etc/services",
];
type Row = { path: string; bytes: number; sha256: string };

export function canonicalGitInventorySummary(rows: Row[]) {
  // Receipt bytes must not depend on filesystem traversal or the host locale.
  const ordered = [...rows].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    fileCount: rows.length,
    logicalBytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    sha256: sha(Buffer.from(JSON.stringify(ordered))),
  };
}

export function prepareCanonicalGit(runtimeRoot: string, baseInventory: string, evidence: string) {
  const runtime = fs.realpathSync(runtimeRoot);
  const git = path.join(runtime, "git");
  const requestedOutput = path.resolve(evidence);
  const output = path.join(
    fs.realpathSync(path.dirname(requestedOutput)),
    path.basename(requestedOutput),
  );
  const relative = path.relative(runtime, output);
  assert(
    relative.startsWith(".." + path.sep) || path.isAbsolute(relative),
    "Evidence must be outside the runtime",
  );
  assert(!fs.existsSync(output), "Evidence directory must be fresh");
  const original = fs.readFileSync(baseInventory);
  assert.equal(sha(original), inventorySha256, "The complete canonical input inventory differs");
  const expected = (JSON.parse(original.toString("utf8")).files as Row[])
    .filter((row) => row.path.startsWith("git/"))
    .map((row) => ({ path: row.path.slice(4), bytes: row.bytes, sha256: row.sha256 }));
  assert.equal(expected.length, 7835);
  const ordered = (rows: Row[]) =>
    [...rows].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const before = inventory(git);
  assert.deepEqual(
    ordered(before),
    ordered(expected),
    "Initialized canonical Git bytes must be unchanged",
  );
  for (const name of initializedFiles) assert(before.some((row) => row.path === name));
  assert(
    !before.some(
      (row) => row.path === "post-install.bat" || row.path.startsWith("etc/post-install/"),
    ),
    "Post-install scripts must not re-enter the finished runtime",
  );
  const changes = Object.entries(originals).map(([name, pin]) => {
    const input = fs.readFileSync(path.join(git, name));
    const derived = deriveImage(input, pin);
    return { name, pin, input, ...derived };
  });
  assert.equal(changes.length, 3);
  fs.mkdirSync(output, { recursive: true });
  for (const change of changes) {
    const names = imageEvidenceNames(change.name);
    fs.writeFileSync(path.join(output, names.original), change.input, { flag: "wx" });
    fs.writeFileSync(path.join(output, names.derived), change.output, { flag: "wx" });
    if (change.pin.certificate)
      fs.writeFileSync(
        path.join(output, names.certificate),
        change.input.subarray(change.pin.certificate.offset),
        { flag: "wx" },
      );
  }
  // All source images and the complete original tree were checked before mutation.
  for (const change of changes) fs.writeFileSync(path.join(git, change.name), change.output);
  const after = inventory(git);
  assert.deepEqual(
    after,
    before.map((row) => {
      const change = changes.find((item) => item.name === row.path);
      return change ? { ...row, bytes: change.output.length, sha256: sha(change.output) } : row;
    }),
    "Every unrelated initialized Git file must remain byte-identical",
  );
  const beforeSummary = canonicalGitInventorySummary(before);
  const afterSummary = canonicalGitInventorySummary(after);
  const receipt = {
    schemaVersion: 1,
    classification: "ci-derived-initialized-canonical-hermes-git",
    baseCandidateSource: "8f54e647a1cda1c3c879ad4e350700a13bb8fc2e",
    baseInventorySha256: inventorySha256,
    upstreamCommit: "2237be355906fbe6065ce1815711eee52b2d646e",
    beforeInventorySha256: beforeSummary.sha256,
    afterInventorySha256: afterSummary.sha256,
    fileCount: afterSummary.fileCount,
    initializedFilesPreserved: initializedFiles,
    allOtherFilesUnchanged: true,
    filesReplacedAtBuild: 3,
    beforeLogicalBytes: beforeSummary.logicalBytes,
    afterLogicalBytes: afterSummary.logicalBytes,
    firstLaunchSetupAllowed: false,
    files: changes.map((change) => ({ path: change.name, ...change.receipt })),
    nativeChecksumVerificationRequired: true,
    nativeAuthenticodeVerificationRequired: true,
    personalLoginShellQualificationRequired: true,
    fullAgentQualified: false,
    installedAcceptance: false,
  };
  fs.writeFileSync(
    path.join(output, "canonical-git-derivation.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { flag: "wx" },
  );
  return receipt;
}

function main() {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "arm64");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  const argument = (name: string) => {
    const at = process.argv.indexOf(name);
    assert(at >= 0 && process.argv[at + 1]);
    return path.resolve(process.argv[at + 1]!);
  };
  const runtime = argument("--runtime-root");
  assert.match(runtime, /^[A-Za-z]:\\NemoClawHermesProbe-[a-f0-9]{12}$/u);
  prepareCanonicalGit(runtime, argument("--base-inventory"), argument("--evidence"));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
