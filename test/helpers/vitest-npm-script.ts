// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { OwnedTestResources } from "./owned-test-resources";

export function runVitestNpmScript(
  resources: OwnedTestResources,
  script: string,
  extraArguments: string[] = [],
): string {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("npm_execpath is required to exercise npm script dispatch");
  const fixtureRoot = resources.temporaryDirectory("nemoclaw-vitest-feedback-");
  const fakeBin = path.join(fixtureRoot, "bin");
  const commandLog = path.join(fixtureRoot, "commands.log");
  const scriptShell = path.join(fixtureRoot, "script-shell");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    path.join(fakeBin, "vitest"),
    '#!/bin/sh\nprintf \'vitest %s\\n\' "$*" > "$COMMAND_LOG"\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(
    scriptShell,
    `#!/bin/sh\nPATH="$FAKE_BIN:${path.dirname(process.execPath)}:/usr/bin:/bin"\nexport PATH\nexec /bin/sh "$@"\n`,
    { mode: 0o755 },
  );

  const result = spawnSync(process.execPath, [npmCli, "run", script, ...extraArguments], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      COMMAND_LOG: commandLog,
      FAKE_BIN: fakeBin,
      npm_config_script_shell: scriptShell,
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${script} exited ${result.status}`);
  }
  return fs.readFileSync(commandLog, "utf8").trim();
}
