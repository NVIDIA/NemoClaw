// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RUNTIME_CONFIG_GUARD = path.join(
  import.meta.dirname,
  "..",
  "agents",
  "hermes",
  "runtime-config-guard.py",
);

interface ReconciliationFixture {
  root: string;
  sandboxDir: string;
  hermesDir: string;
  configPath: string;
  envPath: string;
  hashPath: string;
  compatHashPath: string;
  statePath: string;
  trustedConfig: string;
  trustedEnv: string;
}

function hashInputs(fixture: ReconciliationFixture): string {
  const result = spawnSync("sha256sum", [fixture.configPath, fixture.envPath], {
    encoding: "utf-8",
    timeout: 5000,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

function createFixture(hermesMode = 0o3770): ReconciliationFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-nonroot-hash-"));
  const sandboxDir = path.join(root, "sandbox");
  const hermesDir = path.join(sandboxDir, ".hermes");
  const fixture: ReconciliationFixture = {
    root,
    sandboxDir,
    hermesDir,
    configPath: path.join(hermesDir, "config.yaml"),
    envPath: path.join(hermesDir, ".env"),
    hashPath: path.join(root, "hermes.config-hash"),
    compatHashPath: path.join(hermesDir, ".config-hash"),
    statePath: path.join(root, "hermes-restart-seal.json"),
    trustedConfig: "model:\n  default: trusted-model\n",
    trustedEnv: "API_SERVER_PORT=18642\nSAFE_SETTING=trusted\n",
  };
  fs.mkdirSync(hermesDir, { recursive: true });
  fs.chmodSync(sandboxDir, 0o770);
  fs.chmodSync(hermesDir, hermesMode);
  fs.writeFileSync(fixture.configPath, fixture.trustedConfig, { mode: 0o640 });
  fs.writeFileSync(fixture.envPath, fixture.trustedEnv, { mode: 0o600 });
  const trustedHash = hashInputs(fixture);
  fs.writeFileSync(fixture.hashPath, trustedHash, { mode: 0o600 });
  fs.writeFileSync(fixture.compatHashPath, trustedHash, { mode: 0o600 });
  return fixture;
}

function writeConfigArgs(fixture: ReconciliationFixture, expectedDigest: string): string[] {
  return [
    "write-config",
    "--hermes-dir",
    fixture.hermesDir,
    "--hash-file",
    fixture.hashPath,
    "--state-file",
    fixture.statePath,
    "--expected-config-sha256",
    expectedDigest,
  ];
}

function runSourceWrite(fixture: ReconciliationFixture, expectedDigest: string, content: string) {
  return spawnSync("python3", [RUNTIME_CONFIG_GUARD, ...writeConfigArgs(fixture, expectedDigest)], {
    encoding: "utf-8",
    input: content,
    timeout: 5000,
  });
}

function runManagedNonrootWrite(
  fixture: ReconciliationFixture,
  expectedDigest: string,
  content: string,
) {
  const wrapper = String.raw`
import importlib.util
import os
import sys

source = sys.argv[1]
spec = importlib.util.spec_from_file_location("nemoclaw_runtime_config_guard_fixture", source)
if spec is None or spec.loader is None:
    raise SystemExit("could not load runtime guard fixture")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module._managed_nonroot_reconciliation_is_allowed = lambda: True
module._sandbox_identity = lambda: (os.geteuid(), os.getegid())
sys.argv = [source, *sys.argv[2:]]
raise SystemExit(module.main())
`;
  return spawnSync(
    "python3",
    ["-c", wrapper, RUNTIME_CONFIG_GUARD, ...writeConfigArgs(fixture, expectedDigest)],
    { encoding: "utf-8", input: content, timeout: 5000 },
  );
}

function refreshCompatOnly(fixture: ReconciliationFixture): void {
  fs.writeFileSync(fixture.compatHashPath, hashInputs(fixture));
}

function strictHashIsValid(fixture: ReconciliationFixture): boolean {
  return (
    spawnSync("sha256sum", ["-c", fixture.hashPath, "--status"], {
      encoding: "utf-8",
      timeout: 5000,
    }).status === 0
  );
}

function expectedConfigDigest(fixture: ReconciliationFixture): string {
  return createHash("sha256").update(fixture.trustedConfig).digest("hex");
}

function assertCleanRefusal(fixture: ReconciliationFixture, strictBefore: string): void {
  expect(fs.readFileSync(fixture.hashPath, "utf-8")).toBe(strictBefore);
  expect(fs.existsSync(fixture.statePath)).toBe(false);
  expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(false);
}

describe.skipIf(process.platform === "win32")(
  "Hermes managed non-root strict hash reconciliation",
  () => {
    it("admits only the installed, markerless, uniquely supervised non-root topology", () => {
      const probe = String.raw`
import importlib.util
import json
import os
import sys
import types

source = sys.argv[1]
spec = importlib.util.spec_from_file_location("nemoclaw_runtime_config_guard_gate", source)
if spec is None or spec.loader is None:
    raise SystemExit("could not load runtime guard fixture")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module.pwd.getpwnam = lambda _name: types.SimpleNamespace(pw_uid=1234)
module.INSTALLED_RUNTIME_CONFIG_GUARD = os.path.abspath(module.__file__)
module._startup_ready_marker_absent = lambda: True
module._openshell_supervised_nonroot_start_is_live = lambda root_uid, sandbox_uid: (root_uid, sandbox_uid) == (0, 1234)
allowed = module._managed_nonroot_reconciliation_is_allowed()
module._startup_ready_marker_absent = lambda: False
marker_present = module._managed_nonroot_reconciliation_is_allowed()
module._startup_ready_marker_absent = lambda: True
module._openshell_supervised_nonroot_start_is_live = lambda _root_uid, _sandbox_uid: False
not_supervised = module._managed_nonroot_reconciliation_is_allowed()
module.INSTALLED_RUNTIME_CONFIG_GUARD = "/different/installed/path"
source_helper = module._managed_nonroot_reconciliation_is_allowed()
print(json.dumps([allowed, marker_present, not_supervised, source_helper]))
`;
      const result = spawnSync("python3", ["-c", probe, RUNTIME_CONFIG_GUARD], {
        encoding: "utf-8",
        timeout: 5000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([true, false, false, false]);
    });

    it("admits only sandbox-owned writable private-live or canonical-mutable metadata (#2426)", () => {
      const probe = String.raw`
import importlib.util
import json
import sys

source = sys.argv[1]
spec = importlib.util.spec_from_file_location("nemoclaw_runtime_config_guard_posture", source)
if spec is None or spec.loader is None:
    raise SystemExit("could not load runtime guard fixture")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module._sandbox_identity = lambda: (1234, 1234)

def files(mode=0o640, uid=1234, gid=1234):
    return {
        name: {"original": {"mode": mode, "uid": uid, "gid": gid}}
        for name in ("config.yaml", ".env", ".config-hash")
    }

allowed = module._mutable_nonroot_reconciliation_posture_is_allowed
private_live = allowed({"mode": 0o700, "uid": 1234, "gid": 1234}, files())
canonical_mutable = allowed({"mode": 0o3770, "uid": 1234, "gid": 1234}, files())
foreign_private = allowed({"mode": 0o700, "uid": 0, "gid": 0}, files(uid=0, gid=0))
unexpected_mode = allowed({"mode": 0o770, "uid": 1234, "gid": 1234}, files())
locked = allowed({"mode": 0o755, "uid": 0, "gid": 0}, files(0o444, 0, 0))
read_only_input = files()
read_only_input[".env"]["original"]["mode"] = 0o440
partly_read_only = allowed({"mode": 0o700, "uid": 1234, "gid": 1234}, read_only_input)
group_writable = allowed({"mode": 0o700, "uid": 1234, "gid": 1234}, files(0o660))
world_writable = allowed({"mode": 0o700, "uid": 1234, "gid": 1234}, files(0o666))
print(json.dumps([private_live, canonical_mutable, foreign_private, unexpected_mode, locked, partly_read_only, group_writable, world_writable]))
`;
      const result = spawnSync("python3", ["-c", probe, RUNTIME_CONFIG_GUARD], {
        encoding: "utf-8",
        timeout: 5000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([
        true,
        true,
        false,
        false,
        false,
        false,
        false,
        false,
      ]);
    });

    it.each([
      ["private live", 0o700],
      ["canonical mutable", 0o3770],
    ])("reconciles only the generated startup API key from the %s posture and completes the config transaction (#2426)", (_label, hermesMode) => {
      const fixture = createFixture(hermesMode);
      const generatedKey = "a".repeat(64);
      fs.appendFileSync(fixture.envPath, `API_SERVER_KEY=${generatedKey}\n`);
      refreshCompatOnly(fixture);
      const strictBefore = fs.readFileSync(fixture.hashPath, "utf-8");

      try {
        expect(strictHashIsValid(fixture)).toBe(false);
        const updatedConfig = "model:\n  default: trusted-model-v2\n";
        const result = runManagedNonrootWrite(
          fixture,
          expectedConfigDigest(fixture),
          updatedConfig,
        );
        expect(result.status, result.stderr).toBe(0);
        expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(updatedConfig);
        expect(fs.readFileSync(fixture.envPath, "utf-8")).toBe(
          `${fixture.trustedEnv}API_SERVER_KEY=${generatedKey}\n`,
        );
        expect(fs.readFileSync(fixture.hashPath, "utf-8")).not.toBe(strictBefore);
        expect(fs.readFileSync(fixture.hashPath, "utf-8")).toBe(
          fs.readFileSync(fixture.compatHashPath, "utf-8"),
        );
        expect(strictHashIsValid(fixture)).toBe(true);
        expect(fs.existsSync(fixture.statePath)).toBe(false);
        expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(false);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it("refuses strict reconciliation from the shields-up root-locked posture (#2426)", () => {
      const fixture = createFixture();
      fs.appendFileSync(fixture.envPath, `API_SERVER_KEY=${"8".repeat(64)}\n`);
      refreshCompatOnly(fixture);
      fs.chmodSync(fixture.hermesDir, 0o755);
      fs.chmodSync(fixture.configPath, 0o444);
      fs.chmodSync(fixture.envPath, 0o444);
      fs.chmodSync(fixture.compatHashPath, 0o444);
      const strictBefore = fs.readFileSync(fixture.hashPath, "utf-8");

      try {
        const result = runManagedNonrootWrite(
          fixture,
          expectedConfigDigest(fixture),
          "model:\n  default: must-not-apply\n",
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("outside mutable Hermes posture");
        assertCleanRefusal(fixture, strictBefore);
      } finally {
        fs.chmodSync(fixture.hermesDir, 0o700);
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it("preserves the write-config shields-up refusal when the strict hash is current (#2426)", () => {
      const fixture = createFixture();
      fs.chmodSync(fixture.hermesDir, 0o755);
      fs.chmodSync(fixture.configPath, 0o444);
      fs.chmodSync(fixture.envPath, 0o444);
      fs.chmodSync(fixture.compatHashPath, 0o444);
      const strictBefore = fs.readFileSync(fixture.hashPath, "utf-8");

      try {
        const result = runManagedNonrootWrite(
          fixture,
          expectedConfigDigest(fixture),
          "model:\n  default: must-not-apply\n",
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("config writes are unavailable while shields are up");
        assertCleanRefusal(fixture, strictBefore);
      } finally {
        fs.chmodSync(fixture.hermesDir, 0o700);
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it("refuses an unproven source-helper topology", () => {
      const fixture = createFixture();
      fs.appendFileSync(fixture.envPath, `API_SERVER_KEY=${"b".repeat(64)}\n`);
      refreshCompatOnly(fixture);
      const strictBefore = fs.readFileSync(fixture.hashPath, "utf-8");
      try {
        const result = runSourceWrite(
          fixture,
          expectedConfigDigest(fixture),
          "model:\n  default: must-not-apply\n",
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("outside managed non-root startup");
        assertCleanRefusal(fixture, strictBefore);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it.each([
      ["weak", "API_SERVER_KEY=weak\n"],
      ["export-prefixed", `export API_SERVER_KEY=${"c".repeat(64)}\n`],
      ["single-quoted", `API_SERVER_KEY='${"d".repeat(64)}'\n`],
      ["missing-final-newline", `API_SERVER_KEY=${"e".repeat(64)}`],
      ["CRLF", `API_SERVER_KEY=${"f".repeat(64)}\r\n`],
      ["duplicate", `API_SERVER_KEY=${"1".repeat(64)}\nAPI_SERVER_KEY=${"2".repeat(64)}\n`],
    ])("refuses a %s API key delta", (_label, apiKeyText) => {
      const fixture = createFixture();
      fs.appendFileSync(fixture.envPath, apiKeyText);
      refreshCompatOnly(fixture);
      const strictBefore = fs.readFileSync(fixture.hashPath, "utf-8");
      try {
        const result = runManagedNonrootWrite(
          fixture,
          expectedConfigDigest(fixture),
          "model:\n  default: must-not-apply\n",
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/API_SERVER_KEY change/u);
        assertCleanRefusal(fixture, strictBefore);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it("refuses a stale compatibility hash", () => {
      const fixture = createFixture();
      fs.appendFileSync(fixture.envPath, `API_SERVER_KEY=${"3".repeat(64)}\n`);
      const strictBefore = fs.readFileSync(fixture.hashPath, "utf-8");
      try {
        const result = runManagedNonrootWrite(
          fixture,
          expectedConfigDigest(fixture),
          "model:\n  default: must-not-apply\n",
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("compat hash does not match frozen Hermes inputs");
        assertCleanRefusal(fixture, strictBefore);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it.each([
      ["missing final LF", (text: string) => text.replace(/\n$/u, "")],
      ["CRLF records", (text: string) => text.replace(/\n/gu, "\r\n")],
    ])("refuses a strict hash with %s", (_label, mutate) => {
      const fixture = createFixture();
      fs.appendFileSync(fixture.envPath, `API_SERVER_KEY=${"4".repeat(64)}\n`);
      refreshCompatOnly(fixture);
      const malformed = mutate(fs.readFileSync(fixture.hashPath, "utf-8"));
      fs.writeFileSync(fixture.hashPath, malformed);
      try {
        const result = runManagedNonrootWrite(
          fixture,
          expectedConfigDigest(fixture),
          "model:\n  default: must-not-apply\n",
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("malformed Hermes config hash");
        assertCleanRefusal(fixture, malformed);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it("refuses any env drift beyond the generated API key", () => {
      const fixture = createFixture();
      fs.appendFileSync(
        fixture.envPath,
        `API_SERVER_KEY=${"5".repeat(64)}\nUNEXPECTED_SETTING=attacker-controlled\n`,
      );
      refreshCompatOnly(fixture);
      const strictBefore = fs.readFileSync(fixture.hashPath, "utf-8");
      try {
        const result = runManagedNonrootWrite(
          fixture,
          expectedConfigDigest(fixture),
          "model:\n  default: must-not-apply\n",
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("non-API-key env drift");
        expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(fixture.trustedConfig);
        assertCleanRefusal(fixture, strictBefore);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it("refuses config drift even when compat and the host read match it", () => {
      const fixture = createFixture();
      const driftedConfig = "model:\n  default: attacker-model\n";
      fs.writeFileSync(fixture.configPath, driftedConfig);
      fs.appendFileSync(fixture.envPath, `API_SERVER_KEY=${"6".repeat(64)}\n`);
      refreshCompatOnly(fixture);
      const strictBefore = fs.readFileSync(fixture.hashPath, "utf-8");
      try {
        const result = runManagedNonrootWrite(
          fixture,
          createHash("sha256").update(driftedConfig).digest("hex"),
          "model:\n  default: must-not-apply\n",
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("refusing config drift");
        expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(driftedConfig);
        assertCleanRefusal(fixture, strictBefore);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it("keeps the host-read compare-and-swap requirement", () => {
      const fixture = createFixture();
      fs.appendFileSync(fixture.envPath, `API_SERVER_KEY=${"7".repeat(64)}\n`);
      refreshCompatOnly(fixture);
      const strictBefore = fs.readFileSync(fixture.hashPath, "utf-8");
      try {
        const staleHostDigest = createHash("sha256").update("stale host read\n").digest("hex");
        const result = runManagedNonrootWrite(
          fixture,
          staleHostDigest,
          "model:\n  default: must-not-apply\n",
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("config changed after the host read");
        assertCleanRefusal(fixture, strictBefore);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  },
);
