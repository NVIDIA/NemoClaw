// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const VALIDATOR = path.join(
  import.meta.dirname,
  "..",
  "agents",
  "hermes",
  "validate-env-secret-boundary.py",
);
const START_SCRIPT = path.join(import.meta.dirname, "..", "agents", "hermes", "start.sh");
const MAX_ENV_BYTES = 4 * 1024 * 1024;
const MAX_ENV_LINE_BYTES = 256 * 1024;
const MAX_ENV_LINES = 65_536;
const hasGnuTimeout =
  spawnSync("timeout", ["--version"], { encoding: "utf-8", timeout: 5000 }).status === 0;

function runValidator(envPath: string) {
  return spawnSync("python3", [VALIDATOR, "env-file", envPath], {
    encoding: "utf-8",
    timeout: 5000,
    env: { HOME: os.tmpdir(), PATH: process.env.PATH ?? "" },
  });
}

function extractShellFunction(source: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
  const resolved =
    match ??
    (() => {
      throw new Error(`Missing ${name} in start.sh`);
    })();
  return `${name}() {${resolved[1]}\n}`;
}

function runStartEnvValidation(hermesDir: string) {
  const source = fs.readFileSync(START_SCRIPT, "utf-8");
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-env-start-check-"));
  const script = path.join(runDir, "run.sh");
  try {
    fs.writeFileSync(
      script,
      [
        "#!/usr/bin/env bash",
        "set -u",
        "_HERMES_BOUNDARY_TIMEOUT=()",
        '_HERMES_PYTHON="$(command -v python3)"',
        `_HERMES_BOUNDARY_VALIDATOR=${JSON.stringify(VALIDATOR)}`,
        `HERMES_DIR=${JSON.stringify(hermesDir)}`,
        extractShellFunction(source, "validate_hermes_env_secret_boundary"),
        "validate_hermes_env_secret_boundary",
      ].join("\n"),
      { mode: 0o700 },
    );
    return spawnSync("bash", [script], {
      encoding: "utf-8",
      timeout: 5000,
      env: { HOME: os.tmpdir(), PATH: process.env.PATH ?? "" },
    });
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

describe("Hermes env secret-boundary resource limits", () => {
  it("accepts the normal 0640 mutable env-file mode", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-env-mode-"));
    const envPath = path.join(root, ".env");
    try {
      fs.writeFileSync(envPath, "SAFE=1\n", { mode: 0o640 });
      fs.chmodSync(envPath, 0o640);
      const result = runValidator(envPath);
      expect(result.status, result.stderr).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts canonical sandbox ownership only with the installed 0640 posture", () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        `import importlib.util, stat, sys
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location("validator", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.__file__ = module.INSTALLED_BOUNDARY_VALIDATOR
module._sandbox_identity = lambda: (1234, 5678)
def metadata(mode):
    return SimpleNamespace(st_mode=stat.S_IFREG | mode, st_uid=1234, st_gid=5678, st_nlink=1)
module._validate_env_file_metadata("/sandbox/.hermes/.env", metadata(0o640))
try:
    module._validate_env_file_metadata("/sandbox/.hermes/.env", metadata(0o600))
except module.UnsafeEnvInputError:
    print("0640=accepted 0600=rejected")`,
        VALIDATOR,
      ],
      { encoding: "utf-8", timeout: 5000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("0640=accepted 0600=rejected\n");
  });

  it("rejects an oversized sparse env before reading its logical payload", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-env-cap-"));
    const envPath = path.join(root, ".env");
    try {
      fs.writeFileSync(envPath, "SAFE=1\n", { mode: 0o600 });
      fs.truncateSync(envPath, MAX_ENV_BYTES + 1);
      const result = runValidator(envPath);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${MAX_ENV_BYTES}-byte limit`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a FIFO env path without blocking the privileged validator", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-env-fifo-"));
    const envPath = path.join(root, ".env");
    try {
      const created = spawnSync("mkfifo", [envPath], { encoding: "utf-8", timeout: 5000 });
      expect(created.status, created.stderr).toBe(0);
      const result = runValidator(envPath);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("not a regular file");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a single oversized line within the total byte cap", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-env-line-cap-"));
    const envPath = path.join(root, ".env");
    try {
      fs.writeFileSync(envPath, `SAFE=${"x".repeat(MAX_ENV_LINE_BYTES + 1)}\n`, { mode: 0o600 });
      const result = runValidator(envPath);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${MAX_ENV_LINE_BYTES}-byte limit`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects too many individually bounded lines", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-env-line-count-"));
    const envPath = path.join(root, ".env");
    try {
      fs.writeFileSync(envPath, "#\n".repeat(MAX_ENV_LINES + 1), { mode: 0o600 });
      const result = runValidator(envPath);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${MAX_ENV_LINES}-line limit`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("caps secret diagnostics while retaining the total omitted count", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-env-diagnostics-cap-"));
    const envPath = path.join(root, ".env");
    try {
      const lines = Array.from({ length: 100 }, (_, index) => `SECRET_${index}=raw-${index}`);
      fs.writeFileSync(envPath, `${lines.join("\n")}\n`, { mode: 0o600 });
      const result = runValidator(envPath);
      expect(result.status).toBe(1);
      expect(result.stderr.match(/^\[SECURITY\]   SECRET_/gm)).toHaveLength(64);
      expect(result.stderr).toContain("36 additional violation(s) omitted");
      expect(result.stderr).not.toContain("raw-99");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Hermes env secret-boundary namespace pinning", () => {
  it("anchors installed validation at sandbox when Landlock denies opening root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-env-landlock-root-"));
    const sandbox = path.join(root, "sandbox");
    const hermes = path.join(sandbox, ".hermes");
    const envPath = path.join(hermes, ".env");
    fs.mkdirSync(hermes, { recursive: true });
    fs.chmodSync(sandbox, 0o770);
    // Hermes tightens its own home to 0700 after startup in managed non-root
    // mode; the boundary must still validate that stricter same-owner posture.
    fs.chmodSync(hermes, 0o700);
    fs.writeFileSync(envPath, "SAFE=1\n", { mode: 0o640 });
    fs.chmodSync(envPath, 0o640);
    try {
      const result = spawnSync(
        "python3",
        [
          "-c",
          `import errno, importlib.util, os, sys
spec = importlib.util.spec_from_file_location("validator", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.__file__ = module.INSTALLED_BOUNDARY_VALIDATOR
module.INSTALLED_ENV_ROOT = sys.argv[2]
module.INSTALLED_ENV_PATH = sys.argv[3]
module._sandbox_identity = lambda: (os.geteuid(), os.getegid())
original_open = module.os.open
def landlock_open(path, *args, **kwargs):
    if path == os.sep:
        raise PermissionError(errno.EACCES, "Landlock denied root", path)
    return original_open(path, *args, **kwargs)
module.os.open = landlock_open
raise SystemExit(module.validate_env_file(sys.argv[3]))`,
          VALIDATOR,
          sandbox,
          envPath,
        ],
        { encoding: "utf-8", timeout: 5000 },
      );
      expect(result.status, result.stderr).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("makes startup fail closed for a missing env or broken ancestor", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-env-missing-"));
    const missingEnvHome = path.join(root, "missing-env");
    const brokenHome = path.join(root, "broken", ".hermes");
    fs.mkdirSync(missingEnvHome);
    fs.symlinkSync(path.join(root, "absent-target"), path.join(root, "broken"));
    try {
      const missing = runStartEnvValidation(missingEnvHome);
      const broken = runStartEnvValidation(brokenHome);
      expect(missing.status).not.toBe(0);
      expect(broken.status).not.toBe(0);
      expect(missing.stderr).toContain("expected env path disappeared");
      expect(broken.stderr).toContain("expected env path disappeared");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an ancestor symlink in installed-validator mode", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-env-ancestor-")));
    const target = path.join(root, "target");
    const linked = path.join(root, "sandbox");
    fs.mkdirSync(path.join(target, ".hermes"), { recursive: true });
    fs.writeFileSync(path.join(target, ".hermes", ".env"), "SECRET_TOKEN=never-print-this\n", {
      mode: 0o600,
    });
    fs.symlinkSync(target, linked);
    try {
      const result = spawnSync(
        "python3",
        [
          "-c",
          `import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("validator", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.__file__ = module.INSTALLED_BOUNDARY_VALIDATOR
module.INSTALLED_ENV_ROOT = os.path.dirname(os.path.dirname(sys.argv[2]))
module.INSTALLED_ENV_PATH = sys.argv[2]
raise SystemExit(module.validate_env_file(sys.argv[2]))`,
          VALIDATOR,
          path.join(linked, ".hermes", ".env"),
        ],
        { encoding: "utf-8", timeout: 5000 },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("symlink or non-directory ancestor");
      expect(result.stderr).not.toContain("never-print-this");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a canonical ancestor rename after the descriptor read", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-env-race-")));
    const sandbox = path.join(root, "sandbox");
    const hermes = path.join(sandbox, ".hermes");
    fs.mkdirSync(hermes, { recursive: true });
    fs.chmodSync(sandbox, 0o770);
    fs.chmodSync(hermes, 0o3770);
    fs.writeFileSync(path.join(hermes, ".env"), "SAFE=1\n", { mode: 0o640 });
    fs.chmodSync(path.join(hermes, ".env"), 0o640);
    try {
      const result = spawnSync(
        "python3",
        [
          "-c",
          `import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("validator", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.__file__ = module.INSTALLED_BOUNDARY_VALIDATOR
module.INSTALLED_ENV_ROOT = os.path.dirname(os.path.dirname(sys.argv[2]))
module.INSTALLED_ENV_PATH = sys.argv[2]
module._sandbox_identity = lambda: (os.geteuid(), os.getegid())
original = module._read_bounded_env
def racing_read(fd, identity):
    payload = original(fd, identity)
    os.rename(sys.argv[3], sys.argv[4])
    os.mkdir(sys.argv[3], 0o700)
    with open(os.path.join(sys.argv[3], ".env"), "w", encoding="utf-8") as handle:
        handle.write("SECRET_TOKEN=never-print-this\\n")
    os.chmod(os.path.join(sys.argv[3], ".env"), 0o600)
    return payload
module._read_bounded_env = racing_read
raise SystemExit(module.validate_env_file(sys.argv[2]))`,
          VALIDATOR,
          path.join(hermes, ".env"),
          hermes,
          path.join(sandbox, ".hermes-moved"),
        ],
        { encoding: "utf-8", timeout: 5000 },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("ancestor changed while it was read");
      expect(result.stderr).not.toContain("never-print-this");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!hasGnuTimeout)("Hermes PID 1 boundary-validator timeout", () => {
  it("waits for timeout cleanup and leaves no validator process behind", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-env-timeout-"));
    const bin = path.join(root, "bin");
    const hermes = path.join(root, ".hermes");
    const pidFile = path.join(root, "pids");
    fs.mkdirSync(bin);
    fs.mkdirSync(hermes);
    fs.writeFileSync(path.join(hermes, ".env"), "SAFE=1\n", { mode: 0o600 });
    fs.writeFileSync(
      path.join(bin, "python3"),
      `#!/bin/sh
sleep 30 &
child=$!
printf '%s %s\n' "$$" "$child" >${JSON.stringify(pidFile)}
wait "$child"
`,
      { mode: 0o700 },
    );
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const script = path.join(root, "run.sh");
    fs.writeFileSync(
      script,
      [
        "#!/usr/bin/env bash",
        "set -u",
        "_HERMES_BOUNDARY_TIMEOUT=(timeout --signal=TERM --kill-after=0.2s 2s)",
        '_HERMES_PYTHON="$(command -v python3)"',
        `_HERMES_BOUNDARY_VALIDATOR=${JSON.stringify(VALIDATOR)}`,
        `HERMES_DIR=${JSON.stringify(hermes)}`,
        extractShellFunction(source, "validate_hermes_env_secret_boundary"),
        "rc=0",
        "validate_hermes_env_secret_boundary || rc=$?",
        `read -r parent child <${JSON.stringify(pidFile)}`,
        "for _ in {1..100}; do",
        '  parent_alive=0; kill -0 "$parent" 2>/dev/null && parent_alive=1',
        '  child_alive=0; kill -0 "$child" 2>/dev/null && child_alive=1',
        '  [ "$parent_alive" -eq 0 ] && [ "$child_alive" -eq 0 ] && break',
        "  sleep 0.01",
        "done",
        'printf "rc=%s parent=%s child=%s\\n" "$rc" "$parent_alive" "$child_alive"',
      ].join("\n"),
      { mode: 0o700 },
    );
    try {
      const result = spawnSync("bash", [script], {
        encoding: "utf-8",
        timeout: 5000,
        env: { HOME: root, PATH: `${bin}:${process.env.PATH ?? ""}` },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("rc=124 parent=0 child=0\n");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
