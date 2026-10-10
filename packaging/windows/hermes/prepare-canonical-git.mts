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
const inventorySha256 = "777f6a6fcbefa3790130e795b611aff086775f23682ae109c16cac2f1ff1acd0";
const initializedFiles = [
  "clangarm64/libexec/git-core/dlls-copied",
  "etc/hosts",
  "etc/mtab",
  "etc/networks",
  "etc/protocols",
  "etc/services",
];
type Row = { path: string; bytes: number; sha256: string };

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
  const receipt = {
    schemaVersion: 1,
    classification: "ci-derived-initialized-canonical-hermes-git",
    baseCandidateSource: "47d890728482cca05e840edd27e33e3d495aeabf",
    baseInventorySha256: inventorySha256,
    upstreamCommit: "2237be355906fbe6065ce1815711eee52b2d646e",
    beforeInventorySha256: sha(Buffer.from(JSON.stringify(before))),
    afterInventorySha256: sha(Buffer.from(JSON.stringify(after))),
    fileCount: after.length,
    initializedFilesPreserved: initializedFiles,
    allOtherFilesUnchanged: true,
    filesReplacedAtBuild: 3,
    beforeLogicalBytes: before.reduce((sum, row) => sum + row.bytes, 0),
    afterLogicalBytes: after.reduce((sum, row) => sum + row.bytes, 0),
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
