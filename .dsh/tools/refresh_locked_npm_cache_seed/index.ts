// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const dryRun = input.dryRun ?? true;
const chunkBytes = input.chunkBytes ?? 1_900_000;
if (!Number.isInteger(chunkBytes) || chunkBytes < 65_536 || chunkBytes > 2_000_000) {
  throw new Error("chunkBytes must be an integer from 65536 to 2000000");
}
for (const [name, value] of Object.entries({
  lockfile: input.lockfile,
  destination: input.destination,
  os: input.os,
  cpu: input.cpu,
  libc: input.libc,
})) {
  if (typeof value !== "string" || !value || value.includes("\n"))
    throw new Error(name + " must be one non-empty single-line string");
}
const q = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
const execute = async (command, description, timeoutMs = 30_000) => {
  const result = await tools.bash({ command, workdir: input.workdir, description, timeoutMs });
  if (result.kind !== "foreground") throw new Error(description + " did not finish");
  return result;
};
const requireSuccess = async (command, description, timeoutMs = 30_000) => {
  const result = await execute(command, description, timeoutMs);
  if (result.exitCode !== 0)
    throw new Error(
      description + " failed.\n" + (result.stdout.text + "\n" + result.stderr.text).trim(),
    );
  if (result.stdout.truncated || result.stderr.truncated)
    throw new Error(description + " exceeded the bounded command output");
  return result;
};
const probeCommand =
  "node -e " +
  q(
    "const fs=require('node:fs'),p=require('node:path');const [lockInput,destInput]=process.argv.slice(1);const cwd=fs.realpathSync('.');const lock=p.resolve(lockInput),dest=p.resolve(destInput);const inside=x=>x.startsWith(cwd+p.sep);if(!inside(lock)||!inside(dest)||fs.lstatSync(lock).isSymbolicLink()||!fs.statSync(lock).isFile()||fs.lstatSync(dest).isSymbolicLink()||!fs.statSync(dest).isDirectory())process.exit(42);console.log(cwd+'\\n'+lock+'\\n'+dest)",
  ) +
  " " +
  q(input.lockfile) +
  " " +
  q(input.destination);
const probe = await execute(probeCommand, "Validate cache seed paths");
if (probe.exitCode !== 0)
  throw new Error("lockfile and destination must be regular non-symlink paths inside workdir");
const [cwd, lockfile, destination] = probe.stdout.text.trim().split(/\r?\n/);
const generator = cwd + "/scripts/checks/materialize-locked-npm-cache-seed.mts";
const target = { os: input.os, cpu: input.cpu, libc: input.libc };
if (dryRun)
  return { dryRun: true, lockfile, destination, target, chunkBytes, generator, replaced: false };
const tempResult = await requireSuccess(
  "parent=$(dirname " +
    q(destination) +
    '); umask 077; mktemp -d "$parent/.nemoclaw-seed-refresh.XXXXXX"',
  "Create cache seed staging directory",
);
const temp = tempResult.stdout.text.trim();
const output = temp + "/seed";
const backup = temp + "/previous";
let destinationMoved = false;
let generate;
try {
  const generateCommand = [
    "node",
    "--experimental-strip-types",
    "--no-warnings",
    generator,
    "export",
    "--lockfile",
    lockfile,
    "--output",
    output,
    "--os",
    input.os,
    "--cpu",
    input.cpu,
    "--libc",
    input.libc,
  ]
    .map(q)
    .join(" ");
  generate = await execute(generateCommand, "Generate lock-pinned npm cache seed", 300_000);
  if (generate.exitCode !== 0) return { dryRun: false, generate, replaced: false };
  const chunkScript =
    'const fs=require("node:fs"),path=require("node:path");const [directory,chunkText]=process.argv.slice(1);const limit=Number(chunkText),chunked=[];for(const name of fs.readdirSync(directory)){if(!name.endsWith(".tgz"))continue;const file=path.join(directory,name),bytes=fs.readFileSync(file);if(bytes.length<=limit)continue;for(let offset=0,index=0;offset<bytes.length;offset+=limit,index+=1){fs.writeFileSync(file+".part-"+String(index).padStart(3,"0"),bytes.subarray(offset,offset+limit),{mode:0o644,flag:"wx"});}fs.unlinkSync(file);chunked.push({name,bytes:bytes.length,parts:Math.ceil(bytes.length/limit)});}const manifestPath=path.join(directory,"manifest.json");fs.chmodSync(manifestPath,0o644);const manifest=JSON.parse(fs.readFileSync(manifestPath,"utf8"));console.log(JSON.stringify({archiveCount:manifest.archiveCount,lockSha256:manifest.lockSha256,entries:fs.readdirSync(directory).length,chunked}));';
  const chunkResult = await requireSuccess(
    "node -e " + q(chunkScript) + " " + q(output) + " " + q(chunkBytes),
    "Split large npm cache archives",
  );
  const chunk = JSON.parse(chunkResult.stdout.text);
  await requireSuccess("mv " + q(destination) + " " + q(backup), "Back up current npm cache seed");
  destinationMoved = true;
  const install = await execute(
    "mv " + q(output) + " " + q(destination),
    "Install refreshed npm cache seed",
  );
  if (install.exitCode !== 0) {
    await requireSuccess(
      "mv " + q(backup) + " " + q(destination),
      "Restore previous npm cache seed",
    );
    destinationMoved = false;
    return { dryRun: false, generate, chunk, install, replaced: false };
  }
  destinationMoved = false;
  return { dryRun: false, generate, chunk, replaced: true };
} finally {
  if (destinationMoved) {
    await requireSuccess(
      "test -e " + q(destination) + " || mv " + q(backup) + " " + q(destination),
      "Roll back interrupted npm cache refresh",
    );
  }
  await requireSuccess("rm -rf " + q(temp), "Remove npm cache staging directory");
}
