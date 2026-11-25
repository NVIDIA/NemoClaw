// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Exercise the shipped restore checks against state created by native OpenClaw. */
export function proveRealPostUpgradeChecks(
  stateDir: string,
  dist: string,
  nodeExecutable: string,
): void {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, "../../scripts/nemoclaw-start.sh"),
    "utf8",
  );
  for (const tag of ["NODEREPAIR", "NODELEASE"]) {
    const programs = [...source.matchAll(new RegExp(`<<'${tag}'[^\\n]*\\n(.*?)\\n${tag}`, "gs"))];
    if (programs.length !== 1) throw new Error(`Expected one shipped ${tag} check`);
    const program = programs[0]![1]!.replaceAll(
      "/sandbox/.openclaw/state/openclaw.sqlite",
      path.join(stateDir, "state", "openclaw.sqlite"),
    );
    const result = spawnSync(nodeExecutable, ["-", path.join(path.dirname(dist), "openclaw.mjs")], {
      input: program,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        HOME: stateDir,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
        OPENCLAW_NO_RESPAWN: "1",
      },
    });
    if (result.status !== 0) {
      throw new Error(`Native post-upgrade ${tag} failed: ${result.error ?? result.stderr}`);
    }
  }
}

/** Retired state must be refused before the wrapper changes a native database. */
export function proveRealPostUpgradeRetiredStateAdmission(
  stateDir: string,
  dist: string,
  nodeExecutable: string,
): void {
  const scratch = fs.mkdtempSync(path.join(path.dirname(stateDir), "retired-state-admission-"));
  try {
    fs.cpSync(stateDir, scratch, { recursive: true });
    const databaseDir = path.join(scratch, "state");
    const databaseSnapshot = () =>
      fs
        .readdirSync(databaseDir)
        .sort()
        .map((name) => [name, fs.readFileSync(path.join(databaseDir, name))]);
    const before = databaseSnapshot();
    const sidecar = path.join(scratch, "acp", "event-ledger.json");
    fs.mkdirSync(path.dirname(sidecar), { recursive: true });
    const legacy = JSON.stringify({ version: 1, sessions: {} });
    fs.writeFileSync(sidecar, legacy, { flag: "wx", mode: 0o600 });
    assert.throws(
      () => proveRealPostUpgradeChecks(scratch, dist, nodeExecutable),
      /Native post-upgrade NODEREPAIR failed:.*Upgrade through OpenClaw 2026\.9\.7/s,
    );
    assert.deepEqual(databaseSnapshot(), before, "retired admission changed native database files");
    assert.equal(fs.readFileSync(sidecar, "utf8"), legacy, "retired admission changed the source");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** Check the target Doctor's repair and refusal contracts for restored custom config. */
export function proveRealPostUpgradeConfigRepair(
  parentDirectory: string,
  dist: string,
  nodeExecutable: string,
): void {
  const scratch = fs.mkdtempSync(path.join(parentDirectory, "post-upgrade-config-"));
  try {
    for (const legacyField of ["internal", "direct"]) {
      const home = path.join(scratch, legacyField);
      const stateDir = path.join(home, ".openclaw");
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const configPath = path.join(stateDir, "openclaw.json");
      const config = {
        gateway: {
          mode: "local",
          auth: { mode: "token", token: "post-upgrade-test-fixture" },
        },
        agents: { defaults: { silentReply: { group: "allow", [legacyField]: "allow" } } },
        surfaces: { telegram: { silentReply: { group: "disallow", [legacyField]: "disallow" } } },
      };
      const before = `${JSON.stringify(config, null, 2)}\n`;
      fs.writeFileSync(configPath, before, { mode: 0o600 });
      // The entrypoint makes two bounded Doctor passes. A repair must survive
      // the second pass without dropping the user's supported group policy.
      const passes = legacyField === "internal" ? 2 : 1;
      for (let pass = 0; pass < passes; pass++) {
        const result = spawnSync(
          nodeExecutable,
          [
            path.join(path.dirname(dist), "openclaw.mjs"),
            "doctor",
            "--fix",
            "--yes",
            "--non-interactive",
          ],
          {
            encoding: "utf8",
            timeout: 120_000,
            ...(process.platform !== "win32" ? { detached: true } : {}),
            killSignal: "SIGKILL",
            maxBuffer: 16 * 1024 * 1024,
            env: {
              PATH: process.env.PATH,
              TMPDIR: scratch,
              HOME: home,
              OPENCLAW_HOME: home,
              OPENCLAW_STATE_DIR: stateDir,
              OPENCLAW_CONFIG_PATH: configPath,
              OPENCLAW_NO_RESPAWN: "1",
              NPM_CONFIG_OFFLINE: "true",
              npm_config_offline: "true",
            },
          },
        );
        if (
          (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" &&
          process.platform !== "win32" &&
          result.pid > 0
        ) {
          try {
            process.kill(-result.pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
        assert.equal(result.error, undefined, `Doctor ${legacyField} failed to complete`);
        const after = fs.readFileSync(configPath, "utf8");
        if (legacyField === "internal") {
          assert.equal(result.status, 0, `Doctor config repair failed: ${result.stderr}`);
          const saved = JSON.parse(after);
          assert.deepEqual(saved.agents.defaults.silentReply, { group: "allow" });
          assert.deepEqual(saved.surfaces.telegram.silentReply, { group: "disallow" });
          assert.equal(saved.gateway.auth.token, config.gateway.auth.token);
        } else {
          assert.notEqual(result.status, 0, "Doctor accepted retired direct-reply config");
          assert.equal(
            after,
            before,
            "Doctor changed configuration requiring an intermediate upgrade",
          );
          assert.match(`${result.stdout}\n${result.stderr}`, /OpenClaw 2026\.9\.5/);
        }
      }
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
