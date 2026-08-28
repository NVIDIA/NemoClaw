// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

const REPOSITORY_ROOT = path.join(import.meta.dirname, "../..");
const INSTALLER = path.join(REPOSITORY_ROOT, "scripts", "install.sh");
const QUALIFICATION_RUNNER = path.join(
  REPOSITORY_ROOT,
  "scripts",
  "checks",
  "run-native-runtime-installer-qualification.sh",
);
const OTHER_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const ARCHITECTURE = os.arch() === "x64" ? "amd64" : "arm64";
const describeLinux = process.platform === "linux" ? describe : describe.skip;

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function dockerFreeEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of [
    "DOCKER_CERT_PATH",
    "DOCKER_CONFIG",
    "DOCKER_CONTEXT",
    "DOCKER_HOST",
    "DOCKER_TLS_VERIFY",
    "XDG_RUNTIME_DIR",
  ]) {
    delete environment[name];
  }
  return environment;
}

function writeExecutable(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, { mode: 0o755 });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function runGit(repository: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf-8",
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

type CandidateFixture = {
  root: string;
  installer: string;
  installerSha256: string;
  revision: string;
  sourceMarker: string;
};

function candidateFixture(
  options: {
    dockerState?: string;
    installPreviousRevision?: boolean;
    replaceDockerGuard?: boolean;
  } = {},
): CandidateFixture {
  const fixtureRoot = temporaryDirectory("nemoclaw-native-candidate-");
  const candidateRoot = path.join(fixtureRoot, "candidate");
  const scriptsDirectory = path.join(candidateRoot, "scripts");
  const installer = path.join(scriptsDirectory, "install.sh");
  const sourceMarker = path.join(fixtureRoot, "candidate-sourced");
  fs.mkdirSync(scriptsDirectory, { recursive: true });

  runGit(candidateRoot, ["init", "--quiet"]);
  runGit(candidateRoot, ["config", "user.name", "Qualification Test"]);
  runGit(candidateRoot, ["config", "user.email", "qualification@example.com"]);
  runGit(candidateRoot, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(candidateRoot, "README.md"), "candidate fixture\n");
  runGit(candidateRoot, ["add", "README.md"]);
  runGit(candidateRoot, ["commit", "--quiet", "-m", "test: add candidate fixture"]);

  const dockerMutation = options.dockerState
    ? `printf 'running\\n' >${shellQuote(options.dockerState)}`
    : ":";
  const installedRevision = options.installPreviousRevision
    ? 'git -C "$installed_checkout" checkout --quiet --detach HEAD^'
    : ":";
  const guardMutation = options.replaceDockerGuard
    ? `docker_guard_path="$(command -v docker)"
  chmod u+w "$docker_guard_path"
  printf '#!/usr/bin/env bash\\nexit 0\\n' >"$docker_guard_path"
  chmod 500 "$docker_guard_path"`
    : ":";
  writeExecutable(
    installer,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'sourced\\n' >${shellQuote(sourceMarker)}

install_nemoclaw_before_onboarding() {
  [[ -z "\${QUALIFICATION_TEST_CREDENTIAL:-}" ]] || exit 71
  ${dockerMutation}
  ${guardMutation}
  installed_checkout="\${HOME}/.nemoclaw/source"
  mkdir -p "$(dirname "$installed_checkout")"
  git clone --quiet ${shellQuote(candidateRoot)} "$installed_checkout"
  git -C "$installed_checkout" remote set-url origin https://github.com/NVIDIA/NemoClaw.git
  ${installedRevision}
}
`,
  );
  writeExecutable(path.join(scriptsDirectory, "setup-jetson.sh"), "#!/usr/bin/env bash\nexit 0\n");
  runGit(candidateRoot, ["add", "scripts/install.sh", "scripts/setup-jetson.sh"]);
  runGit(candidateRoot, ["commit", "--quiet", "-m", "test: add installer phase"]);
  runGit(candidateRoot, ["remote", "add", "origin", "https://github.com/NVIDIA/NemoClaw.git"]);

  const installerBytes = fs.readFileSync(installer);
  return {
    root: candidateRoot,
    installer,
    installerSha256: createHash("sha256").update(installerBytes).digest("hex"),
    revision: runGit(candidateRoot, ["rev-parse", "HEAD"]),
    sourceMarker,
  };
}

function runQualification(
  candidate: CandidateFixture,
  artifactDirectory: string,
  options: {
    candidateSha?: string;
    environment?: NodeJS.ProcessEnv;
    installerSha256?: string;
    publishRace?: boolean;
  } = {},
) {
  const toolDirectory = temporaryDirectory("nemoclaw-native-tools-");
  const socketProbe = path.join(toolDirectory, "docker.sock");
  writeExecutable(path.join(toolDirectory, "systemctl"), "#!/usr/bin/env bash\nexit 1\n");
  writeExecutable(path.join(toolDirectory, "pgrep"), "#!/usr/bin/env bash\nexit 1\n");
  const moveScript = options.publishRace
    ? '#!/usr/bin/env bash\nmkdir -p -- "${!#}"\ntouch -- "${!#}/.concurrent-writer"\nexec /usr/bin/mv "$@"\n'
    : '#!/usr/bin/env bash\nexec /usr/bin/mv "$@"\n';
  writeExecutable(path.join(toolDirectory, "mv"), moveScript);
  const qualificationArguments = [
    "--candidate-checkout",
    candidate.root,
    "--candidate-sha",
    options.candidateSha ?? candidate.revision,
    "--installer-sha256",
    options.installerSha256 ?? candidate.installerSha256,
    "--architecture",
    ARCHITECTURE,
    "--artifact-dir",
    artifactDirectory,
  ];
  const inheritedPath =
    options.environment?.PATH ?? `${toolDirectory}:${process.env.PATH ?? "/usr/bin:/bin"}`;
  return spawnSync(
    "bash",
    [
      "-c",
      `
set -euo pipefail
source "$QUALIFICATION_RUNNER"
docker_socket_paths() { printf '%s\\n' "$QUALIFICATION_SOCKET_PROBE"; }
run_native_runtime_installer_qualification "$@"
`,
      "_",
      ...qualificationArguments,
    ],
    {
      encoding: "utf-8",
      env: {
        ...dockerFreeEnvironment(),
        ...options.environment,
        PATH: inheritedPath,
        QUALIFICATION_RUNNER,
        QUALIFICATION_SOCKET_PROBE: socketProbe,
      },
    },
  );
}

function phaseHarness(body: string, environment: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", ["-c", body], {
    encoding: "utf-8",
    env: {
      ...dockerFreeEnvironment(),
      ...environment,
      INSTALLER_UNDER_TEST: INSTALLER,
    },
  });
}

describeLinux("native runtime installer qualification", () => {
  it("keeps the ordinary installer phase order", () => {
    const fixtureRoot = temporaryDirectory("nemoclaw-native-phase-");
    const setupDirectory = path.join(fixtureRoot, "payload");
    const callLog = path.join(fixtureRoot, "calls.log");
    fs.mkdirSync(setupDirectory);
    writeExecutable(
      path.join(setupDirectory, "setup-jetson.sh"),
      '#!/usr/bin/env bash\nprintf "setup-jetson\\n" >>"$CALL_LOG"\n',
    );

    const result = phaseHarness(
      `
set -euo pipefail
source "$INSTALLER_UNDER_TEST"
SCRIPT_DIR="$SETUP_DIRECTORY"
record() { printf '%s\n' "$1" >>"$CALL_LOG"; }
load_station_vllm_conflict_helpers() { :; }
consume_station_local_vllm_resume() { return 1; }
resolve_nemoclaw_gateway_port() { printf '8080'; }
preflight_explicit_express_flags() { :; }
print_banner() { :; }
preflight_usage_notice_prompt() { :; }
prepare_installer_host() { record prepare-installer-host; }
step() { record "step-$1-$2"; }
install_nodejs() { record install-nodejs; }
ensure_supported_runtime() { record ensure-supported-runtime; }
resolve_pending_express_wsl_provider() { record resolve-pending-express-wsl-provider; }
ensure_station_express_pair() { record ensure-station-express-pair; }
fix_npm_permissions() { record fix-npm-permissions; }
preinstall_backup_and_retire_legacy_gateway() { record preinstall-backup; }
install_nemoclaw() { record install-nemoclaw; }
verify_nemoclaw() { record verify-nemoclaw; }
require_reportable_openshell_version() { record require-reportable-openshell-version; }
command_exists() { return 1; }
finalize_install() { record finalize-install; }
clear_station_resume_after_completed_onboarding() { :; }
main --non-interactive --yes-i-accept-third-party-software
`,
      { CALL_LOG: callLog, SETUP_DIRECTORY: setupDirectory },
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(fs.readFileSync(callLog, "utf-8").trim().split("\n")).toEqual([
      "prepare-installer-host",
      "setup-jetson",
      "step-1-Node.js",
      "install-nodejs",
      "ensure-supported-runtime",
      "resolve-pending-express-wsl-provider",
      "ensure-station-express-pair",
      "step-2-NemoClaw CLI",
      "fix-npm-permissions",
      "preinstall-backup",
      "install-nemoclaw",
      "verify-nemoclaw",
      "require-reportable-openshell-version",
      "step-3-Onboarding",
      "finalize-install",
    ]);
  });

  it("rejects a candidate commit mismatch before it sources candidate code", () => {
    const candidate = candidateFixture();
    const artifactParent = temporaryDirectory("nemoclaw-native-artifacts-");
    const result = runQualification(candidate, path.join(artifactParent, "qualification"), {
      candidateSha: OTHER_SHA,
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "candidate checkout does not match the candidate commit",
    );
    expect(fs.existsSync(candidate.sourceMarker)).toBe(false);
  });

  it("rejects changed installer bytes before it sources candidate code", () => {
    const candidate = candidateFixture();
    const artifactParent = temporaryDirectory("nemoclaw-native-artifacts-");
    fs.appendFileSync(candidate.installer, "# changed after checkout\n");
    const changedDigest = createHash("sha256")
      .update(fs.readFileSync(candidate.installer))
      .digest("hex");
    const result = runQualification(candidate, path.join(artifactParent, "qualification"), {
      installerSha256: changedDigest,
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "candidate installer bytes do not match the candidate commit",
    );
    expect(fs.existsSync(candidate.sourceMarker)).toBe(false);
  });

  it("rejects an installer digest that differs from the trusted plan", () => {
    const candidate = candidateFixture();
    const artifactParent = temporaryDirectory("nemoclaw-native-artifacts-");
    const result = runQualification(candidate, path.join(artifactParent, "qualification"), {
      installerSha256: "a".repeat(64),
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "candidate installer SHA-256 does not match the trusted plan",
    );
    expect(fs.existsSync(candidate.sourceMarker)).toBe(false);
  });

  it("rejects a candidate checkout that stores a Git credential header", () => {
    const candidate = candidateFixture();
    const artifactParent = temporaryDirectory("nemoclaw-native-artifacts-");
    runGit(candidate.root, [
      "config",
      "http.https://github.com/.extraheader",
      "AUTHORIZATION: bearer test-value",
    ]);
    const result = runQualification(candidate, path.join(artifactParent, "qualification"));

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "candidate checkout must not store Git credentials",
    );
    expect(fs.existsSync(candidate.sourceMarker)).toBe(false);
  });

  it("rejects active Docker before it sources candidate code", () => {
    const candidate = candidateFixture();
    const fixtureRoot = temporaryDirectory("nemoclaw-native-docker-");
    const toolDirectory = path.join(fixtureRoot, "bin");
    const artifactParent = path.join(fixtureRoot, "artifacts");
    fs.mkdirSync(toolDirectory);
    fs.mkdirSync(artifactParent);
    writeExecutable(path.join(toolDirectory, "systemctl"), "#!/usr/bin/env bash\nexit 0\n");

    const result = runQualification(candidate, path.join(artifactParent, "qualification"), {
      environment: { PATH: `${toolDirectory}:${process.env.PATH ?? "/usr/bin:/bin"}` },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "docker.service is active during the pre-execution check",
    );
    expect(fs.existsSync(candidate.sourceMarker)).toBe(false);
  });

  it("rejects Docker that becomes active during candidate execution", () => {
    const fixtureRoot = temporaryDirectory("nemoclaw-native-docker-");
    const dockerState = path.join(fixtureRoot, "dockerd-running");
    const candidate = candidateFixture({ dockerState });
    const toolDirectory = path.join(fixtureRoot, "bin");
    const artifactParent = path.join(fixtureRoot, "artifacts");
    fs.mkdirSync(toolDirectory);
    fs.mkdirSync(artifactParent);
    writeExecutable(path.join(toolDirectory, "systemctl"), "#!/usr/bin/env bash\nexit 1\n");
    writeExecutable(
      path.join(toolDirectory, "pgrep"),
      `#!/usr/bin/env bash
[[ -e ${shellQuote(dockerState)} ]]
`,
    );

    const result = runQualification(candidate, path.join(artifactParent, "qualification"), {
      environment: { PATH: `${toolDirectory}:${process.env.PATH ?? "/usr/bin:/bin"}` },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "dockerd is running during the post-execution check",
    );
    expect(fs.existsSync(candidate.sourceMarker)).toBe(true);
  });

  it("rejects Docker command guard bytes changed by candidate code", () => {
    const candidate = candidateFixture({ replaceDockerGuard: true });
    const artifactParent = temporaryDirectory("nemoclaw-native-artifacts-");
    const result = runQualification(candidate, path.join(artifactParent, "qualification"));

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "Docker command guard bytes changed before the post-execution check",
    );
  });

  it("independently rejects an installed checkout at a different commit", () => {
    const candidate = candidateFixture({ installPreviousRevision: true });
    const artifactParent = temporaryDirectory("nemoclaw-native-artifacts-");
    const result = runQualification(candidate, path.join(artifactParent, "qualification"));

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "installed checkout does not match the candidate commit",
    );
  });

  it("writes bounded receipts after both Docker checks and installed-source verification", () => {
    const candidate = candidateFixture();
    const artifactParent = temporaryDirectory("nemoclaw-native-artifacts-");
    const artifactDirectory = path.join(artifactParent, "qualification");
    const credentialValue = "native-qualification-credential-value";
    const result = runQualification(candidate, artifactDirectory, {
      environment: { QUALIFICATION_TEST_CREDENTIAL: credentialValue },
    });

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const receiptNames = fs.readdirSync(artifactDirectory).sort();
    expect(receiptNames).toEqual([
      "architecture.json",
      "candidate-source.json",
      "docker-absence.json",
      "installed-source.json",
      "installer.sh",
      "invocation.json",
    ]);
    const receiptContents = receiptNames
      .map((name) => fs.readFileSync(path.join(artifactDirectory, name), "utf-8"))
      .join("\n");
    expect(receiptContents).not.toContain(credentialValue);
    expect(fs.statSync(path.join(artifactDirectory, "installer.sh")).size).toBeLessThanOrEqual(
      524288,
    );
    expect(receiptNames.filter((name) => name.endsWith(".json")).every((receiptName) => fs.statSync(path.join(artifactDirectory, receiptName)).size <= 4096)).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(artifactDirectory, "invocation.json"), "utf-8")),
    ).toMatchObject({
      candidateSha: candidate.revision,
      architecture: ARCHITECTURE,
      scriptSha256: candidate.installerSha256,
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(artifactDirectory, "installed-source.json"), "utf-8")),
    ).toMatchObject({
      requestedRevision: candidate.revision,
      installedRevision: candidate.revision,
      installMode: "managed",
      installerSha256: candidate.installerSha256,
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(artifactDirectory, "docker-absence.json"), "utf-8")),
    ).toEqual({
      receiptVersion: 1,
      preExecution: {
        dockerCommandGuarded: true,
        dockerEnvironmentVariablesUnset: true,
        dockerServiceInactive: true,
        dockerSocketUnitInactive: true,
        dockerdProcessNameAbsent: true,
        defaultSocketPathsAbsent: true,
      },
      postExecution: {
        dockerCommandGuarded: true,
        dockerEnvironmentVariablesUnset: true,
        dockerServiceInactive: true,
        dockerSocketUnitInactive: true,
        dockerdProcessNameAbsent: true,
        defaultSocketPathsAbsent: true,
      },
    });
  });

  it("fails closed when a populated receipt target appears during publication", () => {
    const candidate = candidateFixture();
    const artifactParent = temporaryDirectory("nemoclaw-native-artifacts-");
    const artifactDirectory = path.join(artifactParent, "qualification");

    const result = runQualification(candidate, artifactDirectory, { publishRace: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Could not publish the qualification receipts");
    expect(fs.readdirSync(artifactDirectory)).toEqual([".concurrent-writer"]);
  });
});
