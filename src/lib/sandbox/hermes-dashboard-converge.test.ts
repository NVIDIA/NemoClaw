// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Direct coverage for convergeHermesDashboardModel (#6893). This exercises the
// helper's own probe parsing, argv construction, and error classification —
// the security-boundary logic that the inference-set tests only reach through a
// mocked dependency. Both the presence probe and the model writes run through
// the real code path with only the docker-exec adapter and the argv builder
// replaced, so the assertions pin the exact argv (no shell interpolation of
// provider/model) and prove failures are classified without leaking anything
// beyond the underlying error message.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dockerExecPath = require.resolve("../adapters/docker/exec");
const privilegedExecPath = require.resolve("./privileged-exec");
const configModulePath = require.resolve("./config");

type SpawnResult = { status: number | null; signal: string | null; error?: Error };

const dockerExec = require(dockerExecPath) as {
  dockerSpawnSync: (...args: unknown[]) => SpawnResult;
  dockerExecFileSync: (...args: unknown[]) => string;
};
const privilegedExec = require(privilegedExecPath) as {
  privilegedSandboxExecArgv: (...args: unknown[]) => string[];
};

const realSpawn = dockerExec.dockerSpawnSync;
const realExecFile = dockerExec.dockerExecFileSync;
const realArgv = privilegedExec.privilegedSandboxExecArgv;

type ConvergeFn = (
  sandboxName: string,
  configDir: string,
  provider: string,
  model: string,
) => { status: "converged" | "absent" | "failed"; detail?: string };

function loadConverge(): ConvergeFn {
  delete require.cache[configModulePath];
  return (require(configModulePath) as { convergeHermesDashboardModel: ConvergeFn })
    .convergeHermesDashboardModel;
}

beforeEach(() => {
  // Pass the command through as the "argv" so the docker-exec spies receive the
  // exact command array the helper built, without a live registry/container.
  privilegedExec.privilegedSandboxExecArgv = (...args: unknown[]) => args[1] as string[];
});

afterEach(() => {
  dockerExec.dockerSpawnSync = realSpawn;
  dockerExec.dockerExecFileSync = realExecFile;
  privilegedExec.privilegedSandboxExecArgv = realArgv;
  vi.restoreAllMocks();
});

const DASHBOARD_HOME = "/sandbox/.hermes/dashboard-home";

describe("convergeHermesDashboardModel (#6893)", () => {
  it("probes with a pure argv `test -d` and skips a switch when the profile is absent", () => {
    const spawn = vi.fn((..._args: unknown[]) => ({ status: 1, signal: null }));
    const execFile = vi.fn((..._args: unknown[]) => "");
    dockerExec.dockerSpawnSync = spawn;
    dockerExec.dockerExecFileSync = execFile;

    const result = loadConverge()("hermes", "/sandbox/.hermes", "vllm-local", "nemotron-ultra");

    expect(result).toEqual({ status: "absent" });
    expect(spawn.mock.calls[0][0]).toEqual(["test", "-d", DASHBOARD_HOME]);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("converges by writing model.default and providers.<provider>.default_model as argv", () => {
    dockerExec.dockerSpawnSync = vi.fn((..._args: unknown[]) => ({ status: 0, signal: null }));
    const execFile = vi.fn((..._args: unknown[]) => "");
    dockerExec.dockerExecFileSync = execFile;

    const result = loadConverge()("hermes", "/sandbox/.hermes/", "vllm-local", "nemotron-ultra");

    expect(result).toEqual({ status: "converged" });
    // Provider and model are discrete argv elements under the Dashboard
    // HERMES_HOME — never interpolated into a shell string.
    expect(execFile.mock.calls[0][0]).toEqual([
      "env",
      `HERMES_HOME=${DASHBOARD_HOME}`,
      "hermes",
      "config",
      "set",
      "model.default",
      "nemotron-ultra",
    ]);
    expect(execFile.mock.calls[1][0]).toEqual([
      "env",
      `HERMES_HOME=${DASHBOARD_HOME}`,
      "hermes",
      "config",
      "set",
      "providers.vllm-local.default_model",
      "nemotron-ultra",
    ]);
  });

  it("classifies a non-0/1 probe status (e.g. Docker 125) as a failure without a switch", () => {
    const execFile = vi.fn((..._args: unknown[]) => "");
    dockerExec.dockerSpawnSync = vi.fn((..._args: unknown[]) => ({ status: 125, signal: null }));
    dockerExec.dockerExecFileSync = execFile;

    const result = loadConverge()("hermes", "/sandbox/.hermes", "vllm-local", "nemotron-ultra");

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("125");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("classifies a spawn error as a failure and surfaces only the error message", () => {
    dockerExec.dockerSpawnSync = vi.fn(() => ({
      status: null,
      signal: null,
      error: new Error("docker not found"),
    }));
    dockerExec.dockerExecFileSync = vi.fn((..._args: unknown[]) => "");

    const result = loadConverge()("hermes", "/sandbox/.hermes", "vllm-local", "nemotron-ultra");

    expect(result).toEqual({ status: "failed", detail: "docker not found" });
  });

  it("classifies a failed model write as a failure carrying the underlying message", () => {
    dockerExec.dockerSpawnSync = vi.fn((..._args: unknown[]) => ({ status: 0, signal: null }));
    dockerExec.dockerExecFileSync = vi.fn(() => {
      throw new Error("hermes config set exited 1");
    });

    const result = loadConverge()("hermes", "/sandbox/.hermes", "vllm-local", "nemotron-ultra");

    expect(result).toEqual({ status: "failed", detail: "hermes config set exited 1" });
  });
});
