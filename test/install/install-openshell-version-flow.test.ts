// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const INSTALLER_PAYLOAD = path.join(import.meta.dirname, "../..", "scripts", "install.sh");
const execFileAsync = promisify(execFile);

async function runCommand(
  command: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
) {
  try {
    const { stderr, stdout } = await execFileAsync(command, args, options);
    return { status: 0, stderr, stdout };
  } catch (error) {
    const result = error as { code?: unknown; stderr?: string; stdout?: string };
    return {
      status: typeof result.code === "number" ? result.code : null,
      stderr: result.stderr ?? "",
      stdout: result.stdout ?? "",
    };
  }
}

function writeExecutable(target: string, contents: string): void {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

async function runInstallerOpenshellVersionFlow(
  setupOpenshell: (bin: string) => void,
  installedOpenshellBody = '#!/usr/bin/env bash\n[ "$1" = "--version" ] && echo "openshell 0.0.85"\nexit 0\n',
) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-version-flow-"));
  const home = path.join(tmp, "home");
  const bin = path.join(tmp, "bin");
  const setupDir = path.join(tmp, "setup");
  const registry = path.join(home, ".nemoclaw", "sandboxes.json");
  const gatewayState = path.join(tmp, "gateway.state");
  const backupLog = path.join(tmp, "backup.log");
  const installLog = path.join(tmp, "install.log");
  const healthyOpenshell = path.join(tmp, "healthy-openshell");

  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(setupDir, "lib"), { recursive: true });
  fs.writeFileSync(registry, '{"sandboxes":{"alpha":{"name":"alpha"}}}\n');
  fs.writeFileSync(gatewayState, "gateway-original\n");
  writeExecutable(path.join(setupDir, "setup-jetson.sh"), "#!/usr/bin/env bash\nexit 0\n");
  writeExecutable(
    path.join(setupDir, "lib", "station-vllm-conflict.sh"),
    `#!/usr/bin/env bash
handle_station_vllm_conflict() { :; }
consume_station_local_vllm_resume() { return 1; }
`,
  );
  writeExecutable(healthyOpenshell, installedOpenshellBody);
  setupOpenshell(bin);

  const result = await runCommand(
    "bash",
    [
      "-c",
      `source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1
SCRIPT_DIR="${setupDir}"
_CLI_PATH=""
_CLI_BIN="nemoclaw-test-missing"
resolve_nemoclaw_gateway_port() { printf '8080\\n'; }
preflight_explicit_express_flags() { :; }
print_banner() { :; }
preflight_usage_notice_prompt() { :; }
prepare_installer_host() { :; }
step() { :; }
install_nodejs() { :; }
ensure_supported_runtime() { :; }
fix_npm_permissions() { :; }
preinstall_backup_and_retire_legacy_gateway() {
  command_exists openshell || return 0
  printf 'backup\\n' >>"${backupLog}"
  [ -n "$(installed_openshell_version 2>/dev/null || true)" ] ||
    error "Could not determine the installed OpenShell version. The installer stopped after backup without retiring the gateway."
  printf 'gateway-retired\\n' >"${gatewayState}"
  printf '{"sandboxes":{}}\\n' >"${registry}"
}
install_nemoclaw() {
  printf 'install\\n' >>"${installLog}"
  if ! command_exists openshell; then
    cp "${healthyOpenshell}" "${bin}/openshell"
  fi
}
verify_nemoclaw() { :; }
print_done() { :; }
main --non-interactive --yes-i-accept-third-party-software`,
    ],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      },
    },
  );

  return {
    result,
    backupLog: fs.existsSync(backupLog) ? fs.readFileSync(backupLog, "utf-8") : "",
    gatewayState: fs.readFileSync(gatewayState, "utf-8"),
    registry: fs.readFileSync(registry, "utf-8"),
    installLog: fs.existsSync(installLog) ? fs.readFileSync(installLog, "utf-8") : "",
    openshellBody: fs.readFileSync(path.join(bin, "openshell"), "utf-8"),
  };
}

describe.concurrent("install.sh OpenShell version flow", () => {
  const brokenOpenshell = "#!/usr/bin/env bash\nexit 1\n";
  const healthyOpenshell =
    '#!/usr/bin/env bash\n[ "$1" = "--version" ] && echo "openshell 0.0.85"\nexit 0\n';
  const invalidVersionOpenshell =
    '#!/usr/bin/env bash\n[ "$1" = "--version" ] && echo "openshell unknown"\nexit 0\n';
  const versionPrintingBrokenOpenshell =
    '#!/usr/bin/env bash\n[ "$1" = "--version" ] && echo "openshell 0.0.85"\nexit 1\n';

  it("backs up before rejecting a broken OpenShell without gateway or sandbox mutation (#7300)", async () => {
    const { result, backupLog, gatewayState, registry, installLog } =
      await runInstallerOpenshellVersionFlow((bin) => {
        writeExecutable(path.join(bin, "openshell"), brokenOpenshell);
      });

    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("stopped after backup");
    expect(backupLog).toBe("backup\n");
    expect(gatewayState).toBe("gateway-original\n");
    expect(registry).toBe('{"sandboxes":{"alpha":{"name":"alpha"}}}\n');
    expect(installLog).toBe("");
  });

  it("backs up before rejecting a failed OpenShell version command without mutation (#7300)", async () => {
    const { result, backupLog, gatewayState, registry, installLog } =
      await runInstallerOpenshellVersionFlow((bin) => {
        writeExecutable(path.join(bin, "openshell"), versionPrintingBrokenOpenshell);
      });

    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("stopped after backup");
    expect(backupLog).toBe("backup\n");
    expect(gatewayState).toBe("gateway-original\n");
    expect(registry).toBe('{"sandboxes":{"alpha":{"name":"alpha"}}}\n');
    expect(installLog).toBe("");
  });

  it("backs up before rejecting invalid OpenShell version output without mutation (#7300)", async () => {
    const { result, backupLog, gatewayState, registry, installLog } =
      await runInstallerOpenshellVersionFlow((bin) => {
        writeExecutable(path.join(bin, "openshell"), invalidVersionOpenshell);
      });

    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("stopped after backup");
    expect(backupLog).toBe("backup\n");
    expect(gatewayState).toBe("gateway-original\n");
    expect(registry).toBe('{"sandboxes":{"alpha":{"name":"alpha"}}}\n');
    expect(installLog).toBe("");
  });

  it("preserves a reportable OpenShell through the installer flow (#7300)", async () => {
    const { result, openshellBody } = await runInstallerOpenshellVersionFlow((bin) => {
      writeExecutable(path.join(bin, "openshell"), healthyOpenshell);
    });

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(openshellBody).toBe(healthyOpenshell);
  });

  it("installs OpenShell when no binary is present (#7300)", async () => {
    const { result, installLog } = await runInstallerOpenshellVersionFlow(() => undefined);

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(installLog).toBe("install\n");
  });

  it("rejects an installed OpenShell whose version command fails before onboarding (#7300)", async () => {
    const { result, installLog, openshellBody } = await runInstallerOpenshellVersionFlow(
      () => undefined,
      versionPrintingBrokenOpenshell,
    );

    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("could not report its version");
    expect(installLog).toBe("install\n");
    expect(openshellBody).toBe(versionPrintingBrokenOpenshell);
  });
});
