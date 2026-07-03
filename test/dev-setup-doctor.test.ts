// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");
const scriptUnderTest = path.join(repoRoot, "scripts", "dev-setup.sh");
const tempRoots: string[] = [];

type Fixture = {
  cliArtifact: string;
  commandLog: string;
  env: NodeJS.ProcessEnv;
  fakeBin: string;
  globalRoot: string;
  pluginArtifact: string;
  repo: string;
  script: string;
};

function writeExecutable(filePath: string, contents = "#!/usr/bin/env bash\nexit 0\n"): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, { mode: 0o755 });
}

function writeTool(fakeBin: string, name: string, body: string): void {
  writeExecutable(
    path.join(fakeBin, name),
    `#!/usr/bin/env bash
set -u
if [ -n "\${FAKE_COMMAND_LOG:-}" ]; then
  printf '${name} %s\\n' "$*" >>"\${FAKE_COMMAND_LOG}"
fi
${body}
`,
  );
}

function writeManagedCliShim(
  fakeBin: string,
  repo: string,
  extraLines: string[] = [],
  nodeDir = fakeBin,
): void {
  writeExecutable(
    path.join(fakeBin, "nemoclaw"),
    [
      "#!/usr/bin/env bash",
      "# NemoClaw dev-shim - managed by scripts/npm-link-or-shim.sh",
      `export PATH="${nodeDir}:$PATH"`,
      ...extraLines,
      `exec "${repo}/bin/nemoclaw.js" "$@"`,
      "",
    ].join("\n"),
  );
}

