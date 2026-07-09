// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GATEWAY_STOP_SCRIPT } from "./gateway-stop-script";

// Linux-only: execute the production shell script against real processes while
// scoping its ps snapshot to PIDs created by this test. This guards all gateway
// argv forms without risking unrelated developer or CI processes.
describe("GATEWAY_STOP_SCRIPT (executed)", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cp = require("node:child_process");
  const children: Array<{ pid?: number }> = [];
  const identityDirs: string[] = [];

  afterEach(() => {
    const pids = children
      .splice(0)
      .map((child) => child.pid)
      .filter((pid): pid is number => pid !== undefined);
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    for (const dir of identityDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function spawnWithArgv0(title: string): number {
    const child = cp.spawn("bash", ["-c", `exec -a '${title}' cat`], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    children.push(child);
    assert(child.pid, `failed to spawn process with argv0 ${title}`);
    return child.pid;
  }

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  function liveChildPids(): number[] {
    return children.map((child) => child.pid).filter((pid): pid is number => pid !== undefined);
  }

  function runStopScript(script = GATEWAY_STOP_SCRIPT, allowedPids = liveChildPids()): number {
    const scopedScript = `
allowed_test_pids="${allowedPids.join(" ")}"
ps() {
  if [ "$*" = "-eo user=,pid=,args=" ]; then
    command ps -eo user=,pid=,args= | awk -v allowed="$allowed_test_pids" '
      BEGIN {
        split(allowed, pids, " ")
        for (i in pids) if (pids[i] != "") keep[pids[i]] = 1
      }
      $2 in keep { print }
    '
  else
    command ps "$@"
  fi
}
${script}`;
    const result = cp.spawnSync("sh", ["-lc", scopedScript], {
      encoding: "utf-8",
      timeout: 20000,
    });
    assert(result.status !== null, `stop script did not exit: ${result.signal} ${result.stderr}`);
    return result.status;
  }

  function processStartTime(pid: number): string {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    return stat.replace(/^[^)]*\) /, "").split(" ")[19];
  }

  function identityFixture(
    pid: number,
    mode = 0o600,
    pidContent = `${pid} ${processStartTime(pid)}\n`,
  ): { script: string; pidFile: string; markerFile: string } {
    const dir = mkdtempSync(join(tmpdir(), "nemoclaw-gateway-stop-identity-"));
    identityDirs.push(dir);
    const pidFile = join(dir, "nemoclaw-gateway.pid");
    const markerFile = join(dir, "nemoclaw-gateway-local");
    writeFileSync(pidFile, pidContent, { mode });
    writeFileSync(markerFile, "", { mode });
    chmodSync(pidFile, mode);
    chmodSync(markerFile, mode);
    const script = GATEWAY_STOP_SCRIPT.replaceAll("/tmp/nemoclaw-gateway.pid", pidFile)
      .replaceAll("/tmp/nemoclaw-gateway-local", markerFile)
      .replace(
        'allowed_bare_users="gateway,sandbox"',
        `allowed_bare_users="gateway,sandbox,${process.env.USER ?? ""}"`,
      )
      .replace("root|gateway|sandbox) ;;", `root|gateway|sandbox|${process.env.USER ?? ""}) ;;`);
    return { script, pidFile, markerFile };
  }

  function stopScriptWithGatewayIdentity(
    pid: number,
    mode = 0o600,
    pidContent = `${pid} ${processStartTime(pid)}\n`,
  ): string {
    return identityFixture(pid, mode, pidContent).script;
  }

  it.runIf(process.platform === "linux")("kills openclaw-gateway argv0 process", async () => {
    const pid = spawnWithArgv0("openclaw-gateway");
    expect(runStopScript()).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(isAlive(pid)).toBe(false);
  });

  it.runIf(process.platform === "linux")("kills openclaw gateway run command form", async () => {
    const pid = spawnWithArgv0("openclaw gateway run");
    expect(runStopScript()).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(isAlive(pid)).toBe(false);
  });

  it.runIf(process.platform === "linux")(
    "finds and kills a gateway whose argv was rewritten to bare 'openclaw' (#4951)",
    async () => {
      const pid = spawnWithArgv0("openclaw");
      expect(runStopScript(stopScriptWithGatewayIdentity(pid))).toBe(0);
      await new Promise((r) => setTimeout(r, 300));
      expect(isAlive(pid)).toBe(false);
    },
  );

  it.runIf(process.platform === "linux")(
    "only signals PIDs spawned by this test when executing the stop script",
    async () => {
      const unrelated = spawnWithArgv0("openclaw-gateway");
      const intended = spawnWithArgv0("openclaw-gateway");
      expect(runStopScript(GATEWAY_STOP_SCRIPT, [intended])).toBe(0);
      await new Promise((r) => setTimeout(r, 300));
      expect(isAlive(intended)).toBe(false);
      expect(isAlive(unrelated)).toBe(true);
    },
  );

  it.runIf(process.platform === "linux")(
    "spares a bare openclaw process without gateway identity",
    () => {
      const decoy = spawnWithArgv0("openclaw");
      expect(runStopScript()).toBe(1);
      expect(isAlive(decoy)).toBe(true);
    },
  );

  it.runIf(process.platform === "linux")(
    "spares bare openclaw when gateway identity files are unsafe",
    () => {
      const decoy = spawnWithArgv0("openclaw");
      expect(runStopScript(stopScriptWithGatewayIdentity(decoy, 0o644))).toBe(1);
      expect(isAlive(decoy)).toBe(true);
    },
  );

  it.runIf(process.platform === "linux")("rejects symlinked gateway identity paths", () => {
    const decoy = spawnWithArgv0("openclaw");
    const { script, pidFile, markerFile } = identityFixture(decoy);
    const realPidFile = `${pidFile}.real`;
    unlinkSync(pidFile);
    writeFileSync(realPidFile, `${decoy} ${processStartTime(decoy)}\n`, {
      mode: 0o600,
    });
    symlinkSync(realPidFile, pidFile);

    expect(runStopScript(script)).toBe(1);
    expect(isAlive(decoy)).toBe(true);

    unlinkSync(pidFile);
    writeFileSync(pidFile, `${decoy} ${processStartTime(decoy)}\n`, {
      mode: 0o600,
    });
    unlinkSync(markerFile);
    symlinkSync(realPidFile, markerFile);
    expect(runStopScript(script)).toBe(1);
    expect(isAlive(decoy)).toBe(true);
  });

  it.runIf(process.platform === "linux")(
    "fails closed when the validated PID file pathname is replaced",
    () => {
      const intended = spawnWithArgv0("openclaw");
      const decoy = spawnWithArgv0("openclaw");
      const { script, pidFile } = identityFixture(intended);
      const replacement = `${decoy} ${processStartTime(decoy)}`;
      const replaceAfterOpen = `marker_owner="$(trusted_identity_fd "/proc/$$/fd/4" || true)"
  mv "${pidFile}" "${pidFile}.opened"
  printf '%s\\n' '${replacement}' >"${pidFile}"
  chmod 600 "${pidFile}"`;
      const racedScript = script.replace(
        'marker_owner="$(trusted_identity_fd "/proc/$$/fd/4" || true)"',
        replaceAfterOpen,
      );

      expect(runStopScript(racedScript, [intended, decoy])).toBe(1);
      expect(isAlive(intended)).toBe(true);
      expect(isAlive(decoy)).toBe(true);
    },
  );

  it.runIf(process.platform === "linux")(
    "rejects malformed gateway pid file contents instead of digit-stripping",
    () => {
      const decoy = spawnWithArgv0("openclaw");
      expect(runStopScript(stopScriptWithGatewayIdentity(decoy, 0o600, `x${decoy}y\n`))).toBe(1);
      expect(isAlive(decoy)).toBe(true);
    },
  );

  it.runIf(process.platform === "linux")(
    "rejects surplus fields in the trusted gateway PID record",
    () => {
      const decoy = spawnWithArgv0("openclaw");
      const content = `${decoy} ${processStartTime(decoy)} trailing\n`;
      expect(runStopScript(stopScriptWithGatewayIdentity(decoy, 0o600, content))).toBe(1);
      expect(isAlive(decoy)).toBe(true);
    },
  );

  it.runIf(process.platform === "linux")(
    "spares bare openclaw when gateway identity owner mismatches the process user",
    () => {
      const decoy = spawnWithArgv0("openclaw");
      const script = stopScriptWithGatewayIdentity(decoy).replace(
        '-v identity_owner="$pidfile_owner"',
        '-v identity_owner="sandbox"',
      );
      expect(runStopScript(script)).toBe(1);
      expect(isAlive(decoy)).toBe(true);
    },
  );

  it.runIf(process.platform === "linux")(
    "spares bare openclaw when trusted gateway identity is stale",
    () => {
      const decoy = spawnWithArgv0("openclaw");
      expect(runStopScript(stopScriptWithGatewayIdentity(decoy, 0o600, `${decoy} 1\n`))).toBe(1);
      expect(isAlive(decoy)).toBe(true);
    },
  );

  it.runIf(process.platform === "linux")(
    "treats a trusted record for a dead PID as not running",
    () => {
      const fixturePid = spawnWithArgv0("openclawish");
      const script = stopScriptWithGatewayIdentity(fixturePid, 0o600, "99999999 1\n");
      expect(runStopScript(script, [])).toBe(1);
      expect(isAlive(fixturePid)).toBe(true);
    },
  );

  it.runIf(process.platform === "linux")(
    "still stops an explicit gateway argv when the trusted PID record is stale",
    async () => {
      const gateway = spawnWithArgv0("openclaw-gateway");
      const script = stopScriptWithGatewayIdentity(gateway, 0o600, "99999999 1\n");
      expect(runStopScript(script, [gateway])).toBe(0);
      await new Promise((r) => setTimeout(r, 300));
      expect(isAlive(gateway)).toBe(false);
    },
  );

  it.runIf(process.platform === "linux")("spares non-gateway processes", () => {
    const decoy = spawnWithArgv0("openclawish");
    expect(runStopScript()).toBe(1);
    expect(isAlive(decoy)).toBe(true);
  });
});
