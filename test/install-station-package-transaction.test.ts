// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_SYSTEM_PATH } from "./helpers/installer-sourced-env";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const STATION_PREPARE = path.join(REPO_ROOT, "scripts", "prepare-dgx-station-host.sh");
const EXPECTED_PACKAGE_SPECS = [
  "dkms=1:3.4.0-1ubuntu1",
  "nvidia-driver-pinning-610=610-2ubuntu1",
  "nvidia-driver-open=610.43.02-1ubuntu1",
  "containerd.io=2.2.6-1~ubuntu.24.04~noble",
  "docker-buildx-plugin=0.35.0-1~ubuntu.24.04~noble",
  "docker-ce=5:29.6.1-1~ubuntu.24.04~noble",
  "docker-ce-cli=5:29.6.1-1~ubuntu.24.04~noble",
  "libnvidia-container-tools=1.19.1-1",
  "libnvidia-container1=1.19.1-1",
  "nvidia-container-toolkit=1.19.1-1",
  "nvidia-container-toolkit-base=1.19.1-1",
];
const DOCKER_CE_SPEC = "docker-ce=5:29.6.1-1~ubuntu.24.04~noble";
const DKMS_SPEC = "dkms=1:3.4.0-1ubuntu1";

function runSourced(
  body: string,
  extraEnv: NodeJS.ProcessEnv = {},
  scriptUnderTest = STATION_PREPARE,
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-package-transaction-"));
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-c", `source "$SCRIPT_UNDER_TEST" >/dev/null\n${body}`],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        HOME: home,
        PATH: TEST_SYSTEM_PATH,
        SCRIPT_UNDER_TEST: scriptUnderTest,
        ...extraEnv,
      },
      timeout: 15_000,
      killSignal: "SIGKILL",
    },
  );
  return { result, output: `${result.stdout}${result.stderr}` };
}

function validateSimulation(plan: string, specs = [DOCKER_CE_SPEC]) {
  return runSourced(
    `
installed_version() { :; }
validate_apt_simulation "$APT_PLAN" ${specs.map((spec) => `'${spec}'`).join(" ")}
`,
    { APT_PLAN: plan },
  );
}

function aptProtocol(...actions: string[]) {
  return ["VERSION 3", "APT::Architecture=arm64", "", ...actions].join("\n");
}

function validatePreinstallPlan(targets: string, plan: string) {
  return runSourced(
    `
printf '%s' "$APT_TARGETS" >"$HOME/targets"
validate_apt_preinstall_plan "$HOME/targets" <<<"$APT_PLAN"
`,
    { APT_PLAN: plan, APT_TARGETS: targets },
  );
}

