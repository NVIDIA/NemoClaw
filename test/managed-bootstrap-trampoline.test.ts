// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { MANAGED_STARTUP_AGENTS } from "../src/lib/onboard/managed-startup/profile";

const ROOT = path.resolve(import.meta.dirname, "..");
const TRAMPOLINE = path.join(ROOT, "scripts", "managed-bootstrap-trampoline.sh");

function executable(target: string, contents: string): void {
  fs.writeFileSync(target, contents, { mode: 0o755 });
  fs.chmodSync(target, 0o755);
}

describe("managed bootstrap image trampoline", () => {
  it("uses the absolute image-owned Bash interpreter even with an attacker PATH", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bootstrap-path-"));
    try {
      const attackerTrace = path.join(directory, "attacker-trace");
      executable(
        path.join(directory, "bash"),
        `#!/bin/sh\nprintf 'attacker bash ran\\n' >${JSON.stringify(attackerTrace)}\n`,
      );
      const result = spawnSync(TRAMPOLINE, [], {
        encoding: "utf8",
        env: { ...process.env, PATH: directory },
      });

      expect(result.status).not.toBe(0);
      expect(fs.existsSync(attackerTrace)).toBe(false);
      expect(
        fs.readFileSync(TRAMPOLINE, "utf8").startsWith("#!/usr/bin/env -S -u BASH_ENV /bin/bash\n"),
      ).toBe(true);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("clears inherited BASH_ENV before the root Bash interpreter starts", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bootstrap-bash-env-"));
    try {
      const attackerTrace = path.join(directory, "attacker-trace");
      const bashEnv = path.join(directory, "bash-env");
      fs.writeFileSync(
        bashEnv,
        `printf 'attacker startup ran\\n' >${JSON.stringify(attackerTrace)}\n`,
      );

      const result = spawnSync(TRAMPOLINE, [], {
        encoding: "utf8",
        env: { ...process.env, BASH_ENV: bashEnv },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Managed bootstrap trampoline");
      expect(fs.existsSync(attackerTrace)).toBe(false);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it.each(
    MANAGED_STARTUP_AGENTS,
  )("consumes the protected %s request before exact supervisor exec and drops bootstrap variables", (agent) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bootstrap-trampoline-"));
    try {
      const request = path.join(directory, "request.json");
      const completion = path.join(directory, "completion");
      const runtime = path.join(directory, "runtime.cjs");
      const sandbox = path.join(directory, "sandbox");
      const trace = path.join(directory, "trace");
      const script = path.join(directory, "trampoline.sh");
      const supervisor = path.join(directory, "supervisor");
      const injection = path.join(directory, "injection");
      fs.mkdirSync(sandbox);
      fs.writeFileSync(runtime, "");
      fs.writeFileSync(request, "{}\n", { mode: 0o400 });
      executable(
        path.join(directory, "id"),
        `#!/bin/sh
case "$*" in
  "-u") printf '0\\n' ;;
  "-g") printf '0\\n' ;;
  "-u sandbox") printf '1000\\n' ;;
  "-g sandbox") printf '1000\\n' ;;
  *) exit 1 ;;
esac
`,
      );
      executable(path.join(directory, "stat"), "#!/bin/sh\nprintf '0:0:400:1\\n'\n");
      executable(path.join(directory, "rm"), '#!/bin/sh\nexec /bin/rm "$@"\n');
      executable(
        path.join(directory, "node"),
        `#!/bin/sh
printf 'node:%s:home=%s:path=%s:lang=%s:capability=%s\\n' "$*" "$HOME" "$PATH" "$LANG" "$NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION" >>${JSON.stringify(trace)}
case "$*" in
  *--apply-bootstrap-file*)
    /bin/rm -f ${JSON.stringify(request)}
    printf '%s\\n' '${agent}:${"a".repeat(64)}:${"b".repeat(64)}' >${JSON.stringify(completion)}
    ;;
  *--verify-bootstrap-completion*)
    test "$(/bin/cat ${JSON.stringify(completion)})" = '${agent}:${"a".repeat(64)}:${"b".repeat(64)}'
    ;;
esac
`,
      );
      executable(
        supervisor,
        `#!/bin/sh
set -e
test ! -e "$REQUEST"
test "$#" -eq 3
test "$1" = "supervise"
test "$2" = "two words"
test "$3" = "\\$(touch ${injection})"
test ! -e ${JSON.stringify(injection)}
test "\${BASH_ENV-unset}" = "unset"
printf 'supervisor:%s|%s|%s:identity=%s:request=%s:home=%s:path=%s:lang=%s:capability=%s:bash-env=%s\\n' "$1" "$2" "$3" "\${_nemoclaw_bootstrap_identity-unset}" "\${_nemoclaw_request-unset}" "$HOME" "$PATH" "$LANG" "\${NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION-unset}" "\${BASH_ENV-unset}" >>"$TRACE"
`,
      );
      const source = fs
        .readFileSync(TRAMPOLINE, "utf8")
        .replaceAll("/usr/bin/id", path.join(directory, "id"))
        .replaceAll("/usr/bin/stat", path.join(directory, "stat"))
        .replaceAll("/usr/bin/rm", path.join(directory, "rm"))
        .replace(
          '_nemoclaw_runtime="/usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs"',
          `_nemoclaw_runtime=${JSON.stringify(runtime)}`,
        )
        .replaceAll("/var/lib/nemoclaw-managed-bootstrap-request.json", request)
        .replaceAll("/sandbox", sandbox)
        .replaceAll("/usr/local/bin/node", path.join(directory, "node"));
      fs.writeFileSync(script, source, { mode: 0o755 });
      fs.chmodSync(script, 0o755);
      const fingerprint = "a".repeat(64);
      const identity = "b".repeat(64);
      const argv = [
        "--agent",
        agent,
        "--profile-fingerprint",
        fingerprint,
        "--bootstrap-identity",
        identity,
        "--agent-uid",
        "1000",
        "--agent-gid",
        "1000",
        "--agent-workdir",
        sandbox,
        "--request-file",
        request,
        "--",
        supervisor,
        "supervise",
        "two words",
        `$(touch ${injection})`,
      ];
      const environment = {
        REQUEST: request,
        TRACE: trace,
        BASH_ENV: path.join(directory, "missing-attacker-startup"),
        HOME: "/preserved-home",
        PATH: "/preserved-path",
        LANG: "zz_TEST",
        NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "preserved-capability",
      };

      execFileSync(script, argv, { env: environment });

      expect(fs.existsSync(request)).toBe(false);
      expect(fs.existsSync(injection)).toBe(false);
      expect(fs.readFileSync(trace, "utf8").trim().split("\n")).toEqual([
        `node:${runtime} --apply-bootstrap-file --agent ${agent} --profile-fingerprint ${fingerprint} --bootstrap-identity ${identity}:home=/root:path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:lang=C.UTF-8:capability=1`,
        `node:${runtime} --verify-bootstrap-completion --agent ${agent} --profile-fingerprint ${fingerprint} --bootstrap-identity ${identity}:home=/root:path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:lang=C.UTF-8:capability=1`,
        `supervisor:supervise|two words|$(touch ${injection}):identity=unset:request=unset:home=/preserved-home:path=/preserved-path:lang=zz_TEST:capability=preserved-capability:bash-env=unset`,
      ]);

      execFileSync(script, argv, { env: environment });
      let lines = fs.readFileSync(trace, "utf8").trim().split("\n");
      expect(lines.filter((line) => line.includes("--apply-bootstrap-file"))).toHaveLength(1);
      expect(lines.filter((line) => line.startsWith("supervisor:"))).toHaveLength(2);

      fs.writeFileSync(completion, `${agent}:${fingerprint}:${"c".repeat(64)}\n`);
      const tamperedRestart = spawnSync(script, argv, {
        encoding: "utf8",
        env: environment,
      });
      expect(tamperedRestart.status).not.toBe(0);
      lines = fs.readFileSync(trace, "utf8").trim().split("\n");
      expect(lines.filter((line) => line.includes("--apply-bootstrap-file"))).toHaveLength(1);
      expect(lines.filter((line) => line.startsWith("supervisor:"))).toHaveLength(2);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });
});
