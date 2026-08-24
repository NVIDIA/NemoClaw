// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { makeStartScriptFixture } from "../../support/dcode-start-script-fixture.ts";

const START_SCRIPT = path.join(
  import.meta.dirname,
  "../../..",
  "agents",
  "langchain-deepagents-code",
  "start.sh",
);

const tempDirs: string[] = [];

type RlimitHelperInstaller = (helperPath: string, markerPath: string, tempDir: string) => void;

function installDefaultRlimitHelper(
  helperPath: string,
  markerPath: string,
  _tempDir: string,
): void {
  fs.writeFileSync(
    helperPath,
    [
      `harden_resource_limits() { printf '%s\\n' hardened > ${JSON.stringify(markerPath)}; }`,
      `verify_resource_limits_exact() { printf '%s\\n' verified >> ${JSON.stringify(markerPath)}; }`,
      "",
    ].join("\n"),
    { mode: 0o444 },
  );
}

function installFailingVerificationRlimitHelper(
  helperPath: string,
  markerPath: string,
  _tempDir: string,
): void {
  fs.writeFileSync(
    helperPath,
    [
      `harden_resource_limits() { printf '%s\\n' hardened > ${JSON.stringify(markerPath)}; }`,
      "verify_resource_limits() { :; }",
      "verify_resource_limits_exact() { printf '%s\\n' 'fixture exact verification failed' >&2; return 1; }",
      "",
    ].join("\n"),
    { mode: 0o444 },
  );
}

function makeStartFixture(options: { installRlimitHelper?: RlimitHelperInstaller } = {}): {
  scriptPath: string;
  rlimitMarker: string;
} {
  const installRlimitHelper = options.installRlimitHelper ?? installDefaultRlimitHelper;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-keepalive-"));
  const rlimitMarker = path.join(tempDir, "rlimits-hardened");
  const { scriptPath } = makeStartScriptFixture(tempDir, {
    installRlimitHelper: (rlimitLib) => installRlimitHelper(rlimitLib, rlimitMarker, tempDir),
  });
  tempDirs.push(tempDir);
  return { scriptPath, rlimitMarker };
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) fs.rmSync(tempDir, { force: true, recursive: true });
});

describe("Deep Agents Code sandbox entrypoint keep-alive (#5717)", () => {
  it("stays alive as a long-running process when invoked with no command", () => {
    // The terminal-runtime sandbox runs this entrypoint with no args as its
    // sole foreground process. It must NOT exit on its own — a self-exiting
    // entrypoint (e.g. a bare non-interactive /bin/bash) leaves the sandbox
    // with no persistent process, flapping it into OpenShell's Error phase and
    // breaking the Docker GPU-patch supervisor reconnect. Run with stdin closed
    // and a short timeout: a correct keep-alive is still running at the
    // deadline (killed by the timeout signal), not exited cleanly. Execute the
    // script directly (not via `bash`) so this also exercises the real ENTRYPOINT
    // contract — the image runs /usr/local/bin/nemoclaw-start directly, so a
    // broken shebang or execute bit would also be caught here.
    expect(fs.statSync(START_SCRIPT).mode & 0o111).not.toBe(0);
    const { scriptPath, rlimitMarker } = makeStartFixture();
    const result = spawnSync(scriptPath, [], {
      input: "",
      timeout: 3000,
      encoding: "utf-8",
    });

    // Killed by the timeout (still running) => signal set, status null.
    // A self-exiting entrypoint would return status 0 with no signal.
    expect(result.signal).toBe("SIGTERM");
    expect(result.status).toBeNull();
    expect(result.stdout).toContain("Setting up NemoClaw Deep Agents Code runtime...");
    expect(fs.readFileSync(rlimitMarker, "utf8")).toBe("hardened\nverified\n");
  });

  it("execs an explicitly supplied command instead of idling", () => {
    const { scriptPath, rlimitMarker } = makeStartFixture();
    const result = spawnSync(scriptPath, ["printf", "RAN_CMD"], {
      input: "",
      timeout: 3000,
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("RAN_CMD");
    expect(fs.readFileSync(rlimitMarker, "utf8")).toBe("hardened\nverified\n");
  });

  it("refuses to launch when the required rlimit helper is missing (#6545)", () => {
    const { scriptPath, rlimitMarker } = makeStartFixture({
      installRlimitHelper: () => undefined,
    });
    const result = spawnSync(scriptPath, ["printf", "SHOULD_NOT_RUN"], {
      input: "",
      timeout: 3000,
      encoding: "utf-8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("SHOULD_NOT_RUN");
    expect(result.stderr).toContain(
      "[SECURITY] Required sandbox-rlimits.sh is missing; refusing to start unhardened.",
    );
    expect(fs.existsSync(rlimitMarker)).toBe(false);
  });

  it("refuses to launch when effective rlimits fail verification (#6545)", () => {
    const { scriptPath, rlimitMarker } = makeStartFixture({
      installRlimitHelper: installFailingVerificationRlimitHelper,
    });
    const result = spawnSync(scriptPath, ["printf", "SHOULD_NOT_RUN"], {
      input: "",
      timeout: 3000,
      encoding: "utf-8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("SHOULD_NOT_RUN");
    expect(result.stderr).toContain("fixture exact verification failed");
    expect(result.stderr).toContain(
      "[SECURITY] Effective sandbox resource limits do not match policy; refusing to start unhardened.",
    );
    expect(fs.readFileSync(rlimitMarker, "utf8")).toBe("hardened\n");
  });

  it("hardens resource limits before managed proxy startup work", () => {
    let rlimitsLog = "";
    const { scriptPath } = makeStartFixture({
      installRlimitHelper: (helperPath, _markerPath, tempDir) => {
        rlimitsLog = path.join(tempDir, "rlimits.log");
        fs.writeFileSync(
          helperPath,
          [
            "harden_resource_limits() {",
            `  printf 'called=1\\n' > ${JSON.stringify(rlimitsLog)}`,
            `  printf 'proxy_host=%s\\n' "\${PROXY_HOST-__unset__}" >> ${JSON.stringify(rlimitsLog)}`,
            "}",
            "verify_resource_limits_exact() {",
            `  printf 'verified=1\\n' >> ${JSON.stringify(rlimitsLog)}`,
            "}",
          ].join("\n"),
          { mode: 0o444 },
        );
      },
    });
    const { PROXY_HOST: _ambientProxyHost, ...envWithoutProxyHost } = process.env;

    const result = spawnSync(scriptPath, ["printf", "RAN_CMD"], {
      input: "",
      timeout: 3000,
      encoding: "utf-8",
      env: envWithoutProxyHost,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("RAN_CMD");
    expect(result.stderr).not.toContain("resource limits were NOT hardened");
    expect(fs.readFileSync(rlimitsLog, "utf8")).toBe(
      "called=1\nproxy_host=__unset__\nverified=1\n",
    );
  });
});
