// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Run with the exact pinned stock Node on the Windows ARM64 build runner.
// Cached blobs are target-specific and must never be copied from a Mac build.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const [bundleArgument, postjectArgument, outputArgument] = process.argv.slice(2);
if (
  process.platform !== "win32" ||
  process.arch !== "arm64" ||
  process.version !== "v22.23.2" ||
  process.env.GITHUB_ACTIONS !== "true"
)
  throw new Error("SEA code cache must be produced by stock Node22.23.2 on Windows ARM64 CI.");
if (!bundleArgument || !postjectArgument || !outputArgument)
  throw new Error("The built CJS, pinned postject API and fresh output directory are required.");
const bundle = path.resolve(bundleArgument),
  postject = path.resolve(postjectArgument),
  output = path.resolve(outputArgument);
if (fs.existsSync(output)) throw new Error("The executable output must be fresh.");
for (const file of [bundle, postject]) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    throw new Error("An executable build input is redirected.");
}
const require = createRequire(postject);
const toolPackage = JSON.parse(
  fs.readFileSync(path.join(path.dirname(postject), "../package.json"), "utf8"),
);
if (toolPackage.name !== "postject" || toolPackage.version !== "1.0.0-alpha.6")
  throw new Error("The resource injector does not match its build pin.");
fs.mkdirSync(output);
const digest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const executable = path.join(output, "NemoClaw.Runtime.exe"),
  blob = path.join(output, "native-runtime.blob"),
  config = path.join(output, "sea-config.json");
const record: Record<string, unknown> = {
  schemaVersion: 1,
  classification: "windows-prebuilt-runtime-executable",
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
  useCodeCache: true,
  useSnapshot: false,
  stockNodeSha256: digest(process.execPath),
  compiledSourceSha256: digest(bundle),
  injectorApiSha256: digest(postject),
  status: "failed",
  installedAcceptance: false,
};
let primary: unknown;
try {
  fs.writeFileSync(
    config,
    JSON.stringify({
      main: bundle,
      output: blob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: true,
      execArgvExtension: "none",
    }) + "\n",
    { flag: "wx" },
  );
  const preparation = execFileSync(process.execPath, ["--experimental-sea-config", config], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 180000,
    maxBuffer: 1024 * 1024,
  });
  fs.writeFileSync(path.join(output, "prepare.log"), preparation);
  fs.copyFileSync(process.execPath, executable, fs.constants.COPYFILE_EXCL);
  const { inject } = require(postject) as {
    inject(
      file: string,
      resource: string,
      bytes: Buffer,
      options: { sentinelFuse: string },
    ): Promise<void>;
  };
  await inject(executable, "NODE_SEA_BLOB", fs.readFileSync(blob), {
    sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  });
  const observed = execFileSync(executable, ["--describe-runtime"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 16384,
  });
  fs.writeFileSync(path.join(output, "execution.json"), observed, { flag: "wx" });
  const description = JSON.parse(observed);
  if (
    description.kind !== "prebuilt-native-runtime" ||
    description.sea !== true ||
    description.node !== process.version
  )
    throw new Error("The generated executable did not identify the actual SEA runtime.");
  record.status = "built-and-executed";
  record.execution = description;
  record.blobSha256 = digest(blob);
  record.executable = {
    file: path.basename(executable),
    bytes: fs.statSync(executable).size,
    sha256: digest(executable),
    authenticode: "not signed by this build helper",
  };
} catch (error) {
  primary = error;
  record.error = error instanceof Error ? error.message : "The native executable build failed.";
} finally {
  try {
    fs.writeFileSync(path.join(output, "build.json"), JSON.stringify(record, null, 2) + "\n", {
      flag: "wx",
    });
  } catch (error) {
    if (primary === undefined) primary = error;
  }
}
if (primary !== undefined) throw primary;