function createFixture(): Fixture {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dev-doctor-"));
  tempRoots.push(tmp);
  const repo = path.join(tmp, "NemoClaw");
  const fakeBin = path.join(tmp, "bin");
  const hooksDir = path.join(repo, ".git", "hooks");
  const globalRoot = path.join(tmp, "global-node-modules");
  const commandLog = path.join(tmp, "commands.log");

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.mkdirSync(globalRoot, { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), "{}\n");
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "# Agent Instructions\n");
  const fixtureScript = path.join(repo, "scripts", "dev-setup.sh");
  fs.mkdirSync(path.dirname(fixtureScript), { recursive: true });
  fs.copyFileSync(scriptUnderTest, fixtureScript);
  fs.chmodSync(fixtureScript, 0o755);

  for (const file of [
    "node_modules/.bin/tsc",
    "node_modules/.bin/prek",
    "node_modules/.bin/pi",
    "nemoclaw/node_modules/.bin/tsc",
    "bin/nemoclaw.js",
    ".venv/bin/python",
  ]) {
    writeExecutable(
      path.join(repo, file),
      file === ".venv/bin/python" ? '#!/usr/bin/env bash\necho "Python 3.12.1"\n' : undefined,
    );
  }
  writeExecutable(
    path.join(repo, "node_modules", ".bin", "prek"),
    `#!/usr/bin/env bash
if [ -n "\${FAKE_COMMAND_LOG:-}" ]; then
  printf 'prek %s\\n' "$*" >>"\${FAKE_COMMAND_LOG}"
fi
`,
  );
  writeExecutable(
    path.join(repo, "scripts", "npm-link-or-shim.sh"),
    `#!/usr/bin/env bash
if [ -n "\${FAKE_COMMAND_LOG:-}" ]; then
  printf 'npm-link-or-shim %s\\n' "$*" >>"\${FAKE_COMMAND_LOG}"
fi
`,
  );
  const cliArtifact = path.join(repo, "build-fixture", "cli.js");
  const pluginArtifact = path.join(repo, "build-fixture", "plugin.js");
  fs.mkdirSync(path.dirname(cliArtifact), { recursive: true });
  fs.writeFileSync(cliArtifact, "// built\n");
  fs.writeFileSync(pluginArtifact, "// built\n");
  for (const hook of ["pre-commit", "commit-msg", "pre-push"]) {
    writeExecutable(path.join(hooksDir, hook));
  }

  writeTool(
    fakeBin,
    "node",
    `if [ "\${1:-}" = "--version" ]; then
  echo "v22.16.0"
elif [ "\${1:-}" = "${repo}/bin/nemoclaw.js" ] && [ "\${2:-}" = "onboard" ]; then
  echo "runtime onboard"
else
  exit 1
fi`,
  );
  writeTool(
    fakeBin,
    "npm",
    `if [ "\${1:-}" = "root" ] && [ "\${2:-}" = "-g" ]; then
  echo "${globalRoot}"
elif [ "\${FAKE_NPM_ROOT_INSTALL_FAIL:-}" = "1" ] && [ "\${1:-}" = "install" ]; then
  exit 1
elif [ "\${FAKE_NPM_PLUGIN_INSTALL_FAIL:-}" = "1" ] && [ "\${1:-}" = "--prefix" ] && [ "\${2:-}" = "nemoclaw" ] && [ "\${3:-}" = "install" ]; then
  exit 1
else
  echo "10.9.0"
fi`,
  );
  writeTool(fakeBin, "python3", 'echo "Python 3.12.1"');
  writeTool(fakeBin, "uv", 'echo "uv 0.11.0"');
  writeTool(fakeBin, "hadolint", 'echo "Haskell Dockerfile Linter 2.14.0"');
  writeTool(
    fakeBin,
    "git",
    `case " $* " in
  *" --version "*) echo "git version 2.50.0" ;;
  *" config --get user.name "*)
    if [ "\${FAKE_GIT_IDENTITY_MISSING:-}" = "1" ]; then exit 1; fi
    echo "Test Contributor"
    ;;
  *" config --get user.email "*)
    if [ "\${FAKE_GIT_IDENTITY_MISSING:-}" = "1" ]; then exit 1; fi
    echo "contributor@example.com"
    ;;
  *" config --get commit.gpgsign "*)
    if [ "\${FAKE_GIT_SIGNING_MISSING:-}" = "1" ]; then exit 1; fi
    echo "true"
    ;;
  *" config --get gpg.format "*)
    if [ "\${FAKE_GIT_SIGN_FORMAT_UNSET:-}" = "1" ]; then exit 1; fi
    echo "\${FAKE_GIT_SIGN_FORMAT-ssh}"
    ;;
  *" config --get user.signingkey "*)
    if [ "\${FAKE_GIT_SIGNING_MISSING:-}" = "1" ]; then exit 1; fi
    echo "test-signing-key"
    ;;
  *" config --local --get core.hooksPath "*)
    if [ -n "\${FAKE_GIT_LOCAL_HOOKS_PATH:-}" ]; then
      echo "\${FAKE_GIT_LOCAL_HOOKS_PATH}"
    else
      exit 1
    fi
    ;;
  *" config --get core.hooksPath "*)
    if [ -n "\${FAKE_GIT_HOOKS_PATH:-}" ]; then
      echo "\${FAKE_GIT_HOOKS_PATH}"
    else
      exit 1
    fi
    ;;
  *" rev-parse --git-path hooks "*) echo "${hooksDir}" ;;
  *) exit 1 ;;
esac`,
  );
  writeTool(
    fakeBin,
    "gh",
    `if [ "\${1:-}" = "--version" ]; then
  echo "gh version 2.95.0"
elif [ "\${1:-}" = "auth" ] && [ "\${2:-}" = "status" ]; then
  if [ "\${FAKE_GH_AUTH_FAIL:-}" = "1" ]; then
    echo "token=should-not-appear" >&2
    exit 1
  fi
else
  exit 1
fi`,
  );
  writeTool(
    fakeBin,
    "docker",
    `if [ "\${FAKE_DOCKER_FAIL:-}" = "1" ]; then
  echo "credential=should-not-appear" >&2
  exit 1
fi
if [ "\${1:-}" = "info" ]; then
  echo "29.6.1|\${FAKE_DOCKER_CPUS:-4}|\${FAKE_DOCKER_MEMORY:-17179869184}|\${FAKE_DOCKER_DRIVER:-overlay2}"
else
  echo "Docker version 29.6.1"
fi`,
  );
  writeTool(
    fakeBin,
    "uname",
    `case "\${1:-}" in
  -s) printf '%s\\n' "\${FAKE_HOST_OS:-Darwin}" ;;
  -m) printf '%s\\n' "\${FAKE_HOST_ARCH:-arm64}" ;;
  *) exit 1 ;;
esac`,
  );
  fs.symlinkSync(path.join(repo, "bin", "nemoclaw.js"), path.join(fakeBin, "nemoclaw"));

  return {
    cliArtifact,
    commandLog,
    env: {
      FAKE_COMMAND_LOG: commandLog,
      HOME: path.join(tmp, "home"),
      NEMOCLAW_DEV_DOCTOR_CLI_ARTIFACT: cliArtifact,
      NEMOCLAW_DEV_DOCTOR_PLUGIN_ARTIFACT: pluginArtifact,
      PATH: `${fakeBin}:/usr/bin:/bin`,
    },
    fakeBin,
    globalRoot,
    pluginArtifact,
    repo,
    script: fixtureScript,
  };
}

