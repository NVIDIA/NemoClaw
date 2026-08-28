// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const HOLD = path.join(ROOT, "scripts", "managed-startup-hold.sh");
const MESSAGING_PERSISTENCE = path.join(ROOT, "src", "lib", "messaging", "persistence.ts");

function executable(target: string, contents: string): void {
  fs.writeFileSync(target, contents, { mode: 0o755 });
  fs.chmodSync(target, 0o755);
}

type FakeIdentity = {
  readonly currentUid: number;
  readonly currentGid: number;
  readonly sandboxUid: number;
  readonly sandboxGid: number;
};

function fakeIdScript(identity: FakeIdentity): string {
  return `#!/bin/sh
case "$*" in
  "-u") printf '${String(identity.currentUid)}\\n' ;;
  "-g") printf '${String(identity.currentGid)}\\n' ;;
  "-u sandbox") printf '${String(identity.sandboxUid)}\\n' ;;
  "-g sandbox") printf '${String(identity.sandboxGid)}\\n' ;;
  *) exit 1 ;;
esac
`;
}

function runHoldWithFakeIdentity(identity: FakeIdentity, args: readonly string[]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-hold-identity-"));
  try {
    const script = path.join(directory, "hold.sh");
    executable(path.join(directory, "id"), fakeIdScript(identity));
    fs.writeFileSync(
      script,
      fs
        .readFileSync(HOLD, "utf8")
        .replace(
          'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
          'export PATH="$TEST_PATH"',
        ),
      { mode: 0o755 },
    );
    return spawnSync(script, [...args], {
      encoding: "utf8",
      env: { ...process.env, TEST_PATH: directory },
    });
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
}

describe("managed startup image hold", () => {
  it("pins privileged Bash, consumes the identity delimiter, and delegates only to the fixed entrypoint", () => {
    const source = fs.readFileSync(HOLD, "utf8");

    expect(source.startsWith("#!/bin/bash -p\n")).toBe(true);
    expect(source).toContain('[ "$5" = "--bootstrap-identity" ]');
    expect(source).toContain('[ "$7" = "--" ]');
    expect(source).toContain('--bootstrap-identity "$_nemoclaw_bootstrap_identity"');
    expect(source).toContain(
      'exec "${_nemoclaw_scrubbed_env[@]}" /usr/local/bin/nemoclaw-start "$@"',
    );
    expect(source.match(/^exec /gmu)).toHaveLength(1);
  });

  it("keeps the bundled image runtime independent of the host-only channel policy parser", () => {
    const persistence = fs.readFileSync(MESSAGING_PERSISTENCE, "utf8");

    expect(persistence).toContain('from "./channels/built-ins"');
    expect(persistence).toContain('from "./channels/template-resolver"');
    expect(persistence).not.toMatch(/from ["']\.\/channels["']/u);
  });

  it.each([
    "openclaw",
    "hermes",
    "langchain-deepagents-code",
  ] as const)("enters the %s legacy startup as sandbox after the exact handoff", (agent) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-hold-"));
    try {
      const trace = path.join(directory, "trace");
      const runtime = path.join(directory, "runtime.cjs");
      const runtimeEnvironment = path.join(directory, "runtime.env");
      const script = path.join(directory, "hold.sh");
      fs.writeFileSync(runtime, "");
      fs.writeFileSync(runtimeEnvironment, "export NEMOCLAW_MANAGED_STARTUP_APPLIED='1'\n", {
        mode: 0o444,
      });
      executable(
        path.join(directory, "id"),
        fakeIdScript({
          currentUid: 1000,
          currentGid: 1000,
          sandboxUid: 1000,
          sandboxGid: 1000,
        }),
      );
      executable(path.join(directory, "stat"), "#!/bin/sh\nprintf '0:0:444\\n'\n");
      executable(path.join(directory, "node"), `#!/bin/sh\nprintf 'node:%s\\n' "$*" >>"$TRACE"\n`);
      executable(
        path.join(directory, "nemoclaw-start"),
        `#!/bin/bash
if declare -F attacker >/dev/null; then attacker; fi
case ":$SHELLOPTS:" in *:xtrace:*) printf 'attacker:shellopts\\n' >>"$TRACE" ;; esac
case ":$BASHOPTS:" in *:extdebug:*) printf 'attacker:bashopts\\n' >>"$TRACE" ;; esac
printf 'start:%s:%s:%s:%s:%s:%s\\n' "$NEMOCLAW_MANAGED_STARTUP_APPLIED" "\${NEMOCLAW_STARTUP_PROFILE_B64-unset}" "\${NEMOCLAW_CORPORATE_CA_B64-unset}" "\${BASH_ENV-unset}" "\${NODE_OPTIONS-unset}" "$*" >>"$TRACE"
`,
      );
      const attacker = path.join(directory, "attacker.sh");
      fs.writeFileSync(attacker, `printf 'attacker:bash-env\\n' >>"$TRACE"\n`);
      const source = fs
        .readFileSync(HOLD, "utf8")
        .replace(
          'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
          'export PATH="$TEST_PATH"',
        )
        .replace(
          '_nemoclaw_runtime="/usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs"',
          `_nemoclaw_runtime=${JSON.stringify(runtime)}`,
        )
        .replace(
          '_nemoclaw_runtime_env="/run/nemoclaw/managed-startup-runtime.env"',
          `_nemoclaw_runtime_env=${JSON.stringify(runtimeEnvironment)}`,
        )
        .replace("/usr/local/bin/node", path.join(directory, "node"))
        .replace("/usr/local/bin/nemoclaw-start", path.join(directory, "nemoclaw-start"));
      fs.writeFileSync(script, source, { mode: 0o755 });
      fs.chmodSync(script, 0o755);
      const fingerprint = "a".repeat(64);
      const bootstrapIdentity = "b".repeat(64);

      execFileSync(
        script,
        [
          "--agent",
          agent,
          "--profile-fingerprint",
          fingerprint,
          "--bootstrap-identity",
          bootstrapIdentity,
          "--",
          "/bin/sh",
          "-c",
          "exec tail -f /dev/null",
        ],
        {
          env: {
            ...process.env,
            TRACE: trace,
            TEST_PATH: directory,
            NEMOCLAW_STARTUP_PROFILE_B64: "must-drop",
            NEMOCLAW_CORPORATE_CA_B64: "must-drop",
            BASH_ENV: attacker,
            ENV: attacker,
            NODE_OPTIONS: "--require=/sandbox/attacker.cjs",
            SHELLOPTS: "xtrace",
            BASHOPTS: "extdebug",
            "BASH_FUNC_attacker%%": '() { printf "attacker:function\\n" >>"$TRACE"; }',
          },
        },
      );

      expect(fs.readFileSync(trace, "utf8").trim().split("\n")).toEqual([
        `node:${runtime} --wait-for-completion --agent ${agent} --profile-fingerprint ${fingerprint} --bootstrap-identity ${bootstrapIdentity}`,
        "start:1:unset:unset:unset:unset:/bin/sh -c exec tail -f /dev/null",
      ]);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it.each([
    {
      label: "root supervisor identity",
      identity: { currentUid: 0, currentGid: 0, sandboxUid: 1000, sandboxGid: 1000 },
    },
    {
      label: "non-sandbox group",
      identity: { currentUid: 1000, currentGid: 1001, sandboxUid: 1000, sandboxGid: 1000 },
    },
  ])("rejects $label before invoking the managed runtime", ({ identity }) => {
    const result = runHoldWithFakeIdentity(identity, [
      "--agent",
      "openclaw",
      "--profile-fingerprint",
      "a".repeat(64),
      "--bootstrap-identity",
      "b".repeat(64),
      "--",
    ]);
    expect(result.status).not.toBe(0);
    expect(String(result.stderr ?? "")).toContain("must run as the sandbox account");
  });

  it("rejects unsupported agents before invoking the runtime", () => {
    const result = runHoldWithFakeIdentity(
      { currentUid: 1000, currentGid: 1000, sandboxUid: 1000, sandboxGid: 1000 },
      [
        "--agent",
        "unknown",
        "--profile-fingerprint",
        "a".repeat(64),
        "--bootstrap-identity",
        "b".repeat(64),
        "--",
      ],
    );
    expect(result.status).not.toBe(0);
    expect(String(result.stderr ?? "")).toContain("agent is unsupported");
  });

  it.each([
    {
      args: [
        "--agent",
        "openclaw",
        "--profile-fingerprint",
        "a".repeat(64),
        "--bootstrap-identity",
        "invalid",
        "--",
      ],
      message: "bootstrap identity must be lowercase SHA-256",
    },
    {
      args: [
        "--agent",
        "openclaw",
        "--profile-fingerprint",
        "a".repeat(64),
        "--bootstrap-identity",
        "b".repeat(64),
        "/bin/sh",
      ],
      message: "startup argument delimiter is missing",
    },
  ])("rejects malformed identity-bound grammar: $message", ({ args, message }) => {
    const result = runHoldWithFakeIdentity(
      { currentUid: 1000, currentGid: 1000, sandboxUid: 1000, sandboxGid: 1000 },
      args,
    );
    expect(result.status).not.toBe(0);
    expect(String(result.stderr ?? "")).toContain(message);
  });
});
