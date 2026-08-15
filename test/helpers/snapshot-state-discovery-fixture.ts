// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type StateDirectoryDiscoveryFixture = {
  existingDirs: string[];
  openclawDir: string;
  sshLog: string;
  stagingRoot: string;
  unsafeDiscoveryMarker: string;
};

export function stateDirectoryDiscoverySshSource({
  existingDirs,
  openclawDir,
  sshLog,
  stagingRoot,
  unsafeDiscoveryMarker,
}: StateDirectoryDiscoveryFixture): string {
  return `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const cmd = process.argv[process.argv.length - 1] || "";
const existingDirs = ${JSON.stringify(existingDirs)};
fs.appendFileSync(${JSON.stringify(sshLog)}, JSON.stringify({ cmd }) + "\\n");
if (cmd.includes("[ -d ")) {
  if (fs.existsSync(${JSON.stringify(unsafeDiscoveryMarker)})) {
    process.stdout.write("workspace-research\\nidentity\\n");
    process.exit(0);
  }
  process.stdout.write(existingDirs.join("\\n") + "\\n");
  process.exit(0);
}
if (cmd.includes("openclaw.json") && cmd.includes("cat --")) {
  process.exit(2);
}
if (cmd.includes("find ")) {
  process.exit(0);
}
if (cmd.includes("tar -cf -")) {
  const stagingDirs = fs.readdirSync(${JSON.stringify(stagingRoot)});
  const archivePaths = stagingDirs
    .map((entry) => require("node:path").join(${JSON.stringify(stagingRoot)}, entry, "archive.tar"))
    .filter((candidate) => fs.existsSync(candidate));
  const archivePath = archivePaths.length === 1 ? archivePaths[0] : "";
  if (
    !fs.fstatSync(1).isFile() ||
    !archivePath ||
    !fs.existsSync(archivePath) ||
    fs.statSync(archivePath).ino !== fs.fstatSync(1).ino
  ) {
    process.stderr.write("backup tar stdout must stream to a file\\n");
    process.exit(64);
  }
  const result = spawnSync(
    "tar",
    ["-cf", "-", "-C", ${JSON.stringify(openclawDir)}, ...existingDirs],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.stdout) fs.writeSync(1, result.stdout);
  if (result.stderr) fs.writeSync(2, result.stderr);
  process.exit(result.status || 0);
}
process.exit(0);
`;
}