function runDoctor(
  fixture: Fixture,
  env: NodeJS.ProcessEnv = {},
): {
  output: string;
  status: number;
} {
  const result = spawnSync("/bin/bash", [fixture.script, "--doctor"], {
    cwd: fixture.repo,
    encoding: "utf-8",
    env: { ...fixture.env, ...env },
  });
  return {
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    status: result.status ?? -1,
  };
}

function runSetup(
  fixture: Fixture,
  args: string[] = [],
  env: NodeJS.ProcessEnv = {},
): {
  output: string;
  status: number;
} {
  const result = spawnSync("/bin/bash", [fixture.script, ...args], {
    cwd: fixture.repo,
    encoding: "utf-8",
    env: { ...fixture.env, ...env },
  });
  return {
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    status: result.status ?? -1,
  };
}

function readCommandLog(fixture: Fixture): string {
  return fs.existsSync(fixture.commandLog) ? fs.readFileSync(fixture.commandLog, "utf-8") : "";
}

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe("contributor environment doctor", () => {
  it("reports a ready environment without mutating the fixture", () => {
    const fixture = createFixture();
    const before = fs.readdirSync(fixture.repo, { recursive: true }).sort();

    const result = runDoctor(fixture);

    expect(result.status).toBe(0);
    expect(result.output).toContain("Ready to create a feature branch.");
    expect(result.output).toContain("Python repository environment 3.12.1");
    expect(result.output).toContain("Git commit signing configured (ssh)");
    expect(result.output).toContain("Docker 29.6.1: 4 vCPU, 16.0 GiB, overlay2 storage");
    expect(result.output).toContain("0 failed");
    expect(fs.readdirSync(fixture.repo, { recursive: true }).sort()).toEqual(before);
  });

  it("rejects unsupported tool versions with a precise remediation", () => {
    const fixture = createFixture();
    writeTool(fixture.fakeBin, "node", 'echo "v20.15.0"');

    const result = runDoctor(fixture);

    expect(result.status).toBe(1);
    expect(result.output).toContain("Node.js 20.15.0 is below 22.16.0");
    expect(result.output).toContain("Next: Install Node.js 22.16 or newer.");
  }, 30_000);

  it("requires the uv-managed repository Python environment", () => {
    const fixture = createFixture();
    fs.rmSync(path.join(fixture.repo, ".venv"), { recursive: true });

    const result = runDoctor(fixture);

    expect(result.status).toBe(1);
    expect(result.output).toContain("Python repository environment: missing");
    expect(result.output).toContain(
      "Next: Run: uv sync --python /path/to/python3.11-or-newer --no-python-downloads",
    );
  });

  it("rejects build artifacts older than their source trees", () => {
    const fixture = createFixture();
    const oldTime = new Date(Date.now() - 10_000);
    fs.utimesSync(fixture.cliArtifact, oldTime, oldTime);
    const changedSource = path.join(fixture.repo, "src", "changed.ts");
    fs.mkdirSync(path.dirname(changedSource), { recursive: true });
    fs.writeFileSync(changedSource, "export {};\n");

    const result = runDoctor(fixture);

    expect(result.status).toBe(1);
    expect(result.output).toContain("CLI build artifacts: stale");
    expect(result.output).toContain("Next: Run: npm run build:cli");
  });

  it("redacts failed GitHub and Docker command output", () => {
    const fixture = createFixture();

    const result = runDoctor(fixture, {
      FAKE_DOCKER_FAIL: "1",
      FAKE_GH_AUTH_FAIL: "1",
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain("GitHub authentication failed");
    expect(result.output).toContain("Docker daemon is not reachable");
    expect(result.output).not.toContain("should-not-appear");
  });

  it("reports missing signing configuration and required hooks", () => {
    const fixture = createFixture();
    fs.rmSync(path.join(fixture.repo, ".git", "hooks", "pre-push"));

    const result = runDoctor(fixture, { FAKE_GIT_SIGNING_MISSING: "1" });

    expect(result.status).toBe(1);
    expect(result.output).toContain("Git commit signing is incomplete");
    expect(result.output).toContain("Git pre-push hook is missing");
  });

  it("rejects an unsupported git signing format with a precise remediation", () => {
    const fixture = createFixture();

    const result = runDoctor(fixture, { FAKE_GIT_SIGN_FORMAT: "bogus" });

    expect(result.status).toBe(1);
    expect(result.output).not.toContain("Git commit signing configured");
    expect(result.output).toContain("Git commit signing format is unsupported (bogus)");
    expect(result.output).toContain(
      "Next: Set gpg.format to openpgp, ssh, or x509, or run: git config --unset gpg.format",
    );
  });

  it("accepts an unset git signing format and reports the openpgp default", () => {
    const fixture = createFixture();

    const result = runDoctor(fixture, { FAKE_GIT_SIGN_FORMAT_UNSET: "1" });

    expect(result.status).toBe(0);
    expect(result.output).toContain("Git commit signing configured (openpgp)");
  });

  it("rejects an explicitly empty git signing format", () => {
    const fixture = createFixture();

    const result = runDoctor(fixture, { FAKE_GIT_SIGN_FORMAT: "" });

    expect(result.status).toBe(1);
    expect(result.output).not.toContain("Git commit signing configured");
    expect(result.output).not.toContain("Ready to create a feature branch.");
    expect(result.output).toContain("Git commit signing format is unsupported (empty)");
  });

  it.each(["openpgp", "x509"])("accepts the %s git signing format", (format) => {
    const fixture = createFixture();

    const result = runDoctor(fixture, { FAKE_GIT_SIGN_FORMAT: format });

    expect(result.status).toBe(0);
    expect(result.output).toContain(`Git commit signing configured (${format})`);
  });

  it("reports missing commands, dependencies, artifacts, and contributor identity", () => {
    const fixture = createFixture();
    fs.rmSync(path.join(fixture.fakeBin, "hadolint"));
    fs.rmSync(path.join(fixture.repo, "node_modules", ".bin", "tsc"));
    fs.rmSync(fixture.pluginArtifact);

    const result = runDoctor(fixture, { FAKE_GIT_IDENTITY_MISSING: "1" });

    expect(result.status).toBe(1);
    expect(result.output).toContain("hadolint: not found");
    expect(result.output).toContain("Root TypeScript dependencies: missing or not executable");
    expect(result.output).toContain("Plugin build artifacts: missing");
    expect(result.output).toContain("Git contributor identity is incomplete");
  });

  it("does not ask npm to download TypeScript when plugin dependencies are missing", () => {
    const fixture = createFixture();
    fs.rmSync(path.join(fixture.repo, "nemoclaw", "node_modules", ".bin", "tsc"));

    const result = runDoctor(fixture);

    expect(result.status).toBe(1);
    expect(result.output).toContain("Plugin TypeScript dependencies: missing or not executable");
    expect(readCommandLog(fixture)).not.toMatch(/^npm .* exec(?: |$)/m);
  });

  it("rejects a foreign PATH CLI even when the global package links to this checkout", () => {
    const fixture = createFixture();
    fs.rmSync(path.join(fixture.fakeBin, "nemoclaw"));
    writeTool(fixture.fakeBin, "nemoclaw", 'echo "nemoclaw v0.1.0"');
    fs.symlinkSync(fixture.repo, path.join(fixture.globalRoot, "nemoclaw"), "dir");

    const result = runDoctor(fixture);

    expect(result.status).toBe(1);
    expect(result.output).toContain("NemoClaw CLI resolves to a different installation");
  });

  it("accepts the exact managed user-local CLI shim", () => {
    const fixture = createFixture();
    fs.rmSync(path.join(fixture.fakeBin, "nemoclaw"));
    writeManagedCliShim(fixture.fakeBin, fixture.repo);

    const result = runDoctor(fixture);

    expect(result.status).toBe(0);
    expect(result.output).toContain("Local NemoClaw CLI resolves to this checkout");
  });

  it("rejects a marker-spoofed CLI shim with extra commands", () => {
    const fixture = createFixture();
    fs.rmSync(path.join(fixture.fakeBin, "nemoclaw"));
    writeManagedCliShim(fixture.fakeBin, fixture.repo, ["echo unexpected"]);

    const result = runDoctor(fixture);

    expect(result.status).toBe(1);
    expect(result.output).toContain("NemoClaw CLI resolves to a different installation");
  });

  it("rejects a managed CLI shim that pins a different Node executable", () => {
    const fixture = createFixture();
    fs.rmSync(path.join(fixture.fakeBin, "nemoclaw"));
    writeManagedCliShim(fixture.fakeBin, fixture.repo, [], path.join(fixture.repo, "foreign-bin"));

    const result = runDoctor(fixture);

    expect(result.status).toBe(1);
    expect(result.output).toContain("NemoClaw CLI resolves to a different installation");
  });

  it("accepts the repository-root override in doctor mode", () => {
    const fixture = createFixture();

    const result = runDoctor(fixture, { NEMOCLAW_DEV_DOCTOR_REPO_ROOT: fixture.repo });

    expect(result.status).toBe(0);
    expect(result.output).toContain(`Repo: ${fixture.repo}`);
  });

  it("rejects Docker resources below the documented sandbox minimum", () => {
    const fixture = createFixture();

    const result = runDoctor(fixture, {
      FAKE_DOCKER_CPUS: "2",
      FAKE_DOCKER_MEMORY: "4294967296",
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain("below the minimum 4 vCPU and 8 GiB");
    expect(result.output).toContain("Increase container-runtime resources before sandbox builds.");
  });

  it("warns without failing when Docker memory is below the recommendation", () => {
    const fixture = createFixture();

    const result = runDoctor(fixture, {
      FAKE_DOCKER_CPUS: "4",
      FAKE_DOCKER_MEMORY: "8589934592",
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain("Docker memory is below the recommended 16 GiB");
    expect(result.output).toContain("1 warning(s)");
  });

  it("emits a machine-readable readiness report", () => {
    const fixture = createFixture();
    const result = spawnSync("/bin/bash", [fixture.script, "--doctor", "--json"], {
      cwd: fixture.repo,
      encoding: "utf-8",
      env: fixture.env,
    });

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      ready: true,
      schemaVersion: 1,
      summary: { failed: 0, warnings: 0 },
    });
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Pinned Pi coding agent", status: "pass" }),
      ]),
    );
  });

  it("escapes every JSON control character emitted by a check", () => {
    const fixture = createFixture();
    const escapedRepo = path.join(path.dirname(fixture.repo), 'quoted"\\path\b\f\n\r\t\u0001');
    fs.symlinkSync(fixture.repo, escapedRepo, "dir");
    const result = spawnSync("/bin/bash", [fixture.script, "--doctor", "--json"], {
      cwd: fixture.repo,
      encoding: "utf-8",
      env: { ...fixture.env, NEMOCLAW_DEV_DOCTOR_REPO_ROOT: escapedRepo },
    });

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.repo).toBe(escapedRepo);
  });

  it("rejects unsupported modes with usage and exit status 2", () => {
    const fixture = createFixture();
    const result = spawnSync("/bin/bash", [fixture.script, "--unknown"], {
      cwd: fixture.repo,
      encoding: "utf-8",
      env: fixture.env,
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain(
      "Usage: ./scripts/dev-setup.sh [--repair | --expose-cli | --with-runtime]",
    );
  });
});

describe("contributor repository setup", () => {
  it("repairs only repository-local state and finishes with the doctor", () => {
    const fixture = createFixture();

    const result = runSetup(fixture);

    expect(result.status).toBe(0);
    expect(result.output).toContain("Ready to create a feature branch.");
    const commands = readCommandLog(fixture);
    expect(commands).toContain("npm install --include=dev --ignore-scripts");
    expect(commands).toContain("npm --prefix nemoclaw install --include=dev --ignore-scripts");
    expect(commands).toContain(
      `uv sync --python ${path.join(fixture.repo, ".venv", "bin", "python")} --no-python-downloads`,
    );
    expect(commands).not.toContain("uv sync --python 3.11");
    expect(commands).toContain("prek install");
    expect(commands).not.toContain("npm-link-or-shim");
    expect(commands).not.toContain("onboard");
  });

  it("supports repeated repair runs without exposing the CLI or starting runtime onboarding", () => {
    const fixture = createFixture();

    expect(runSetup(fixture, ["--repair"]).status).toBe(0);
    expect(runSetup(fixture, ["--repair"]).status).toBe(0);

    const commands = readCommandLog(fixture);
    expect(commands).toContain("npm install --include=dev --ignore-scripts");
    expect(commands).toContain("npm --prefix nemoclaw install --include=dev --ignore-scripts");
    expect(commands).toContain(
      `uv sync --python ${path.join(fixture.repo, ".venv", "bin", "python")} --no-python-downloads`,
    );
    expect(commands).not.toContain("uv sync --python 3.11");
    expect(commands).not.toContain("npm-link-or-shim");
    expect(commands).not.toContain("onboard");
  });

  it("keeps development dependencies when production npm settings are inherited", () => {
    const fixture = createFixture();

    const result = runSetup(fixture, [], {
      NODE_ENV: "production",
      npm_config_omit: "dev",
    });

    expect(result.status).toBe(0);
    const commands = readCommandLog(fixture);
    expect(commands).toContain("npm install --include=dev --ignore-scripts");
    expect(commands).toContain("npm --prefix nemoclaw install --include=dev --ignore-scripts");
  });

  it("stops before repository changes when a required host command is missing", () => {
    const fixture = createFixture();
    fs.rmSync(path.join(fixture.fakeBin, "uv"));

    const result = runSetup(fixture);

    expect(result.status).toBe(1);
    expect(result.output).toContain("Missing required host command: uv");
    expect(readCommandLog(fixture)).not.toContain("npm install");
  });

  it("rejects unsupported Node.js before repository changes", () => {
    const fixture = createFixture();
    writeTool(fixture.fakeBin, "node", 'echo "v20.15.0"');

    const result = runSetup(fixture);

    expect(result.status).toBe(1);
    expect(result.output).toContain("Node.js 20.15.0 is below 22.16.0");
    expect(readCommandLog(fixture)).not.toContain("npm install");
  });

  it("stops before repository changes on an unsupported host", () => {
    const fixture = createFixture();

    const result = runSetup(fixture, [], {
      FAKE_HOST_ARCH: "mips64",
      FAKE_HOST_OS: "Plan9",
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain("Unsupported host: Plan9 mips64");
    expect(readCommandLog(fixture)).not.toContain("npm install");
  });

  it("stops before dependency installation for an inherited Git hooks override", () => {
    const fixture = createFixture();

    const result = runSetup(fixture, [], { FAKE_GIT_HOOKS_PATH: "/etc/git-hooks" });

    expect(result.status).toBe(1);
    expect(result.output).toContain("core.hooksPath");
    expect(readCommandLog(fixture)).not.toContain("npm install");
  });

  it("stops after a failed setup step without running later mutations", () => {
    const fixture = createFixture();

    const result = runSetup(fixture, [], { FAKE_NPM_PLUGIN_INSTALL_FAIL: "1" });

    expect(result.status).toBe(1);
    expect(result.output).toContain("Setup stopped while attempting: Install plugin dependencies");
    const commands = readCommandLog(fixture);
    expect(commands).toContain("npm --prefix nemoclaw install --include=dev --ignore-scripts");
    expect(commands).not.toContain("uv sync");
  });

  it("stops immediately when the root dependency install fails", () => {
    const fixture = createFixture();

    const result = runSetup(fixture, [], { FAKE_NPM_ROOT_INSTALL_FAIL: "1" });

    expect(result.status).toBe(1);
    expect(result.output).toContain("Setup stopped while attempting: Install root dependencies");
    const commands = readCommandLog(fixture);
    expect(commands).toContain("npm install --include=dev --ignore-scripts");
    expect(commands).not.toContain("npm --prefix nemoclaw install");
  });

  it.each([
    ["default setup", []],
    ["repair", ["--repair"]],
    ["CLI exposure", ["--expose-cli"]],
    ["runtime onboarding", ["--with-runtime"]],
  ])("rejects the doctor repository override during %s", (_mode, args) => {
    const fixture = createFixture();

    const result = runSetup(fixture, args, {
      NEMOCLAW_DEV_DOCTOR_REPO_ROOT: fixture.repo,
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("NEMOCLAW_DEV_DOCTOR_REPO_ROOT");
    expect(readCommandLog(fixture)).not.toContain("npm install");
  });

  it("exposes the development CLI only when requested", () => {
    const fixture = createFixture();

    const result = runSetup(fixture, ["--expose-cli"]);

    expect(result.status).toBe(0);
    const commands = readCommandLog(fixture);
    expect(commands).toContain("npm-link-or-shim");
    expect(commands).not.toContain("onboard");
  });

  it("exposes the CLI and invokes trusted runtime onboarding only when requested", () => {
    const fixture = createFixture();

    const result = runSetup(fixture, ["--with-runtime"]);

    expect(result.status).toBe(0);
    expect(result.output).toContain("Starting optional runtime onboarding");
    const commands = readCommandLog(fixture);
    expect(commands).toContain("npm-link-or-shim");
    expect(commands).toContain(`node ${path.join(fixture.repo, "bin", "nemoclaw.js")} onboard`);
    expect(commands).not.toContain("nemoclaw onboard");
    expect(commands.indexOf("npm-link-or-shim")).toBeLessThan(
      commands.indexOf(`node ${path.join(fixture.repo, "bin", "nemoclaw.js")} onboard`),
    );
  });
});