describe("DGX Station package transaction", () => {
  it("warns and retains the qualified DKMS forward revision for its package tuple (#7211)", () => {
    const { result, output } = runSourced(
      `
installed_version() {
  if [[ "$1" == "dkms" ]]; then printf '%s' "$DKMS_ACTUAL"; fi
}
installed_package_record() {
  if [[ "$1" == "dkms" ]]; then printf 'ii |all|%s' "$DKMS_ACTUAL"; else return 1; fi
}
printf 'state='
package_state 'dkms=1:3.4.0-1ubuntu1'
package_is_ready 'dkms=1:3.4.0-1ubuntu1'
warn_retained_package_version 'dkms=1:3.4.0-1ubuntu1'
`,
      { DKMS_ACTUAL: "1:3.4.1-1ubuntu1" },
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("state=retained-compatible");
    expect(output).toContain(
      "package=dkms status=retained_compatible actual=1:3.4.1-1ubuntu1 validated=1:3.4.0-1ubuntu1 decision=retain",
    );
  });

  it("rejects an unlisted DKMS revision (#7211)", () => {
    const { result, output } = runSourced(
      `
installed_version() {
  if [[ "$1" == "dkms" ]]; then printf '%s' "$DKMS_ACTUAL"; fi
}
installed_package_record() {
  if [[ "$1" == "dkms" ]]; then printf 'ii |all|%s' "$DKMS_ACTUAL"; else return 1; fi
}
printf 'state='
package_state 'dkms=1:3.4.0-1ubuntu1'
if package_is_ready 'dkms=1:3.4.0-1ubuntu1'; then
  printf 'ready=yes\n'
else
  printf 'ready=no\n'
fi
`,
      { DKMS_ACTUAL: "1:3.4.2-1ubuntu1" },
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("state=mismatch");
    expect(output).toContain("ready=no");
  });

  it("rejects retained DKMS after a companion package pin changes (#7211)", () => {
    const source = fs.readFileSync(STATION_PREPARE, "utf-8");
    const qualifiedTuple = `readonly -a RETAINED_DKMS_QUALIFIED_PACKAGE_SPECS=(\n${EXPECTED_PACKAGE_SPECS.map((spec) => `  "${spec}"`).join("\n")}\n)`;
    const staleQualifiedTuple = qualifiedTuple.replace(
      DOCKER_CE_SPEC,
      "docker-ce=5:29.6.0-1~ubuntu.24.04~noble",
    );
    const stalePolicySource = source.replace(qualifiedTuple, staleQualifiedTuple);
    expect(stalePolicySource).not.toBe(source);

    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-stale-policy-"));
    const stalePolicyScript = path.join(fixtureDir, "prepare-dgx-station-host.sh");
    fs.writeFileSync(stalePolicyScript, stalePolicySource);
    try {
      const { result, output } = runSourced(
        `
installed_version() {
  if [[ "$1" == "dkms" ]]; then printf '%s' "$DKMS_ACTUAL"; fi
}
installed_package_record() {
  if [[ "$1" == "dkms" ]]; then printf 'ii |all|%s' "$DKMS_ACTUAL"; else return 1; fi
}
printf 'state='
package_state 'dkms=1:3.4.0-1ubuntu1'
if package_is_ready 'dkms=1:3.4.0-1ubuntu1'; then
  printf 'ready=yes\n'
else
  printf 'ready=no\n'
fi
`,
        { DKMS_ACTUAL: "1:3.4.1-1ubuntu1" },
        stalePolicyScript,
      );

      expect(result.status, output).toBe(0);
      expect(output).toContain("state=mismatch");
      expect(output).toContain("ready=no");
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("retains qualified DKMS without entering package installation (#7211)", () => {
    const { result, output } = runSourced(`
common_preflight() { :; }
require_command() { :; }
acquire_sudo() { :; }
package_state() {
  if [[ "$1" == dkms=* ]]; then printf 'retained-compatible\n'; else printf 'exact\n'; fi
}
installed_version() {
  if [[ "$1" == "dkms" ]]; then printf '1:3.4.1-1ubuntu1'; fi
}
install_boot_marker_matches_current_boot() { return 1; }
driver_loaded_exact() { return 0; }
install_packages() { printf 'INSTALL_PACKAGES\n'; }
finish_runtime() { printf 'FINISH_RUNTIME\n'; }
verify_apply_state() { printf 'VERIFY_APPLY_STATE\n'; }
run_apply
`);

    expect(result.status, output).toBe(0);
    expect(output).toContain("status=retained_compatible");
    expect(output).toContain("decision=retain");
    expect(output).not.toContain("INSTALL_PACKAGES");
    expect(output).toContain("APPLY_RESULT=COMPLETE");
  });

  it("passes the complete pinned tuple when every package is missing", () => {
    const { result, output } = runSourced(`
configure_repositories() { printf 'CONFIGURE_REPOSITORIES\n'; }
apt-cache() { printf 'APT_CACHE %s\n' "$*" >>"$HOME/apt-cache-calls"; }
apt-get() {
  printf 'APT_GET %s\n' "$*"
  if [[ "$1" == "-s" ]]; then
    local spec name version
    for spec in "$@"; do
      [[ "$spec" == [a-z0-9]*=* ]] || continue
      name="\${spec%%=*}"
      version="\${spec#*=}"
      printf 'Inst %s (%s fixture [arm64])\n' "$name" "$version"
      printf 'Conf %s (%s fixture [arm64])\n' "$name" "$version"
    done
  fi
}
require_docker_restart_quiescence() { printf 'RECHECK_DOCKER_RESTART %s\n' "$1"; }
package_state() { printf 'missing\n'; }
package_is_ready() { return 0; }
package_is_exact() { return 0; }
assert_package_transaction_ready() { printf 'PACKAGE_TRANSACTION_READY %s\n' "$1"; }
check_dpkg_database_health() { printf 'DPKG_AUDIT_CLEAN\n'; }
create_apt_transaction_guard() {
  APT_TRANSACTION_GUARD_DIR=/run/nemoclaw-apt-transaction.TEST
  APT_TRANSACTION_HOOK="/bin/bash $APT_TRANSACTION_GUARD_DIR/verify-plan"
}
cleanup_apt_transaction_guard() {
  printf 'CLEANUP_GUARD\n'
  APT_TRANSACTION_GUARD_DIR=""
  APT_TRANSACTION_HOOK=""
}
sudo() {
  printf 'SUDO %s\n' "$*"
  if [[ "$1" == "env" && "$*" == *" apt-get -s install "* ]]; then
    while [[ "$1" != "apt-get" ]]; do shift; done
    "$@"
  fi
}
install_packages
cat "$HOME/apt-cache-calls"
`);

    expect(result.status, output).toBe(0);
    const expectedTuple = EXPECTED_PACKAGE_SPECS.join(" ");
    const aptCommands = output
      .split("\n")
      .filter((line) =>
        /^(APT_CACHE show |APT_GET -s install |SUDO env .* apt-get install )/.test(line),
      )
      .sort();
    expect(aptCommands).toEqual(
      [
        ...EXPECTED_PACKAGE_SPECS.map((spec) => `APT_CACHE show ${spec}`),
        `APT_GET -s install --no-install-recommends --no-remove -o DPkg::Pre-Install-Pkgs::=/bin/bash /run/nemoclaw-apt-transaction.TEST/verify-plan -o DPkg::Tools::options::/bin/bash::Version=3 ${expectedTuple}`,
        `SUDO env DEBIAN_FRONTEND=noninteractive LC_ALL=C apt-get install -y --no-install-recommends --no-remove -o DPkg::Pre-Install-Pkgs::=/bin/bash /run/nemoclaw-apt-transaction.TEST/verify-plan -o DPkg::Tools::options::/bin/bash::Version=3 ${expectedTuple}`,
      ].sort(),
    );
    expect(output).toContain(
      "SUDO env DEBIAN_FRONTEND=noninteractive LC_ALL=C apt-get -s install --no-install-recommends --no-remove",
    );
    const quiescenceMarker = "RECHECK_DOCKER_RESTART Station prerequisite package installation";
    const installMarker = "SUDO env DEBIAN_FRONTEND=noninteractive LC_ALL=C apt-get install -y";
    expect(output).toContain(quiescenceMarker);
    expect(output.indexOf(installMarker)).toBeGreaterThan(output.indexOf(quiescenceMarker));
    expect(output).toContain("CLEANUP_GUARD");
    expect(output).toContain("prerequisite_packages=ready");
  });

  it.each([
    {
      label: "exact",
      retainedSpec: "docker-ce=5:29.6.1-1~ubuntu.24.04~noble",
      retainedState: "exact",
    },
    {
      label: "qualified",
      retainedSpec: DKMS_SPEC,
      retainedState: "retained-compatible",
    },
  ])("excludes $label retained packages from every APT transaction command (#7211)", ({
    retainedSpec,
    retainedState,
  }) => {
    const missingSpecs = EXPECTED_PACKAGE_SPECS.filter((spec) => spec !== retainedSpec);
    const { result, output } = runSourced(`
configure_repositories() { :; }
apt-cache() { printf 'APT_CACHE %s\n' "$*" >>"$HOME/apt-cache-calls"; }
apt-get() {
  printf 'APT_GET %s\n' "$*"
  if [[ "$1" == "-s" ]]; then
    local spec name version
    for spec in "$@"; do
      [[ "$spec" == [a-z0-9]*=* ]] || continue
      name="\${spec%%=*}"
      version="\${spec#*=}"
      printf 'Inst %s (%s fixture [arm64])\n' "$name" "$version"
      printf 'Conf %s (%s fixture [arm64])\n' "$name" "$version"
    done
  fi
}
require_docker_restart_quiescence() { :; }
package_state() {
  if [[ "$1" == '${retainedSpec}' ]]; then printf '${retainedState}\n'; else printf 'missing\n'; fi
}
package_is_ready() { return 0; }
package_is_exact() { return 0; }
assert_package_transaction_ready() { :; }
check_dpkg_database_health() { :; }
create_apt_transaction_guard() {
  APT_TRANSACTION_GUARD_DIR=/run/nemoclaw-apt-transaction.TEST
  APT_TRANSACTION_HOOK="/bin/bash $APT_TRANSACTION_GUARD_DIR/verify-plan"
}
cleanup_apt_transaction_guard() {
  APT_TRANSACTION_GUARD_DIR=""
  APT_TRANSACTION_HOOK=""
}
sudo() {
  printf 'SUDO %s\n' "$*"
  if [[ "$1" == "env" && "$*" == *" apt-get -s install "* ]]; then
    while [[ "$1" != "apt-get" ]]; do shift; done
    "$@"
  fi
}
install_packages
cat "$HOME/apt-cache-calls"
`);

    expect(result.status, output).toBe(0);
    const expectedTuple = missingSpecs.join(" ");
    const aptCommands = output
      .split("\n")
      .filter((line) =>
        /^(APT_CACHE show |APT_GET -s install |SUDO env .* apt-get install )/.test(line),
      )
      .sort();
    expect(aptCommands).toEqual(
      [
        ...missingSpecs.map((spec) => `APT_CACHE show ${spec}`),
        `APT_GET -s install --no-install-recommends --no-remove -o DPkg::Pre-Install-Pkgs::=/bin/bash /run/nemoclaw-apt-transaction.TEST/verify-plan -o DPkg::Tools::options::/bin/bash::Version=3 ${expectedTuple}`,
        `SUDO env DEBIAN_FRONTEND=noninteractive LC_ALL=C apt-get install -y --no-install-recommends --no-remove -o DPkg::Pre-Install-Pkgs::=/bin/bash /run/nemoclaw-apt-transaction.TEST/verify-plan -o DPkg::Tools::options::/bin/bash::Version=3 ${expectedTuple}`,
      ].sort(),
    );
    expect(aptCommands.join("\n")).not.toContain(retainedSpec);
  });

  it("rejects a simulated change to a retained dependency", () => {
    const { result, output } = runSourced(`
configure_repositories() { :; }
apt-cache() { :; }
apt-get() {
  if [[ "$1" == "-s" ]]; then
    printf '%s\n' \
      'Inst docker-ce (5:29.6.1-1~ubuntu.24.04~noble fixture [arm64])' \
      'Inst libc6 [2.39-0ubuntu8] (2.39-0ubuntu9 fixture [arm64])'
  fi
}
package_state() {
  if [[ "$1" == docker-ce=* ]]; then printf 'missing\n'; else printf 'exact\n'; fi
}
installed_version() { if [[ "$1" == "libc6" ]]; then printf '2.39-0ubuntu8'; fi; }
package_is_ready() { return 0; }
package_is_exact() { return 0; }
assert_package_transaction_ready() { :; }
check_dpkg_database_health() { :; }
create_apt_transaction_guard() {
  APT_TRANSACTION_GUARD_DIR=/run/nemoclaw-apt-transaction.TEST
  APT_TRANSACTION_HOOK="/bin/bash $APT_TRANSACTION_GUARD_DIR/verify-plan"
}
sudo() {
  printf 'SUDO %s\n' "$*"
  if [[ "$1" == "env" && "$*" == *" apt-get -s install "* ]]; then
    while [[ "$1" != "apt-get" ]]; do shift; done
    "$@"
  fi
}
install_packages
`);

    expect(result.status, output).not.toBe(0);
    expect(output).toContain(
      "APT simulation proposed changing retained package libc6=2.39-0ubuntu8",
    );
    expect(output).not.toContain("apt-get install -y");
  });

  it("rejects unsafe simulation actions before the privileged install", () => {
    const expected = "5:29.6.1-1~ubuntu.24.04~noble";
    const scenarios = [
      {
        plan: `Inst docker-ce (${expected} fixture [arm64])\nRemv libc6 [2.39-0ubuntu8]`,
        message: "APT simulation proposed a package removal",
      },
      {
        plan: "Inst docker-ce (5:29.5.0-1~ubuntu.24.04~noble fixture [arm64])",
        message: "APT simulation selected docker-ce=5:29.5.0-1~ubuntu.24.04~noble",
      },
      {
        plan: "Inst pigz (2.8-1 fixture [arm64])",
        message: `APT simulation did not include required package ${DOCKER_CE_SPEC}`,
      },
      {
        plan: `Inst docker-ce (${expected} fixture [arm64])\nConf libc6 (2.39-0ubuntu8 fixture [arm64])`,
        message: "APT simulation proposed configuration without an approved install",
      },
    ];

    for (const scenario of scenarios) {
      const { result, output } = validateSimulation(scenario.plan);
      expect(result.status, `${scenario.plan}\n${output}`).not.toBe(0);
      expect(output).toContain(scenario.message);
    }
  });

  it("allows the approved DKMS transition and genuinely new dependencies in simulation", () => {
    const transition = validateSimulation(
      [
        "Inst dkms [3.0.11-1ubuntu13] (1:3.4.0-1ubuntu1 fixture [all])",
        "Conf dkms (1:3.4.0-1ubuntu1 fixture [all])",
      ].join("\n"),
      [DKMS_SPEC],
    );
    expect(transition.result.status, transition.output).toBe(0);

    const dependency = validateSimulation(
      [
        "Inst docker-ce (5:29.6.1-1~ubuntu.24.04~noble fixture [arm64])",
        "Inst pigz (2.8-1 fixture [arm64])",
        "Conf docker-ce (5:29.6.1-1~ubuntu.24.04~noble fixture [arm64])",
        "Conf pigz (2.8-1 fixture [arm64])",
      ].join("\n"),
    );
    expect(dependency.result.status, dependency.output).toBe(0);
  });

  it("accepts only missing packages, new dependencies, and the approved transition in the actual plan", () => {
    const missingWithDependency = validatePreinstallPlan(
      "docker-ce|5:29.6.1-1~ubuntu.24.04~noble||arm64\n",
      aptProtocol(
        "docker-ce - - none < 5:29.6.1-1~ubuntu.24.04~noble arm64 no /var/cache/apt/archives/docker-ce.deb",
        "pigz - - none < 2.8-1 arm64 no /var/cache/apt/archives/pigz.deb",
        "docker-ce - - none < 5:29.6.1-1~ubuntu.24.04~noble arm64 no **CONFIGURE**",
        "pigz - - none < 2.8-1 arm64 no **CONFIGURE**",
      ),
    );
    expect(missingWithDependency.result.status, missingWithDependency.output).toBe(0);

    const transition = validatePreinstallPlan(
      "dkms|1:3.4.0-1ubuntu1|3.0.11-1ubuntu13|arm64\n",
      aptProtocol(
        "dkms 3.0.11-1ubuntu13 all foreign < 1:3.4.0-1ubuntu1 all foreign /var/cache/apt/archives/dkms.deb",
        "dkms 3.0.11-1ubuntu13 all foreign < 1:3.4.0-1ubuntu1 all foreign **CONFIGURE**",
      ),
    );
    expect(transition.result.status, transition.output).toBe(0);
  });

  it("rejects unsafe VERSION 3 actions in the actual pre-install plan", () => {
    const targets = "docker-ce|5:29.6.1-1~ubuntu.24.04~noble||arm64\n";
    const targetAction =
      "docker-ce - - none < 5:29.6.1-1~ubuntu.24.04~noble arm64 no /var/cache/apt/archives/docker-ce.deb";
    const scenarios = [
      {
        plan: aptProtocol(targetAction).replace("VERSION 3", "VERSION 2"),
        message: "APT pre-install protocol must be VERSION 3",
      },
      {
        plan: aptProtocol(
          targetAction,
          "libc6 2.39-0ubuntu8 arm64 same < 2.39-0ubuntu9 arm64 same /var/cache/apt/archives/libc6.deb",
        ),
        message: "APT proposed changing retained package libc6=2.39-0ubuntu8",
      },
      {
        plan: aptProtocol(targetAction, "obsolete 1.0 arm64 no > - - none **REMOVE**"),
        message: "APT proposed removing obsolete",
      },
      {
        plan: aptProtocol(
          "docker-ce - - none < 5:29.5.0-1~ubuntu.24.04~noble arm64 no /var/cache/apt/archives/docker-ce.deb",
        ),
        message: "APT selected docker-ce=5:29.5.0-1~ubuntu.24.04~noble",
      },
      {
        plan: aptProtocol("pigz - - none < 2.8-1 arm64 no /var/cache/apt/archives/pigz.deb"),
        message: "APT omitted required target docker-ce=5:29.6.1-1~ubuntu.24.04~noble",
      },
      {
        plan: aptProtocol(
          targetAction,
          "libc6 2.39-0ubuntu8 arm64 same = 2.39-0ubuntu8 arm64 same **CONFIGURE**",
        ),
        message: "APT proposed configuring retained package libc6@arm64 without an archive action",
      },
      {
        plan: aptProtocol(
          "docker-ce - - none < 5:29.6.1-1~ubuntu.24.04~noble amd64 no /var/cache/apt/archives/docker-ce.deb",
        ),
        message: "APT selected foreign architecture amd64 for docker-ce; expected arm64 or all",
      },
    ];

    for (const scenario of scenarios) {
      const { result, output } = validatePreinstallPlan(targets, scenario.plan);
      expect(result.status, `${scenario.plan}\n${output}`).not.toBe(0);
      expect(output).toContain(scenario.message);
    }
  });

  it("emits a noexec-safe root-hook command bound to its target manifest", () => {
    const { result, output } = runSourced(
      `
PACKAGE_TRANSACTION_SPECS=('${DOCKER_CE_SPEC}')
package_state() { printf 'missing\n'; }
assert_root_directory_safe() { :; }
assert_root_regular_file_safe() { :; }
sudo() {
  case "$1" in
    dpkg)
      printf 'arm64\n'
      ;;
    mktemp)
      mkdir -p "$HOME/generated-guard"
      printf '/run/nemoclaw-apt-transaction.GENERATED\n'
      ;;
    tee)
      cat >"$HOME/generated-guard/\${2##*/}"
      ;;
    chmod)
      printf 'SUDO %s\n' "$*"
      if [[ "$3" == /run/nemoclaw-apt-transaction.GENERATED ]]; then
        command chmod "$2" "$HOME/generated-guard"
      else
        command chmod "$2" "$HOME/generated-guard/\${3##*/}"
      fi
      ;;
  esac
}
create_apt_transaction_guard
/bin/bash "$HOME/generated-guard/verify-plan" <<<"$APT_PLAN"
printf 'APT_HOOK=%s\n' "$APT_TRANSACTION_HOOK"
printf 'GENERATED_HOOK_ACCEPTED\n'
`,
      {
        APT_PLAN: aptProtocol(
          "docker-ce - - none < 5:29.6.1-1~ubuntu.24.04~noble arm64 no /var/cache/apt/archives/docker-ce.deb",
          "pigz - - none < 2.8-1 arm64 no /var/cache/apt/archives/pigz.deb",
        ),
      },
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("GENERATED_HOOK_ACCEPTED");
    expect(output).toContain(
      "APT_HOOK=/bin/bash /run/nemoclaw-apt-transaction.GENERATED/verify-plan",
    );
    expect(output).toContain("SUDO chmod 0700 /run/nemoclaw-apt-transaction.GENERATED/verify-plan");
    expect(output).toContain("SUDO chmod 0600 /run/nemoclaw-apt-transaction.GENERATED/targets");
  });

  it("cleans the root-owned transaction guard when the caller exits", () => {
    const { result, output } = runSourced(`
sudo() { printf 'SUDO %s\n' "$*"; }
setup_log() { :; }
run_apply() {
  APT_TRANSACTION_GUARD_DIR=/run/nemoclaw-apt-transaction.EXITTEST
  APT_TRANSACTION_HOOK="/bin/bash $APT_TRANSACTION_GUARD_DIR/verify-plan"
}
main --apply
`);

    expect(result.status, output).toBe(0);
    expect(output).toContain("SUDO rm -rf -- /run/nemoclaw-apt-transaction.EXITTEST");
  });
});
