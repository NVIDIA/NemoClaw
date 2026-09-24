// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

interface InstallPathProofOptions {
  dist: string;
  nodeExecutable: string;
  tmp: string;
  timeoutMs: number;
}

function fail(label: string, detail: string): never {
  throw new Error(`${label}: ${detail}`);
}

export function runRealOpenClawInstallPathProof(options: InstallPathProofOptions): void {
  const candidates = fs
    .readdirSync(options.dist)
    .filter((name) => /^install-package-dir-.+[.]js$/u.test(name))
    .map((name) => path.join(options.dist, name))
    .filter((file) =>
      fs.readFileSync(file, "utf8").includes("async function installPackageDir(params)"),
    );
  candidates.length === 1 ||
    fail("real install-path runtime", `expected one module, found ${candidates.length}`);
  const runtime = candidates[0] as string;
  const source = fs.readFileSync(runtime, "utf8");
  const exportName = source.match(/installPackageDir as ([A-Za-z_$][\w$]*)/u)?.[1];
  exportName || fail("real install-path runtime", "installPackageDir export is missing");
  const targetCandidates = fs
    .readdirSync(options.dist)
    .filter((name) => /^install-target-.+[.]js$/u.test(name))
    .map((name) => path.join(options.dist, name))
    .filter((file) =>
      fs
        .readFileSync(file, "utf8")
        .includes("async function resolveCanonicalInstallTarget(params)"),
    );
  targetCandidates.length === 1 ||
    fail("real install-target runtime", `expected one module, found ${targetCandidates.length}`);
  const targetRuntime = targetCandidates[0] as string;
  const targetSource = fs.readFileSync(targetRuntime, "utf8");
  const targetExportName = targetSource.match(
    /resolveCanonicalInstallTarget as ([A-Za-z_$][\w$]*)/u,
  )?.[1];
  targetExportName ||
    fail("real install-target runtime", "resolveCanonicalInstallTarget export is missing");

  const proofRoot = path.join(options.tmp, "install-path-proof");
  fs.mkdirSync(proofRoot);
  const proof = spawnSync(
    options.nodeExecutable,
    [
      "--input-type=module",
      "-e",
      `
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const proofRoot = process.env.NEMOCLAW_INSTALL_PATH_PROOF_ROOT;
const runtime = await import(pathToFileURL(process.env.NEMOCLAW_INSTALL_PATH_RUNTIME).href);
const targetRuntime = await import(pathToFileURL(process.env.NEMOCLAW_INSTALL_TARGET_RUNTIME).href);
const installPackageDir = runtime[process.env.NEMOCLAW_INSTALL_PATH_EXPORT];
const resolveCanonicalInstallTarget = targetRuntime[process.env.NEMOCLAW_INSTALL_TARGET_EXPORT];
if (typeof installPackageDir !== "function") throw new Error("installPackageDir export is unavailable");
if (typeof resolveCanonicalInstallTarget !== "function") throw new Error("resolveCanonicalInstallTarget export is unavailable");
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const sourceDir = path.join(proofRoot, "source");
await fs.mkdir(sourceDir);
await fs.writeFile(path.join(sourceDir, "package.json"), '{"name":"fixture","version":"1.0.0"}\\n');
const install = (targetDir, overrides = {}) => installPackageDir({
  sourceDir,
  targetDir,
  mode: "install",
  hasDeps: false,
  copyErrorPrefix: "fixture copy failed",
  depsLogMessage: "unused",
  timeoutMs: 1_000,
  ...overrides,
});
const resolveAndInstall = async (baseDir, id, overrides = {}) => {
  const target = await resolveCanonicalInstallTarget({
    baseDir,
    id,
    invalidNameMessage: "invalid fixture name",
    boundaryLabel: "fixture install directory",
  });
  return target.ok ? await install(target.targetDir, overrides) : target;
};

const realBase = path.join(proofRoot, "safe-real");
const linkedBase = path.join(proofRoot, "safe-link");
await fs.mkdir(realBase);
await fs.symlink(realBase, linkedBase, "dir");
const safe = await resolveAndInstall(linkedBase, "safe-plugin");
assert(safe?.ok === true, "safe in-base symlink installation was rejected");
assert((await fs.readFile(path.join(realBase, "safe-plugin", "package.json"), "utf8")).includes('"fixture"'), "safe in-base symlink installation was not materialized");

const outside = path.join(proofRoot, "outside");
await fs.mkdir(outside);
await fs.symlink(outside, path.join(realBase, "escape"), "dir");
const escaped = await resolveAndInstall(linkedBase, "escape");
assert(escaped?.ok === false, "out-of-base symlink installation was accepted");
assert((await fs.readdir(outside)).length === 0, "out-of-base symlink installation wrote outside its base");

const stableA = path.join(proofRoot, "stable-a");
const stableB = path.join(proofRoot, "stable-b");
const stableLink = path.join(proofRoot, "stable-link");
await fs.mkdir(stableA);
await fs.mkdir(stableB);
await fs.symlink(stableA, stableLink, "dir");
const unstable = await resolveAndInstall(stableLink, "unstable-plugin", {
  async afterCopy() {
    await fs.unlink(stableLink);
    await fs.symlink(stableB, stableLink, "dir");
  },
});
assert(unstable?.ok === false, "realpath stability mismatch was accepted");
assert(await fs.access(path.join(stableA, "unstable-plugin")).then(() => false, () => true), "realpath mismatch published into the original base");
assert(await fs.access(path.join(stableB, "unstable-plugin")).then(() => false, () => true), "realpath mismatch published into the replacement base");
`,
    ],
    {
      cwd: path.dirname(options.dist),
      encoding: "utf8",
      env: {
        ...process.env,
        NEMOCLAW_INSTALL_PATH_EXPORT: exportName,
        NEMOCLAW_INSTALL_PATH_PROOF_ROOT: proofRoot,
        NEMOCLAW_INSTALL_PATH_RUNTIME: runtime,
        NEMOCLAW_INSTALL_TARGET_EXPORT: targetExportName,
        NEMOCLAW_INSTALL_TARGET_RUNTIME: targetRuntime,
      },
      timeout: Math.min(options.timeoutMs, 60_000),
    },
  );
  proof.status === 0 || fail("real install-path boundary proof", `${proof.stdout}${proof.stderr}`);
}
