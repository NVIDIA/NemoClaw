// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Hermes 0.21.3 owns resumed and continued one-shot session persistence.
// These tests keep that retired compatibility surface on the native CLI path.

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ADAPTER, WRAPPER, canRun, runWrapper } from "../../helpers/hermes-wrapper-harness.ts";

describe.skipIf(!canRun)("agents/hermes/hermes-wrapper.py native one-shot routing", () => {
  it("passes a resumed one-shot through to Hermes 0.21.3 unchanged (#5254)", () => {
    const argv = [
      "--resume",
      "20260612_050401_aa9d27",
      "--oneshot",
      "What secret number did I give you?",
    ];

    const run = runWrapper(argv, {});

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual(argv);
  });

  it("passes a continued one-shot usage report through unchanged (#5254)", () => {
    const argv = [
      "--continue",
      "daily check",
      "--oneshot=Summarize the latest turn",
      "--usage-file",
      "/tmp/usage.json",
    ];

    const run = runWrapper(argv, {});

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual(argv);
  });

  it("retains provider/model composition without restoring resumed routing (#7361)", () => {
    const run = runWrapper(
      [
        "--continue",
        "daily check",
        "--oneshot",
        "Summarize the latest turn",
        "--provider",
        "nvidia-prod",
        "--model",
        "nvidia/model",
      ],
      {},
    );

    expect(run.status).toBe(0);
    expect(run.realArgv).toEqual([
      "--continue",
      "daily check",
      "--oneshot",
      "Summarize the latest turn",
      "--model",
      "nvidia-prod/nvidia/model",
    ]);
  });

  it("rejects a CLI adapter that restores the retired translation (#5254)", () => {
    const adapter = JSON.parse(fs.readFileSync(ADAPTER, "utf8"));
    adapter.translations.resumed_oneshot = {
      issue: 5254,
      forms: ["retired"],
      reason: "retired",
      removal_condition: "retired",
      source_fix_constraint: "retired",
    };

    const run = runWrapper(["--continue", "--oneshot", "hello"], {}, { adapter });

    expect(run.status).toBe(2);
    expect(run.realInvoked).toBe(false);
    expect(run.stderr).toContain("invalid translation metadata");
  });
});

describe("Hermes direct native inference credential guard", () => {
  it("uses the current hashed route after switching and refuses unsafe handles before exec", () => {
    const runtimeGuard = path.resolve("agents/hermes/runtime-config-guard.py");
    const result = spawnSync(
      "python3",
      [
        "-c",
        String.raw`
import importlib.util, json, os, pathlib, subprocess, sys, tempfile
spec = importlib.util.spec_from_file_location("runtime_guard", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)
with tempfile.TemporaryDirectory() as root:
    home = pathlib.Path(root)
    config = home / "config.yaml"
    env = home / ".env"
    hashes = home / "hashes"
    marker = home / "invoked"
    real = home / "hermes.real"
    real.write_text("#!/bin/sh\ntouch " + str(marker) + "\n")
    real.chmod(0o755)
    env.write_text("")
    script = "\n".join([
        "import importlib.util, sys",
        "spec = importlib.util.spec_from_file_location('wrapper', sys.argv[1])",
        "wrapper = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(wrapper)",
        "wrapper._TRUSTED_PYTHON3 = (sys.executable,)",
        "wrapper._resolve_real_hermes = lambda: sys.argv[2]",
        "wrapper._resolve_cli_adapter = lambda: sys.argv[3]",
        "wrapper._resolve_native_inference_guard = lambda: sys.argv[4]",
        "wrapper._MANAGED_HERMES_HOME = sys.argv[5]",
        "wrapper._NATIVE_INFERENCE_HASH_FILE = sys.argv[6]",
        # Other owners exercise the gateway env boundary; isolate native route validation here.
        "wrapper._run_gateway_env_file_guard = lambda _path: 0",
        "wrapper._run_gateway_guard = lambda _path: 0",
        "wrapper.os.geteuid = lambda: 1000",
        "raise SystemExit(wrapper.main(sys.argv[7:]))",
    ])
    command = [sys.executable, "-c", script, sys.argv[2], str(real), sys.argv[3], sys.argv[1], str(home), str(hashes)]
    for key in ["NVIDIA_INFERENCE_API_KEY", "OPENAI_API_KEY"]:
        config.write_text(json.dumps({"model": {"api_key": "$" + "{" + key + "}"}}))
        hash_text, _, _ = guard._hash_text(str(config), str(env))
        hashes.write_text(hash_text)
        for value, expected in [("openshell:resolve:env:v42_" + key, 0), ("openshell:resolve:env:s" + "a" * 64 + "_" + key, 0), ("", 1), ("raw-secret-do-not-print", 1), ("openshell:resolve:env:" + key, 1), ("openshell:resolve:env:v42_OTHER_KEY", 1)]:
            marker.unlink(missing_ok=True)
            run = subprocess.run(command + ["chat", "--query", "hello"], env={"PATH": os.environ["PATH"], key: value}, capture_output=True, text=True)
            assert run.returncode == expected, run.stderr
            assert marker.exists() == (expected == 0)
            assert "raw-secret-do-not-print" not in run.stderr
        missing = subprocess.run(command + ["chat", "--query", "hello"], env={"PATH": os.environ["PATH"]}, capture_output=True, text=True)
        assert missing.returncode == 1
        help_run = subprocess.run(command + ["chat", "--help"], env={"PATH": os.environ["PATH"]}, capture_output=True, text=True)
        assert help_run.returncode == 0, help_run.stderr
    # Restoring a legitimate legacy home changes its hash before the supervised
    # replacement's preparation transaction can refresh it. Restart only signals
    # that supervisor; direct launch/chat must still refuse the stale snapshot.
    config.write_text(json.dumps({"model": {"api_key": "sk-OPENSHELL-PROXY-REWRITE"}}))
    for argv, expected in [(["gateway", "restart"], 0), (["gateway", "run"], 1), (["gateway", "restart", "--all"], 1), (["chat", "--query", "hello"], 1)]:
        marker.unlink(missing_ok=True)
        run = subprocess.run(command + argv, capture_output=True, text=True)
        assert run.returncode == expected, run.stderr
        assert marker.exists() == (expected == 0)
    # The actual launch is admitted only after reconciliation seals the snapshot.
    hash_text, _, _ = guard._hash_text(str(config), str(env))
    hashes.write_text(hash_text)
    run = subprocess.run(command + ["gateway", "run"], capture_output=True, text=True)
    assert run.returncode == 0, run.stderr
    config.write_text("model: {api_key: raw-secret-do-not-print}")
    hash_text, _, _ = guard._hash_text(str(config), str(env))
    hashes.write_text(hash_text)
    marker.unlink(missing_ok=True)
    run = subprocess.run(command + ["chat", "--query", "hello"], capture_output=True, text=True)
    assert run.returncode == 1
    assert not marker.exists()
    assert "raw-secret-do-not-print" not in run.stderr
`,
        runtimeGuard,
        WRAPPER,
        ADAPTER,
      ],
      { encoding: "utf8", timeout: 15000 },
    );
    expect(result.status, result.stderr).toBe(0);
  });
});
