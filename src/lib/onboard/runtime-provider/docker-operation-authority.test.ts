// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createContextCapture as contextCapture,
  createDriftingContextCapture,
} from "../../../../test/helpers/docker-operation-authority-test-helpers";
import { prependInstalledUserLocalOpenshellPath } from "../openshell-pin";
import { createDockerLlamaCppOperationAuthority } from "./docker-llama-cpp-operation";
import {
  createDockerOperationAuthority,
  dockerOperationBindingSha256,
  dockerOperationCommandArguments,
} from "./docker-operation-authority";

const roots: string[] = [];

function fakeExecutableRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-authority-"));
  roots.push(root);
  return root;
}

function writeFakeExecutable(root: string, name: string, script: string): void {
  fs.writeFileSync(path.join(root, name), `#!/bin/sh\n${script}\n`, { mode: 0o700 });
}

function fakeDocker(output: string): string {
  return fakeDockerScript(`printf '%s\\n' '${output}'`);
}

function fakeDockerScript(script: string): string {
  const root = fakeExecutableRoot();
  writeFakeExecutable(root, "docker", script);
  return root;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("Docker operation authority", () => {
  it("binds the requested operation and endpoint to every daemon command", () => {
    const capture = contextCapture("ssh://nvidia@spark.example.test");
    const authority = createDockerOperationAuthority(
      "sandbox-lifecycle",
      { DOCKER_CONFIG: "/tmp/nemoclaw-docker", DOCKER_CONTEXT: "spark" },
      capture,
    );

    expect(authority.engine.operation).toBe("sandbox-lifecycle");
    expect(authority.engine.capture(["info"]).status).toBe(0);
    expect(path.isAbsolute(capture.mock.calls.at(-2)?.[0] ?? "")).toBe(true);
    expect(capture.mock.calls.at(-2)?.[1]).toEqual([
      "--config",
      "/tmp/nemoclaw-docker",
      "--context",
      "spark",
      "info",
    ]);
    expect(dockerOperationCommandArguments(authority, ["exec", "sandbox"])).toEqual([
      "--config",
      "/tmp/nemoclaw-docker",
      "--context",
      "spark",
      "exec",
      "sandbox",
    ]);
  });

  it("includes operation, engine, and executable-qualified authority in the stable binding digest", () => {
    const capture = contextCapture("ssh://nvidia@spark.example.test");
    const lifecycle = createDockerOperationAuthority(
      "sandbox-lifecycle",
      { HOME: "/tmp/nemoclaw-home", DOCKER_CONTEXT: "spark" },
      capture,
    );
    const cleanup = createDockerOperationAuthority(
      "workload-cleanup",
      { HOME: "/tmp/nemoclaw-home", DOCKER_CONTEXT: "spark" },
      capture,
    );

    expect(lifecycle.engine.authorityId).toBe(cleanup.engine.authorityId);
    expect(dockerOperationBindingSha256(lifecycle.engine)).not.toBe(
      dockerOperationBindingSha256(cleanup.engine),
    );
    expect(dockerOperationBindingSha256(lifecycle.engine)).toBe(
      createHash("sha256")
        .update(
          JSON.stringify({
            operation: "sandbox-lifecycle",
            engineId: "docker",
            authorityId: lifecycle.engine.authorityId,
          }),
        )
        .digest("hex"),
    );
  });

  it("keeps non-pulling endpoint authority stable across irrelevant PATH additions", () => {
    const executableRoot = fakeDocker("qualified");
    const emptyRoot = fakeExecutableRoot();
    const first = createDockerOperationAuthority("sandbox-lifecycle", {
      HOME: "/tmp/nemoclaw-home",
      DOCKER_HOST: "unix:///tmp/nemoclaw-docker.sock",
      PATH: executableRoot,
    });
    const second = createDockerOperationAuthority("sandbox-lifecycle", {
      HOME: "/tmp/nemoclaw-home",
      DOCKER_HOST: "unix:///tmp/nemoclaw-docker.sock",
      PATH: `${emptyRoot}${path.delimiter}${executableRoot}`,
    });

    expect(second.engine.authorityId).toBe(first.engine.authorityId);
  });

  it("binds the full delegated-command PATH for host-local inference pulls", () => {
    const executableRoot = fakeDocker("qualified");
    const emptyRoot = fakeExecutableRoot();
    const first = createDockerOperationAuthority("host-local-inference", {
      HOME: "/tmp/nemoclaw-home",
      DOCKER_HOST: "unix:///tmp/nemoclaw-docker.sock",
      PATH: executableRoot,
    });
    const second = createDockerOperationAuthority("host-local-inference", {
      HOME: "/tmp/nemoclaw-home",
      DOCKER_HOST: "unix:///tmp/nemoclaw-docker.sock",
      PATH: `${emptyRoot}${path.delimiter}${executableRoot}`,
    });

    expect(second.engine.authorityId).not.toBe(first.engine.authorityId);
  });

  it("keeps managed llama.cpp Docker authority after onboarding resumes (#9585)", () => {
    const executableRoot = fakeDocker("qualified");
    const home = fakeExecutableRoot();
    const localBin = path.join(home, ".local", "bin");
    fs.mkdirSync(localBin, { recursive: true });
    writeFakeExecutable(localBin, "openshell", "printf 'openshell\\n'");
    const common = {
      HOME: home,
      DOCKER_HOST: "unix:///tmp/nemoclaw-docker.sock",
    };
    const installed = createDockerLlamaCppOperationAuthority({
      ...common,
      PATH: `${localBin}${path.delimiter}${executableRoot}`,
    });
    const resumedEnvironment = {
      ...common,
      PATH: executableRoot,
    };
    const resumed = createDockerLlamaCppOperationAuthority(resumedEnvironment);

    expect(resumedEnvironment.PATH).toBe(executableRoot);
    expect(resumed.engine.authorityId).toBe(installed.engine.authorityId);
    expect(dockerOperationBindingSha256(resumed.engine)).toBe(
      dockerOperationBindingSha256(installed.engine),
    );
  });

  it("does not trust a non-executable user-local OpenShell path (#9585)", () => {
    const executableRoot = fakeDocker("qualified");
    const home = fakeExecutableRoot();
    const localBin = path.join(home, ".local", "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(path.join(localBin, "openshell"), "not executable\n", { mode: 0o600 });
    const environment = {
      HOME: home,
      DOCKER_HOST: "unix:///tmp/nemoclaw-docker.sock",
      PATH: executableRoot,
    };
    const baseline = createDockerOperationAuthority("host-local-inference", environment);
    const managed = createDockerLlamaCppOperationAuthority(environment);

    expect(managed.engine.authorityId).toBe(baseline.engine.authorityId);
    expect(environment.PATH).toBe(executableRoot);
  });

  it("does not trust a user-local OpenShell directory (#9585)", () => {
    const home = fakeExecutableRoot();
    const localBin = path.join(home, ".local", "bin");
    fs.mkdirSync(path.join(localBin, "openshell"), { recursive: true });
    const environment = { HOME: home, PATH: "/usr/bin" };
    const getFutureShellPathHint = vi.fn(() => "export PATH");

    expect(
      prependInstalledUserLocalOpenshellPath({ env: environment, getFutureShellPathHint }),
    ).toBeNull();
    expect(getFutureShellPathHint).not.toHaveBeenCalled();
    expect(environment.PATH).toBe("/usr/bin");
  });

  it("keeps authority stable across terminal and SSH session metadata (#9584)", () => {
    const executableRoot = fakeDockerScript(
      `printf '%s\\n' "\${TERM-unset}" "\${XDG_SESSION_ID-unset}" "\${XDG_SESSION_CLASS-unset}" "\${XDG_SESSION_TYPE-unset}"`,
    );
    const common = {
      HOME: "/tmp/nemoclaw-home",
      DOCKER_HOST: "unix:///tmp/nemoclaw-docker.sock",
      PATH: executableRoot,
      XDG_RUNTIME_DIR: "/run/user/1000",
    };
    const callerTerm = "nemoclaw-caller-terminal";
    const first = createDockerOperationAuthority("host-local-inference", {
      ...common,
      XDG_SESSION_ID: "101",
      XDG_SESSION_CLASS: "user",
      XDG_SESSION_TYPE: "tty",
      TERM: "xterm-256color",
    });
    const second = createDockerOperationAuthority("host-local-inference", {
      ...common,
      XDG_SESSION_ID: "102",
      XDG_SESSION_CLASS: "background",
      XDG_SESSION_TYPE: "unspecified",
      TERM: callerTerm,
    });

    expect(second.engine.authorityId).toBe(first.engine.authorityId);
    expect(dockerOperationBindingSha256(second.engine)).toBe(
      dockerOperationBindingSha256(first.engine),
    );
    const [dockerTerm, ...dockerSessionMetadata] = second.engine
      .capture(["version"])
      .stdout.trimEnd()
      .split("\n");
    // macOS /bin/sh supplies TERM=dumb after NemoClaw removes the caller value.
    expect(dockerTerm).not.toBe(callerTerm);
    expect(dockerSessionMetadata).toEqual(["unset", "unset", "unset"]);
  });

  it("keeps host-local inference authority stable across terminal attachment changes (#9599)", () => {
    const executableRoot = fakeDocker("qualified");
    const environment = {
      HOME: "/tmp/nemoclaw-home",
      DOCKER_HOST: "unix:///tmp/nemoclaw-docker.sock",
      PATH: executableRoot,
    };
    const interactive = createDockerOperationAuthority("host-local-inference", {
      ...environment,
      TERM: "xterm-256color",
    });
    const detached = createDockerOperationAuthority("host-local-inference", environment);

    expect(detached.engine.authorityId).toBe(interactive.engine.authorityId);
    expect(dockerOperationBindingSha256(detached.engine)).toBe(
      dockerOperationBindingSha256(interactive.engine),
    );
  });

  it("fails closed when an earlier Docker credential helper appears", () => {
    const executableRoot = fakeDocker("qualified");
    const prefixRoot = fakeExecutableRoot();
    const commandPath = `${prefixRoot}${path.delimiter}${executableRoot}`;
    const authority = createDockerOperationAuthority("host-local-inference", {
      HOME: "/tmp/nemoclaw-home",
      DOCKER_HOST: "unix:///tmp/nemoclaw-docker.sock",
      PATH: commandPath,
    });

    writeFakeExecutable(
      prefixRoot,
      "docker-credential-registry+alternate",
      "printf 'credential\\n'",
    );
    const replacement = createDockerOperationAuthority("host-local-inference", {
      HOME: "/tmp/nemoclaw-home",
      DOCKER_HOST: "unix:///tmp/nemoclaw-docker.sock",
      PATH: commandPath,
    });

    expect(replacement.engine.authorityId).not.toBe(authority.engine.authorityId);
    expect(() => authority.engine.capture(["version"])).toThrow(
      "Docker operation delegated command set changed after qualification",
    );
  });

  it("binds and revalidates the effective SSH helper for SSH endpoints", () => {
    const executableRoot = fakeDocker("qualified");
    writeFakeExecutable(executableRoot, "ssh", "printf 'first-ssh\\n'");
    const environment = {
      HOME: "/tmp/nemoclaw-home",
      DOCKER_HOST: "ssh://nvidia@spark.example.test",
      PATH: executableRoot,
    };
    const authority = createDockerOperationAuthority("host-local-inference", environment);

    writeFakeExecutable(executableRoot, "ssh", "printf 'second-ssh\\n'");
    const replacement = createDockerOperationAuthority("host-local-inference", environment);

    expect(replacement.engine.authorityId).not.toBe(authority.engine.authorityId);
    expect(() => authority.engine.capture(["version"])).toThrow(
      "Docker operation delegated command set changed after qualification",
    );
  });

  it("rejects relative PATH entries and env-based delegated interpreters", () => {
    const executableRoot = fakeDocker("qualified");
    expect(() =>
      createDockerOperationAuthority("host-local-inference", {
        HOME: "/tmp/nemoclaw-home",
        DOCKER_HOST: "unix:///tmp/nemoclaw-docker.sock",
        PATH: `${executableRoot}${path.delimiter}relative-bin`,
      }),
    ).toThrow("PATH must contain only absolute directories");

    fs.writeFileSync(
      path.join(executableRoot, "docker-credential-registry"),
      "#!/usr/bin/env sh\nprintf 'credential\\n'\n",
      { mode: 0o700 },
    );
    expect(() =>
      createDockerOperationAuthority("host-local-inference", {
        HOME: "/tmp/nemoclaw-home",
        DOCKER_HOST: "unix:///tmp/nemoclaw-docker.sock",
        PATH: executableRoot,
      }),
    ).toThrow("cannot delegate through env");
  });

  it("invokes one absolute qualified executable after process PATH drift", () => {
    const first = fakeDocker("first");
    const second = fakeDocker("second");
    const authority = createDockerOperationAuthority("sandbox-lifecycle", {
      PATH: first,
      HOME: "/tmp/nemoclaw-home",
      DOCKER_HOST: "unix:///tmp/nemoclaw-docker.sock",
    });
    vi.stubEnv("PATH", second);

    expect(authority.engine.capture(["version"]).stdout).toBe("first\n");
  });

  it("streams through the same qualified executable after process PATH drift", async () => {
    const first = fakeDocker("first-stream");
    const second = fakeDocker("second-stream");
    const authority = createDockerOperationAuthority("host-local-inference", {
      PATH: first,
      HOME: "/tmp/nemoclaw-home",
      DOCKER_HOST: "unix:///tmp/nemoclaw-docker.sock",
    });
    vi.stubEnv("PATH", second);
    const child = authority.spawn(["version"]);
    const stdout: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));

    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status) => {
        status === 0 ? resolve() : reject(new Error(`fake Docker exited ${String(status)}`));
      });
    });
    expect(Buffer.concat(stdout).toString("utf8")).toBe("first-stream\n");
  });

  it("forwards an explicitly requested Hugging Face token and the bound SSH agent", async () => {
    const executableRoot = fakeDockerScript(
      `printf '%s\\n' "\${HF_TOKEN-unset}" "\${SSH_AUTH_SOCK-unset}" "\${PATH-unset}"`,
    );
    writeFakeExecutable(executableRoot, "ssh", "printf 'ssh\\n'");
    const authority = createDockerOperationAuthority("host-local-inference", {
      PATH: executableRoot,
      HOME: "/tmp/nemoclaw-home",
      DOCKER_HOST: "ssh://nvidia@spark.example.test",
      SSH_AUTH_SOCK: "/tmp/nemoclaw-ssh-agent.sock",
    });
    const child = authority.spawn(
      ["run", "-e", "HF_TOKEN", "example.invalid/downloader@sha256:deadbeef"],
      {
        env: {
          HF_TOKEN: "hf_secret_value",
          PATH: "/tmp/unqualified-path",
          SSH_AUTH_SOCK: "/tmp/unqualified-ssh-agent.sock",
        },
      },
    );
    const stdout: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));

    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status) => {
        status === 0 ? resolve() : reject(new Error(`fake Docker exited ${String(status)}`));
      });
    });
    expect(Buffer.concat(stdout).toString("utf8")).toBe(
      `hf_secret_value\n/tmp/nemoclaw-ssh-agent.sock\n${executableRoot}\n`,
    );
  });

  it("fails closed when the qualified executable identity changes", () => {
    const executableRoot = fakeDocker("first");
    const authority = createDockerOperationAuthority("sandbox-lifecycle", {
      PATH: executableRoot,
      HOME: "/tmp/nemoclaw-home",
      DOCKER_HOST: "unix:///tmp/nemoclaw-docker.sock",
    });
    fs.writeFileSync(path.join(executableRoot, "docker"), "#!/bin/sh\nprintf 'changed\\n'\n", {
      mode: 0o700,
    });

    expect(() => authority.engine.capture(["version"])).toThrow(
      "Docker operation executable changed after qualification",
    );
  });

  it("fails closed when the fixed PATH has no Docker executable", () => {
    expect(() =>
      createDockerOperationAuthority("sandbox-lifecycle", {
        HOME: "/tmp/nemoclaw-home",
        DOCKER_HOST: "unix:///tmp/nemoclaw-docker.sock",
        PATH: fakeExecutableRoot(),
      }),
    ).toThrow("Docker operation could not resolve one absolute Docker executable");
  });

  it("rejects plaintext remote TCP before issuing a daemon command", () => {
    const capture = contextCapture("unix:///var/run/docker.sock");

    expect(() =>
      createDockerOperationAuthority(
        "sandbox-lifecycle",
        { HOME: "/tmp/nemoclaw-home", DOCKER_HOST: "tcp://spark.example.test:2375" },
        capture,
      ),
    ).toThrow("requires verified TLS for remote Docker TCP endpoints");
    expect(capture).not.toHaveBeenCalled();
  });

  it("fails closed before a daemon command when a qualified context endpoint drifts", () => {
    const capture = createDriftingContextCapture();
    const authority = createDockerOperationAuthority(
      "sandbox-lifecycle",
      { HOME: "/tmp/nemoclaw-home", DOCKER_CONTEXT: "spark" },
      capture,
    );

    expect(() => authority.engine.capture(["info"])).toThrow(
      "Docker context endpoint changed after qualification",
    );
    expect(capture.mock.calls.some(([, args]) => args.at(-1) === "info")).toBe(false);
  });

  it("preserves the managed llama.cpp error and streamed-command boundary", () => {
    const capture = contextCapture("ssh://nvidia@spark.example.test");
    const spawn = vi.fn(() => ({}) as never);
    const authority = createDockerLlamaCppOperationAuthority(
      { HOME: "/tmp/nemoclaw-home", DOCKER_CONTEXT: "spark" },
      capture,
      spawn,
    );

    authority.spawn(["run", "example.invalid/downloader"]);

    expect(spawn).toHaveBeenCalledWith(
      [
        "--config",
        "/tmp/nemoclaw-home/.docker",
        "--context",
        "spark",
        "run",
        "example.invalid/downloader",
      ],
      undefined,
    );
    expect(() =>
      createDockerLlamaCppOperationAuthority({
        HOME: "/tmp/nemoclaw-home",
        DOCKER_HOST: "tcp://spark.example.test:2375",
      }),
    ).toThrow(/^Managed llama\.cpp requires verified TLS for remote Docker TCP endpoints\.$/u);
  });
});
