// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dockerRunCommandBetween, runDockerShell } from "../../helpers/dockerfile-run-shell";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const HERMES_DOCKERFILE = path.join(ROOT, "agents", "hermes", "Dockerfile");
const HERMES_BUILD_MCP_DIGEST = path.join(ROOT, "agents", "hermes", "build-mcp-digest.py");
const HERMES_IMAGE_BUILD_PROBES = path.join(
  ROOT,
  "agents",
  "hermes",
  "image-build-probes.py",
);
const HERMES_RUNTIME_CONFIG_GUARD = path.join(ROOT, "agents", "hermes", "runtime-config-guard.py");

function writeYamlStubPython(root: string): string {
  const bootstrap = path.join(root, "python-yaml-bootstrap.py");
  const wrapper = path.join(root, "python-with-yaml-stub");
  fs.writeFileSync(
    bootstrap,
    String.raw`import json
import runpy
import sys
import types

yaml = types.ModuleType("yaml")
class YAMLError(Exception):
    pass
yaml.YAMLError = YAMLError
def safe_load(text):
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise YAMLError("fixture must contain valid JSON-compatible YAML") from exc
    if not isinstance(parsed, dict) or not isinstance(parsed.get("mcp_servers"), dict):
        raise YAMLError("fixture must contain an mcp_servers mapping")
    return parsed
yaml.safe_load = safe_load
sys.modules["yaml"] = yaml

script, *args = sys.argv[1:]
sys.argv = [script, *args]
runpy.run_path(script, run_name="__main__")
`,
  );
  fs.writeFileSync(
    wrapper,
    `#!/usr/bin/env bash\nset -euo pipefail\n[[ "\${1:-}" != "-I" ]] || shift\nexec python3 -I ${JSON.stringify(bootstrap)} "$@"\n`,
    { mode: 0o700 },
  );
  return wrapper;
}

