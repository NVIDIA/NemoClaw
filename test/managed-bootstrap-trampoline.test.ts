// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const TRAMPOLINE = path.join(ROOT, "scripts", "managed-bootstrap-trampoline.sh");

function executable(target: string, contents: string): void {
  fs.writeFileSync(target, contents, { mode: 0o755 });
  fs.chmodSync(target, 0o755);
}

describe("managed bootstrap image trampoline", () => {
  it("uses an absolute image-owned Bash interpreter", () => {
    expect(fs.readFileSync(TRAMPOLINE, "utf8").startsWith("#!/bin/bash\n")).toBe(true);
  });

  it("consumes the protected request before exact supervisor exec and drops bootstrap variables", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bootstrap-trampoline-"));
    try {
      const request = path.join(directory, "request.json");
      const completion = path.join(directory, "completion");
      const runtime = path.join(directory, "runtime.cjs");
      const sandbox = path.join(directory, "sandbox");
      const trace = path.join(directory, "trace");
      const script = path.join(directory, "trampoline.sh");
      const supervisor = path.join(directory, "supervisor");
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
    printf '%s\\n' 'hermes:${"a".repeat(64)}:${"b".repeat(64)}' >${JSON.stringify(completion)}
    ;;
  *--verify-bootstrap-completion*)
    test "$(/bin/cat ${JSON.stringify(completion)})" = 'hermes:${"a".repeat(64)}:${"b".repeat(64)}'
    ;;
esac
`,
      );
      executable(
        supervisor,
        `#!/bin/sh
test ! -e "$REQUEST"
printf 'supervisor:%s:identity=%s:request=%s:home=%s:path=%s:lang=%s:capability=%s\\n' "$*" "\${_nemoclaw_bootstrap_identity-unset}" "\${_nemoclaw_request-unset}" "$HOME" "$PATH" "$LANG" "\${NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION-unset}" >>"$TRACE"
`,
      );
      const source = fs
        .readFileSync(TRAMPOLINE, "utf8")
        .replace("#!/usr/bin/env bash", "#!/bin/bash")
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

      execFileSync(
        script,
        [
          "--agent",
          "hermes",
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
          "--foreground",
        ],
        {
          env: {
            REQUEST: request,
            TRACE: trace,
            HOME: "/preserved-home",
            PATH: "/preserved-path",
            LANG: "zz_TEST",
            NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "preserved-capability",
          },
        },
      );

      expect(fs.existsSync(request)).toBe(false);
      expect(fs.readFileSync(trace, "utf8").trim().split("\n")).toEqual([
        `node:${runtime} --apply-bootstrap-file --agent hermes --profile-fingerprint ${fingerprint} --bootstrap-identity ${identity}:home=/root:path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:lang=C.UTF-8:capability=1`,
        `node:${runtime} --verify-bootstrap-completion --agent hermes --profile-fingerprint ${fingerprint} --bootstrap-identity ${identity}:home=/root:path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:lang=C.UTF-8:capability=1`,
        "supervisor:supervise --foreground:identity=unset:request=unset:home=/preserved-home:path=/preserved-path:lang=zz_TEST:capability=preserved-capability",
      ]);

      execFileSync(
        script,
        [
          "--agent",
          "hermes",
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
          "--foreground",
        ],
        {
          env: {
            REQUEST: request,
            TRACE: trace,
            HOME: "/preserved-home",
            PATH: "/preserved-path",
            LANG: "zz_TEST",
            NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "preserved-capability",
          },
        },
      );
      let lines = fs.readFileSync(trace, "utf8").trim().split("\n");
      expect(lines.filter((line) => line.includes("--apply-bootstrap-file"))).toHaveLength(1);
      expect(lines.filter((line) => line.startsWith("supervisor:"))).toHaveLength(2);

      fs.writeFileSync(completion, `hermes:${fingerprint}:${"c".repeat(64)}\n`);
      const tamperedRestart = spawnSync(
        script,
        [
          "--agent",
          "hermes",
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
          "--foreground",
        ],
        {
          encoding: "utf8",
          env: {
            REQUEST: request,
            TRACE: trace,
            HOME: "/preserved-home",
            PATH: "/preserved-path",
            LANG: "zz_TEST",
            NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "preserved-capability",
          },
        },
      );
      expect(tamperedRestart.status).not.toBe(0);
      lines = fs.readFileSync(trace, "utf8").trim().split("\n");
      expect(lines.filter((line) => line.includes("--apply-bootstrap-file"))).toHaveLength(1);
      expect(lines.filter((line) => line.startsWith("supervisor:"))).toHaveLength(2);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });
});
