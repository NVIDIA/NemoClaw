// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function realGit(root: string, args: string[]): string {
  const result = spawnSync(
    "/usr/bin/git",
    ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        HOME: root,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "CUA Launchable Test",
        GIT_AUTHOR_EMAIL: "cua-launchable@example.invalid",
        GIT_COMMITTER_NAME: "CUA Launchable Test",
        GIT_COMMITTER_EMAIL: "cua-launchable@example.invalid",
      },
    },
  );
  if (result.status !== 0) throw new Error(result.stderr || "real Git fixture command failed");
  return result.stdout.trim();
}

export function runRealCheckoutVerifier(
  script: string,
  attack?: "--assume-unchanged" | "--skip-worktree" | "--replace-head",
) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-real-git-")));
  const bootstrap = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-real-verify-"));
  const bin = path.join(bootstrap, "bin");
  const gitHome = path.join(bootstrap, "git-home");
  const gitXdg = path.join(bootstrap, "git-xdg");
  fs.mkdirSync(bin);
  fs.mkdirSync(gitHome);
  fs.mkdirSync(gitXdg);
  realGit(root, ["init", "--quiet"]);
  fs.writeFileSync(path.join(root, "tracked.txt"), "exact source\n");
  realGit(root, ["add", "--", "tracked.txt"]);
  realGit(root, ["commit", "--quiet", "-m", "test: exact source"]);
  const revision = realGit(root, ["rev-parse", "--verify", "HEAD"]);
  if (attack === "--replace-head") {
    fs.writeFileSync(path.join(root, "tracked.txt"), "replacement-controlled source\n");
    realGit(root, ["add", "--", "tracked.txt"]);
    realGit(root, ["commit", "--quiet", "-m", "test: replacement source"]);
    const replacementRevision = realGit(root, ["rev-parse", "--verify", "HEAD"]);
    realGit(root, ["replace", revision, replacementRevision]);
    realGit(root, ["update-ref", "HEAD", revision]);
    if (realGit(root, ["status", "--porcelain=v1"]) !== "") {
      throw new Error("Git replacement fixture did not conceal the replacement-controlled bytes");
    }
  } else if (attack) {
    realGit(root, ["update-index", attack, "--", "tracked.txt"]);
    fs.writeFileSync(path.join(root, "tracked.txt"), "concealed source\n");
  }

  fs.writeFileSync(
    path.join(bin, "stat"),
    `#!/bin/bash
${
  process.platform === "darwin"
    ? `if [[ "\${1:-}" == "-Lc" && "\${2:-}" == "%d:%i:%f:%h:%s:%y:%z:%F" ]]; then
  exec /usr/bin/stat -L -f '%d:%i:%p:%l:%z:%m:%c:regular file' "\${!#}"
fi
if [[ "\${1:-}" == "-c" && "\${2:-}" == "%d:%i:%f:%h:%s:%y:%z:%F" ]]; then
  exec /usr/bin/stat -f '%d:%i:%p:%l:%z:%m:%c:symbolic link' "\${!#}"
fi
if [[ "\${1:-}" == "-Lc" && "\${2:-}" == "%a" ]]; then
  exec /usr/bin/stat -L -f '%Lp' "\${!#}"
fi
if [[ "\${1:-}" == "-Lc" && "\${2:-}" == "%s" ]]; then
  exec /usr/bin/stat -L -f '%z' "\${!#}"
fi`
    : ""
}
exec /usr/bin/stat "$@"
`,
    { mode: 0o755 },
  );
  const source = fs.readFileSync(script, "utf8");
  const maxTrackedSourceBytes = source.match(
    /^readonly MAX_TRACKED_SOURCE_BYTES=[1-9][0-9]*$/m,
  )?.[0];
  const runGitStart = source.indexOf("run_git() {");
  const runGitEnd = source.indexOf("\n}\n\n# Verify source bytes", runGitStart) + 3;
  const verifyStart = source.indexOf("verify_exact_git_checkout() {");
  const verifyEnd = source.indexOf("\n}\n\nbase_url=", verifyStart) + 3;
  if (
    maxTrackedSourceBytes === undefined ||
    runGitStart < 0 ||
    runGitEnd < 3 ||
    verifyStart < 0 ||
    verifyEnd < 3
  ) {
    throw new Error("could not extract the production Git checkout verifier");
  }
  const harness = path.join(bootstrap, "verify.sh");
  fs.writeFileSync(
    harness,
    `#!/bin/bash
set -euo pipefail
GIT_SAFE_PATH=${shellLiteral(`${bin}:/usr/bin:/bin`)}
GIT_BINARY=/usr/bin/git
export PATH="$GIT_SAFE_PATH"
bootstrap_dir=${shellLiteral(bootstrap)}
git_home=${shellLiteral(gitHome)}
git_xdg_home=${shellLiteral(gitXdg)}
${maxTrackedSourceBytes}
${source.slice(runGitStart, runGitEnd)}
${source.slice(verifyStart, verifyEnd)}
verify_exact_git_checkout ${shellLiteral(root)} ${shellLiteral(revision)}
`,
    { mode: 0o700 },
  );
  return {
    result: spawnSync("/bin/bash", [harness], { encoding: "utf8", timeout: 10_000 }),
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(bootstrap, { recursive: true, force: true });
    },
  };
}