describe("Hermes doctor and config hash boundary", () => {
  it("accepts only the reviewed Hermes version and exact one-shot completion wait", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-retirement-probe-"));
    const hermes = path.join(tmp, "hermes");
    const adapter = path.join(tmp, "adapter.json");
    const oneshot = path.join(tmp, "oneshot.py");
    const runner = path.join(tmp, "run-probe.py");
    fs.writeFileSync(
      runner,
      [
        "import importlib.util",
        "import pathlib",
        "import sys",
        `spec = importlib.util.spec_from_file_location("image_build_probes", ${JSON.stringify(HERMES_IMAGE_BUILD_PROBES)})`,
        "module = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(module)",
        "module.verify_compatibility_retirement(",
        "    hermes=pathlib.Path(sys.argv[1]),",
        "    adapter=pathlib.Path(sys.argv[2]),",
        "    oneshot=pathlib.Path(sys.argv[3]),",
        ")",
      ].join("\n"),
    );
    fs.writeFileSync(adapter, '{"result":"resumed_oneshot"}\n');
    fs.writeFileSync(
      oneshot,
      "process_registry.wait_for_pending_completions(oneshot_task_id)\n",
    );
    const runProbe = () =>
      spawnSync("python3", ["-I", runner, hermes, adapter, oneshot], {
        encoding: "utf-8",
        timeout: 5000,
      });

    try {
      fs.writeFileSync(hermes, "#!/bin/sh\nprintf 'Hermes v0.20.6\\n'\n", { mode: 0o755 });
      const accepted = runProbe();
      expect(accepted.status, accepted.stderr).toBe(0);

      fs.writeFileSync(hermes, "#!/bin/sh\nprintf 'Hermes v0.21.0\\n'\n", { mode: 0o755 });
      const futureVersion = runProbe();
      expect(futureVersion.status).toBe(1);
      expect(futureVersion.stderr).toContain("re-review the workaround set");

      fs.writeFileSync(hermes, "#!/bin/sh\nprintf 'Hermes v0.20.6\\n'\n", { mode: 0o755 });
      fs.writeFileSync(oneshot, "process_registry.wait_for_pending_completions()\n");
      const broadWait = runProbe();
      expect(broadWait.status).toBe(1);
      expect(broadWait.stderr).toContain("not scoped to the exact turn");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps upstream doctor changes out of generated config hash inputs", () => {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-doctor-lock-"));
    const sandboxRoot = path.join(tmp, "sandbox");
    const hermesDir = path.join(sandboxRoot, ".hermes");
    const configPath = path.join(hermesDir, "config.yaml");
    const envPath = path.join(hermesDir, ".env");
    const fakeHermes = path.join(tmp, "hermes");
    const orderLogPath = path.join(tmp, "doctor-generate-order.log");
    const etcDir = path.join(tmp, "etc", "nemoclaw");
    const hermesPython = writeYamlStubPython(tmp);
    const mode = (entry: string) => (fs.statSync(entry).mode & 0o777).toString(8);
    const generatedConfig = JSON.stringify({
      model: "trusted",
      custom_providers: [],
      mcp_servers: {
        fixture: { command: "/bin/true", args: [] },
      },
    });
    const fakeGenerateCommand = [
      `printf 'generate\\n' >>${JSON.stringify(orderLogPath)}`,
      `printf '%s\\n' ${JSON.stringify(generatedConfig)} >${JSON.stringify(configPath)}`,
      `printf 'API_SERVER_HOST=127.0.0.1\\nAPI_SERVER_PORT=18642\\n' >${JSON.stringify(envPath)}`,
      `chmod 600 ${JSON.stringify(configPath)} ${JSON.stringify(envPath)}`,
    ].join("; ");
    fs.mkdirSync(hermesDir, { recursive: true });
    fs.writeFileSync(configPath, "model: test\n", { mode: 0o600 });
    fs.writeFileSync(envPath, "TOKEN=test\n", { mode: 0o600 });
    fs.writeFileSync(
      fakeHermes,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `test "\${HERMES_HOME:-}" = ${JSON.stringify(hermesDir)}`,
        'test "${1:-} ${2:-}" = "doctor --fix"',
        `printf 'doctor\\n' >>${JSON.stringify(orderLogPath)}`,
        `printf 'doctor_migrated: true\\n' >>${JSON.stringify(configPath)}; printf 'DOCTOR_MIGRATED=1\\n' >>${JSON.stringify(envPath)}; chmod 666 ${JSON.stringify(configPath)} ${JSON.stringify(envPath)}`,
      ].join("\n"),
      { mode: 0o700 },
    );

    const doctorAndGenerateCommand = dockerRunCommandBetween(
      dockerfile,
      "# Run Hermes' upstream repair",
      "# Install the generated policy manifest outside the mutable Hermes home",
    )
      .replaceAll("/sandbox", sandboxRoot)
      .replaceAll("/usr/local/bin/hermes", fakeHermes)
      .replaceAll(
        "node --experimental-strip-types /opt/nemoclaw-hermes-config/generate-config.ts",
        fakeGenerateCommand,
      );
    const lockCommand = dockerRunCommandBetween(
      dockerfile,
      "# Flatten stale published base images",
      "# Pin config hash at build time",
    ).replaceAll("/root/.cache/pip", path.join(tmp, "root-cache", "pip"));
    const hashCommand = dockerRunCommandBetween(
      dockerfile,
      "# Pin config hash at build time",
      "# Publish the mutable in-tree compatibility hash",
    )
      .replaceAll("/etc/nemoclaw", etcDir)
      .replaceAll("/opt/hermes/.venv/bin/python", JSON.stringify(hermesPython))
      .replaceAll(
        "/usr/local/lib/nemoclaw/build-hermes-mcp-digest.py",
        JSON.stringify(HERMES_BUILD_MCP_DIGEST),
      )
      .replaceAll(
        "/usr/local/lib/nemoclaw/hermes-runtime-config-guard.py",
        JSON.stringify(HERMES_RUNTIME_CONFIG_GUARD),
      );
    const compatHashCommand = dockerRunCommandBetween(
      dockerfile,
      "# Publish the mutable in-tree compatibility hash",
      "# Keep the shared NemoClaw state root",
    ).replaceAll("/etc/nemoclaw", etcDir);

    try {
      const doctorAndGenerate = spawnSync("bash", ["-c", doctorAndGenerateCommand], {
        encoding: "utf-8",
        cwd: tmp,
        timeout: 5000,
      });
      expect(doctorAndGenerate.status).toBe(0);
      expect(fs.readFileSync(orderLogPath, "utf-8")).toBe("doctor\ngenerate\n");
      expect([mode(configPath), mode(envPath)]).toEqual(["600", "600"]);
      expect(fs.readFileSync(configPath, "utf-8")).not.toContain("doctor_migrated");
      expect(fs.readFileSync(envPath, "utf-8")).not.toContain("DOCTOR_MIGRATED");

      const lock = runDockerShell(lockCommand, sandboxRoot);
      expect(lock.result.status, lock.result.stderr).toBe(0);
      expect(lock.result.stderr).toBe("");
      expect([mode(configPath), mode(envPath)]).toEqual(["640", "640"]);

      const hash = runDockerShell(hashCommand, sandboxRoot);
      expect(hash.result.status, hash.result.stderr).toBe(0);
      expect(hash.result.stderr).toBe("");
      expect(mode(path.join(etcDir, "hermes.config-hash"))).toBe("444");
      const verifyHash = spawnSync("sha256sum", ["-c", path.join(etcDir, "hermes.config-hash")], {
        encoding: "utf-8",
        timeout: 5000,
      });
      expect(verifyHash.status).toBe(0);

      const compatHash = runDockerShell(compatHashCommand, sandboxRoot);
      expect(compatHash.result.status).toBe(0);
      expect(compatHash.result.stderr).toBe("");
      expect(mode(path.join(hermesDir, ".config-hash"))).toBe("640");
      const verifyCompatHash = spawnSync(
        "sha256sum",
        ["-c", path.join(hermesDir, ".config-hash")],
        { encoding: "utf-8", timeout: 5000 },
      );
      expect(verifyCompatHash.status).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
