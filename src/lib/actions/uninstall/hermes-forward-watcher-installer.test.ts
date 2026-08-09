// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../../..");
const INSTALLER = path.join(REPOSITORY_ROOT, "scripts", "install.sh");

function writeExecutable(target: string, contents: string): void {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

describe("Hermes forward watcher installer contract", () => {
  it("gives the watcher an absolute OpenShell path for a relative override (#7163)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemohermes-forward-relative-"));
    try {
      const fakeBin = path.join(tmp, "bin");
      const stateDir = path.join(tmp, ".nemoclaw");
      const watcherLog = path.join(tmp, "watcher.log");
      const openshell = path.join(fakeBin, "openshell");
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "onboard-session.json"),
        JSON.stringify({ sandboxName: "created-by-onboard", agent: "hermes" }),
      );
      fs.writeFileSync(
        path.join(stateDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: { "created-by-onboard": { hermesApiPort: 8643 } },
        }),
      );
      writeExecutable(openshell, "#!/usr/bin/env bash\nexit 0\n");
      writeExecutable(
        path.join(fakeBin, "node"),
        `#!/usr/bin/env bash
if [ "\${1:-}" = "-e" ] && [[ "\${2:-}" == *"const { spawn }"* ]]; then
  printf '%s\n' "$4" > "$WATCHER_LOG"
  exit 0
fi
exec ${JSON.stringify(process.execPath)} "$@"
`,
      );
      for (const command of ["curl", "sleep"]) {
        writeExecutable(path.join(fakeBin, command), "#!/usr/bin/env bash\nexit 0\n");
      }
      const relativeOpenshell = path.relative(REPOSITORY_ROOT, openshell);
      const result = spawnSync(
        "bash",
        ["-c", 'source "$INSTALLER" 2>/dev/null; restore_onboard_forward_after_post_checks'],
        {
          cwd: REPOSITORY_ROOT,
          encoding: "utf-8",
          env: {
            ...process.env,
            HOME: tmp,
            INSTALLER,
            NEMOCLAW_OPENSHELL_BIN: relativeOpenshell,
            PATH: `${fakeBin}:/usr/bin:/bin`,
            WATCHER_LOG: watcherLog,
          },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      const watcherOpenshell = fs.readFileSync(watcherLog, "utf-8").trim();
      expect(path.isAbsolute(watcherOpenshell)).toBe(true);
      expect(fs.realpathSync(watcherOpenshell)).toBe(fs.realpathSync(openshell));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "legacy row",
      registry: JSON.stringify({ sandboxes: { hermes: {} } }),
      status: 0,
      output: "8642",
    },
    {
      name: "allocated interior port",
      registry: JSON.stringify({ sandboxes: { hermes: { hermesApiPort: 8645 } } }),
      status: 0,
      output: "8645",
    },
    {
      name: "missing sandbox row",
      registry: JSON.stringify({ sandboxes: {} }),
      status: 1,
      output: "",
    },
    {
      name: "out-of-range port",
      registry: JSON.stringify({ sandboxes: { hermes: { hermesApiPort: 9000 } } }),
      status: 1,
      output: "",
    },
    {
      name: "non-number port",
      registry: JSON.stringify({ sandboxes: { hermes: { hermesApiPort: "8645" } } }),
      status: 1,
      output: "",
    },
    {
      name: "fractional numeric port",
      registry: JSON.stringify({ sandboxes: { hermes: { hermesApiPort: 8645.5 } } }),
      status: 1,
      output: "",
    },
    {
      name: "malformed registry",
      registry: "{",
      status: 1,
      output: "",
    },
  ])("resolves $name without inventing recovery state", ({ registry, status, output }) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemohermes-port-state-"));
    try {
      const stateDir = path.join(tmp, ".nemoclaw");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, "sandboxes.json"), registry);
      const result = spawnSync(
        "bash",
        ["-c", 'source "$INSTALLER" 2>/dev/null; resolve_hermes_api_port "$SANDBOX"'],
        {
          cwd: REPOSITORY_ROOT,
          encoding: "utf-8",
          env: {
            ...process.env,
            HOME: tmp,
            INSTALLER,
            PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
            SANDBOX: "hermes",
          },
        },
      );

      expect(result.status, result.stderr).toBe(status);
      expect(result.stdout).toBe(output);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
