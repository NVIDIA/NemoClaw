// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AGENT_ALIASES, resolveAgentNameAlias } from "../../src/lib/agent/aliases";
import { INSTALLER_PAYLOAD } from "../helpers/installer-sourced-env";

const INSTALLER = path.join(import.meta.dirname, "../..", "install.sh");
const temporaryDirectories: string[] = [];

function writeExecutable(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, { mode: 0o755 });
}

function replaceRequired(source: string, expected: string, replacement: string): string {
  expect(source).toContain(expected);
  return source.replace(expected, replacement);
}

function payloadCanonicalAgent(agent: string): string {
  const result = spawnSync(
    "bash",
    ["-c", 'source "$INSTALLER_PAYLOAD" >/dev/null; canonical_agent_name "$AGENT"'],
    {
      encoding: "utf8",
      env: { ...process.env, AGENT: agent, INSTALLER_PAYLOAD },
    },
  );
  expect(result.status).toBe(0);
  return result.stdout;
}

function runInstall(
  installedVersion: string,
  targetVersion: string,
  extraEnvironment: Record<string, string> = {},
  options: {
    lookupMaxOutputBytes?: number;
    lookupSignal?: "INT" | "TERM";
    lookupSignalBeforePid?: boolean;
    timeoutCleanupSignal?: "INT" | "TERM";
    tagLookupMaxOutputBytes?: number;
    lookupTimeoutSeconds?: number;
    useRealSleep?: boolean;
    useRealPayload?: boolean;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-downgrade-"));
  temporaryDirectories.push(root);
  const bin = path.join(root, "bin");
  const payloadMarker = path.join(root, "payload-ran");
  const lookupPid = path.join(root, "lookup.pid");
  const requestedAgent = extraEnvironment.NEMOCLAW_AGENT ?? "openclaw";
  const canonicalAgent = resolveAgentNameAlias(requestedAgent, [
    "openclaw",
    "hermes",
    "langchain-deepagents-code",
  ]);
  const cliName =
    canonicalAgent === "hermes"
      ? "nemohermes"
      : canonicalAgent === "langchain-deepagents-code"
        ? "nemo-deepagents"
        : "nemoclaw";
  fs.mkdirSync(bin);
  for (const installedCli of installedVersion === "absent" ? [] : [cliName]) {
    writeExecutable(
      path.join(bin, installedCli),
      `#!/usr/bin/env bash
case "${installedVersion}" in
  hang) /bin/sleep 60 ;;
  ignore-term) trap '' TERM; while :; do :; done ;;
  cancel-during-cleanup) trap 'touch "\${LOOKUP_PID:?}.term"' TERM; printf '%s' "$$" >"\${LOOKUP_PID:?}"; while :; do :; done ;;
  interrupt) printf '%s' "$$" >"\${LOOKUP_PID:?}"; exec /bin/sleep 60 ;;
  terminate) printf '%s' "$$" >"\${LOOKUP_PID:?}"; exec /bin/sleep 60 ;;
  descendant-ignore-term) (trap '' TERM; printf '%s' "\${BASHPID}" >"\${LOOKUP_PID:?}"; while :; do :; done) & exit 0 ;;
  signaled) kill -KILL "$$" ;;
  oversized) printf 'nemoclaw v0.0.108+'; printf '%0100d' 0 ;;
  invalid) printf 'not a NemoClaw version\n' ;;
  *) printf '${cliName} v%s\n' "${installedVersion}" ;;
esac
`,
    );
  }
  writeExecutable(
    path.join(bin, "git"),
    `#!/usr/bin/env bash
repo=''
if [[ "\${1:-}" == '-C' ]]; then
  repo="$2"
  shift 2
fi
case "\${1:-}" in
  init)
    target="\${@: -1}"
    mkdir -p "$target/scripts"
    cat >"$target/scripts/install.sh" <<'PAYLOAD'
#!/usr/bin/env bash
# NEMOCLAW_VERSIONED_INSTALLER_PAYLOAD=1
${
  options.useRealPayload
    ? `source "$INSTALLER_PAYLOAD" >/dev/null
resolve_repo_root() { printf '%s' "$NON_SOURCE_ROOT"; }
export RECORD_MANAGED_FETCH=1
install_nemoclaw`
    : `printf '%s|%s|%s' "\${NEMOCLAW_BOOTSTRAP_FETCH_REF:-}" "\${NEMOCLAW_INSTALL_REF:-}" "\${NEMOCLAW_INSTALL_TAG:-}" >"\${EXECUTION_MARKER:?}"`
}
PAYLOAD
    chmod +x "$target/scripts/install.sh"
    ;;
  remote)
    [[ "$*" == 'remote add origin https://github.com/NVIDIA/NemoClaw.git' ]] || exit 91
    ;;
  fetch)
    [[ "$2" == '--quiet' && "$3" == '--depth' && "$4" == '1' && "$5" == 'origin' && "$6" == +*:refs/nemoclaw-install/target && -z "\${7:-}" ]] || exit 92
    if [[ "\${RECORD_MANAGED_FETCH:-}" == 1 ]]; then printf '%s' "$6" >"\${EXECUTION_MARKER:?}"; fi
    ;;
  -c)
    [[ "$*" == '-c advice.detachedHead=false checkout --quiet --detach refs/nemoclaw-install/target' ]] || exit 93
    if [[ "\${RECORD_MANAGED_FETCH:-}" == 1 ]]; then exit 73; fi
    ;;
  rev-parse)
    printf 'target-commit\n'
    ;;
  ls-remote)
    if [[ "${targetVersion}" == 'hang' ]]; then
      /bin/sleep 60
    elif [[ "${targetVersion}" == annotated-* ]]; then
      version="${targetVersion.replace(/^annotated-/, "")}"
      printf 'tag-object\trefs/tags/v%s\n' "$version"
      printf 'target-commit\trefs/tags/v%s^{}\n' "$version"
    elif [[ "${targetVersion}" == 'many-tags' ]]; then
      for version in {1..20}; do
        printf 'other-%s\trefs/tags/v0.0.%s\n' "$version" "$version"
      done
      printf 'target-commit\trefs/tags/v0.0.109\n'
    else
      printf 'target-commit\trefs/tags/v%s\n' "${targetVersion}"
    fi
    ;;
  *) exit 94 ;;
esac
`,
  );
  const sleepBody = options.timeoutCleanupSignal
    ? `#!/usr/bin/env bash
if [[ -e "\${LOOKUP_PID:?}.term" && ! -e "\${LOOKUP_PID:?}.cancel" ]]; then
  touch "\${LOOKUP_PID:?}.cancel"
  kill -${options.timeoutCleanupSignal} "$PPID"
fi
exec /bin/sleep "$@"
`
    : options.useRealSleep
      ? '#!/usr/bin/env bash\nexec /bin/sleep "$@"\n'
      : ["hang", "ignore-term", "descendant-ignore-term"].includes(installedVersion) ||
          targetVersion === "hang"
        ? "#!/usr/bin/env bash\nexit 0\n"
        : '#!/usr/bin/env bash\nexec /bin/sleep "$@"\n';
  writeExecutable(path.join(bin, "sleep"), sleepBody);

  let installerSource = replaceRequired(
    replaceRequired(
      fs.readFileSync(INSTALLER, "utf8"),
      "BOOTSTRAP_LOOKUP_TIMEOUT_SECONDS=30",
      `BOOTSTRAP_LOOKUP_TIMEOUT_SECONDS=${options.lookupTimeoutSeconds ?? 30}`,
    ),
    "BOOTSTRAP_CLI_LOOKUP_MAX_OUTPUT_BYTES=65536",
    `BOOTSTRAP_CLI_LOOKUP_MAX_OUTPUT_BYTES=${options.lookupMaxOutputBytes ?? 65536}`,
  );
  installerSource = replaceRequired(
    installerSource,
    "BOOTSTRAP_TAG_LOOKUP_MAX_OUTPUT_BYTES=1048576",
    `BOOTSTRAP_TAG_LOOKUP_MAX_OUTPUT_BYTES=${options.tagLookupMaxOutputBytes ?? 1048576}`,
  );
  const signalAnchor = options.lookupSignalBeforePid
    ? "  command_pid=$!"
    : '  while bootstrap_lookup_group_is_alive "$command_pid"; do';
  installerSource = options.lookupSignal
    ? replaceRequired(
        installerSource,
        signalAnchor,
        `
  while [[ ! -s "\${LOOKUP_PID:?}" ]]; do :; done
  /bin/bash -c 'kill -${options.lookupSignal} "$PPID"'
${signalAnchor}`,
      )
    : installerSource;

  const result = spawnSync("bash", [], {
    cwd: root,
    input: installerSource,
    encoding: "utf8",
    env: {
      HOME: root,
      PATH: `${bin}:/usr/bin:/bin`,
      EXECUTION_MARKER: payloadMarker,
      INSTALLER_PAYLOAD,
      NON_SOURCE_ROOT: path.join(root, "not-a-checkout"),
      LOOKUP_PID: lookupPid,
      TMPDIR: root,
      ...extraEnvironment,
    },
  });
  return { lookupPid, payloadMarker, result, root };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("public installer downgrade guard", () => {
  it("keeps the installed CLI when the implicit lkg release is older (#11160)", () => {
    const { result, payloadMarker } = runInstall("0.0.118", "0.0.109");

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "Refusing to replace installed NemoClaw v0.0.118 with maintained lkg v0.0.109.",
    );
    expect(`${result.stdout}${result.stderr}`).toContain("The installed CLI was not changed.");
    expect(fs.existsSync(payloadMarker)).toBe(false);
  });

  it.each([
    ["Hermes", "hermes"],
    ["Deep Agents", "langchain-deepagents-code"],
  ])("keeps the installed %s CLI when the implicit lkg release is older", (_label, agent) => {
    const { result, payloadMarker } = runInstall("0.0.118", "0.0.109", {
      NEMOCLAW_AGENT: agent,
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "Refusing to replace installed NemoClaw v0.0.118 with maintained lkg v0.0.109.",
    );
    expect(fs.existsSync(payloadMarker)).toBe(false);
  });

  it.each([
    ...Object.entries(AGENT_ALIASES),
    ["Hermes", "hermes"],
    ["Nemo Hermes", "hermes"],
    ["deep_agents", "langchain-deepagents-code"],
    ["NEMO_DEEPAGENTS", "langchain-deepagents-code"],
    ["Deep Agents", "langchain-deepagents-code"],
    ["LANGCHAIN", "langchain-deepagents-code"],
  ])("uses the payload's canonical CLI for the %s alias", (agent, canonicalAgent) => {
    expect(payloadCanonicalAgent(agent)).toBe(canonicalAgent);
    const { result, payloadMarker } = runInstall("0.0.118", "0.0.109", {
      NEMOCLAW_AGENT: agent,
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "Refusing to replace installed NemoClaw v0.0.118 with maintained lkg v0.0.109.",
    );
    expect(fs.existsSync(payloadMarker)).toBe(false);
  });

  it.each([
    ["the implicit lkg release is newer", "0.0.108", "v0.0.109"],
    ["no CLI is installed", "absent", "lkg"],
  ])("runs the selected payload when %s", (_condition, installedVersion, selectedRef) => {
    const { result, payloadMarker, root } = runInstall(installedVersion, "0.0.109");

    expect(result.status).toBe(0);
    expect(fs.existsSync(payloadMarker)).toBe(true);
    expect(fs.readFileSync(payloadMarker, "utf8")).toBe(`target-commit|${selectedRef}|lkg`);
    expect(
      fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    ).toEqual(["bin"]);
  });

  it("runs the selected payload when the implicit lkg release is unchanged", () => {
    const { result, payloadMarker } = runInstall("0.0.109", "0.0.109");

    expect(result.status).toBe(0);
    expect(fs.existsSync(payloadMarker)).toBe(true);
    expect(fs.readFileSync(payloadMarker, "utf8")).toBe("target-commit|v0.0.109|lkg");
  });

  it("keeps a newer installed prerelease when the implicit lkg release is older", () => {
    const { result, payloadMarker } = runInstall("0.0.119-rc.1", "0.0.118");

    expect(result.status).toBe(1);
    expect(fs.existsSync(payloadMarker)).toBe(false);
  });

  it("keeps a stable install when lkg resolves only to the same-core prerelease", () => {
    const { result, payloadMarker } = runInstall("0.0.109", "0.0.109-rc.1");

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "Cannot verify the maintained lkg version before replacing installed NemoClaw v0.0.109.",
    );
    expect(fs.existsSync(payloadMarker)).toBe(false);
  });

  it("accepts the peeled commit from an annotated maintained release tag", () => {
    const { result, payloadMarker } = runInstall("0.0.108", "annotated-0.0.109");

    expect(result.status).toBe(0);
    expect(fs.existsSync(payloadMarker)).toBe(true);
  });

  it("finds the maintained release tag beyond the CLI output bound", () => {
    const { result, payloadMarker } = runInstall(
      "0.0.108",
      "many-tags",
      {},
      {
        lookupMaxOutputBytes: 32,
        tagLookupMaxOutputBytes: 2048,
      },
    );

    expect(result.status).toBe(0);
    expect(fs.existsSync(payloadMarker)).toBe(true);
    expect(fs.readFileSync(payloadMarker, "utf8")).toBe("target-commit|v0.0.109|lkg");
  });

  it("fails closed and cleans up when release tag output exceeds its bound", () => {
    const { result, payloadMarker, root } = runInstall(
      "0.0.108",
      "many-tags",
      {},
      {
        tagLookupMaxOutputBytes: 32,
      },
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "Cannot verify the maintained lkg version before replacing installed NemoClaw v0.0.108.",
    );
    expect(fs.existsSync(payloadMarker)).toBe(false);
    expect(
      fs.readdirSync(root).filter((name) => name.startsWith("nemoclaw-bootstrap-lookup.")),
    ).toEqual([]);
  });

  it("runs an older release when the user selects its tag", () => {
    const { result, payloadMarker } = runInstall("0.0.118", "0.0.109", {
      NEMOCLAW_INSTALL_TAG: "v0.0.109",
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(payloadMarker)).toBe(true);
    expect(fs.readFileSync(payloadMarker, "utf8")).toBe("target-commit|v0.0.109|v0.0.109");
  });

  it("runs an older release when the user selects another explicit ref", () => {
    const { result, payloadMarker } = runInstall("0.0.118", "0.0.109", {
      NEMOCLAW_INSTALL_TAG: "latest",
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(payloadMarker)).toBe(true);
    expect(fs.readFileSync(payloadMarker, "utf8")).toBe("target-commit|latest|latest");
  });

  it("keeps the installed CLI when lkg is selected explicitly", () => {
    const { result, payloadMarker } = runInstall("0.0.118", "0.0.109", {
      NEMOCLAW_INSTALL_TAG: "lkg",
    });

    expect(result.status).toBe(1);
    expect(fs.existsSync(payloadMarker)).toBe(false);
  });

  it("keeps the installed CLI when the fully qualified lkg tag is selected", () => {
    const { result, payloadMarker } = runInstall("0.0.118", "0.0.109", {
      NEMOCLAW_INSTALL_TAG: "refs/tags/lkg",
    });

    expect(result.status).toBe(1);
    expect(fs.existsSync(payloadMarker)).toBe(false);
  });

  it.each(["lkg", "refs/tags/lkg"])(
    "keeps the installed CLI when NEMOCLAW_INSTALL_REF selects %s",
    (installRef) => {
      const { result, payloadMarker } = runInstall("0.0.118", "0.0.109", {
        NEMOCLAW_INSTALL_REF: installRef,
      });

      expect(result.status).toBe(1);
      expect(fs.existsSync(payloadMarker)).toBe(false);
    },
  );

  it("fails closed when the installed CLI reports an invalid version", () => {
    const { result, payloadMarker } = runInstall("invalid", "0.0.109");

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "Cannot verify the installed NemoClaw version",
    );
    expect(fs.existsSync(payloadMarker)).toBe(false);
  });

  it("fails closed when the installed version lookup is killed", () => {
    const { result, payloadMarker } = runInstall("signaled", "0.0.109");

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "Cannot verify the installed NemoClaw version",
    );
    expect(fs.existsSync(payloadMarker)).toBe(false);
  });

  it("fails closed and cleans up when installed CLI output exceeds the bound", () => {
    const { result, payloadMarker, root } = runInstall(
      "oversized",
      "0.0.109",
      {},
      {
        lookupMaxOutputBytes: 32,
      },
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "Cannot verify the installed NemoClaw version",
    );
    expect(fs.existsSync(payloadMarker)).toBe(false);
    expect(
      fs.readdirSync(root).filter((name) => name.startsWith("nemoclaw-bootstrap-lookup.")),
    ).toEqual([]);
  });

  it("keeps the installed CLI when the implicit lkg version cannot be verified", () => {
    const { result, payloadMarker } = runInstall("0.0.118", "unknown");

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "Cannot verify the maintained lkg version before replacing installed NemoClaw v0.0.118.",
    );
    expect(fs.existsSync(payloadMarker)).toBe(false);
  });

  it.each([
    ["installed NemoClaw version lookup", "hang", "0.0.109"],
    ["installed NemoClaw version lookup", "ignore-term", "0.0.109"],
    ["maintained release tag lookup", "0.0.108", "hang"],
  ])(
    "bounds the %s",
    (label, installedVersion, targetVersion) => {
      const { result, payloadMarker } = runInstall(installedVersion, targetVersion);

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(`Timed out during ${label}`);
      expect(`${result.stdout}${result.stderr}`).toContain("The installed CLI was not changed.");
      expect(fs.existsSync(payloadMarker)).toBe(false);
    },
    15_000,
  );

  it("waits for the configured lookup deadline when real sleep is used", () => {
    const startedAt = performance.now();
    const { result, payloadMarker } = runInstall(
      "hang",
      "0.0.109",
      {},
      {
        lookupTimeoutSeconds: 1,
        useRealSleep: true,
      },
    );
    const elapsedMs = performance.now() - startedAt;

    expect(result.status).toBe(1);
    expect(elapsedMs).toBeGreaterThanOrEqual(900);
    expect(elapsedMs).toBeLessThan(10_000);
    expect(fs.existsSync(payloadMarker)).toBe(false);
  }, 15_000);

  it.each([
    ["interrupted during lookup", "interrupt", "INT", 130, false],
    ["terminated during lookup", "terminate", "TERM", 143, false],
    ["interrupted before PID recording", "interrupt", "INT", 130, true],
    ["terminated before PID recording", "terminate", "TERM", 143, true],
  ] as const)(
    "cleans up an active lookup when the installer is %s",
    (_label, mode, signal, status, beforePid) => {
      const { lookupPid, payloadMarker, result, root } = runInstall(
        mode,
        "0.0.109",
        {},
        {
          lookupSignal: signal,
          lookupSignalBeforePid: beforePid,
        },
      );

      const pid = Number(fs.readFileSync(lookupPid, "utf8"));
      try {
        expect(result.status).toBe(status);
        expect(fs.existsSync(payloadMarker)).toBe(false);
        expect(
          fs.readdirSync(root).filter((name) => name.startsWith("nemoclaw-bootstrap-lookup.")),
        ).toEqual([]);
        expect(
          fs
            .readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name),
        ).toEqual(["bin"]);
        const processState = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
          encoding: "utf8",
        });
        expect(processState.status === 1 || processState.stdout.trim().startsWith("Z")).toBe(true);
      } finally {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
        }
      }
    },
  );

  it.each([
    ["INT", 130],
    ["TERM", 143],
  ] as const)(
    "finishes timeout cleanup when it receives SIG%s during termination",
    (signal, status) => {
      const { lookupPid, payloadMarker, result, root } = runInstall(
        "cancel-during-cleanup",
        "0.0.109",
        {},
        { lookupTimeoutSeconds: 1, timeoutCleanupSignal: signal },
      );
      const pid = Number(fs.readFileSync(lookupPid, "utf8"));

      try {
        expect(fs.existsSync(`${lookupPid}.cancel`)).toBe(true);
        expect(result.status).toBe(status);
        expect(fs.existsSync(payloadMarker)).toBe(false);
        const processState = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
          encoding: "utf8",
        });
        expect(processState.status === 1 || processState.stdout.trim().startsWith("Z")).toBe(true);
        expect(
          fs.readdirSync(root).filter((name) => name.startsWith("nemoclaw-bootstrap-lookup.")),
        ).toEqual([]);
      } finally {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
        }
      }
    },
    15_000,
  );

  it("kills a lookup descendant after its process-group leader exits", () => {
    const { lookupPid, payloadMarker, result } = runInstall("descendant-ignore-term", "0.0.109");

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "Timed out during installed NemoClaw version lookup",
    );
    expect(fs.existsSync(payloadMarker)).toBe(false);
    const pid = Number(fs.readFileSync(lookupPid, "utf8"));
    const processState = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    });
    expect(processState.status === 1 || processState.stdout.trim().startsWith("Z")).toBe(true);
  }, 15_000);
});

describe("versioned installer payload ref selection", () => {
  it("passes the public bootstrap commit through the real payload to the managed clone", () => {
    const { result, payloadMarker } = runInstall(
      "0.0.108",
      "0.0.109",
      {
        NEMOCLAW_INSTALL_REF: "lkg",
        NEMOCLAW_INSTALL_TAG: "v0.0.108",
      },
      { useRealPayload: true },
    );

    expect(result.status).toBe(73);
    expect(fs.readFileSync(payloadMarker, "utf8")).toBe(
      "+target-commit:refs/nemoclaw-install/target",
    );
  });
});
