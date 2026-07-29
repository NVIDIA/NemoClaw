// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const INSTALLER = path.join(import.meta.dirname, "..", "scripts", "install-openshell.sh");
const REQUIRED_VERSION = "0.0.85";
const FEATURES = [
  "request-body-credential-rewrite",
  "websocket-credential-rewrite",
  "allow_all_known_mcp_methods",
].join(" ");

function executable(file: string, body: string): void {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function runOpenShellInstaller(options: {
  driver: "auto" | "podman";
  hostArch?: "arm64" | "x86_64";
  hostOs?: "Darwin" | "Linux";
  installedVersion?: string;
  missingSandboxOverride?: boolean;
  sandbox?: boolean;
}): { downloads: string; dockerCalls: string; output: string; status: number | null } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-components-"));
  const bin = path.join(tmp, "bin");
  const downloads = path.join(tmp, "downloads.log");
  const dockerCalls = path.join(tmp, "docker.log");
  fs.mkdirSync(bin);
  const version = options.installedVersion ?? REQUIRED_VERSION;

  executable(
    path.join(bin, "uname"),
    `#!/usr/bin/env bash
if [ "\${1:-}" = "-m" ]; then
  echo ${options.hostArch ?? "x86_64"}
else
  echo ${options.hostOs ?? "Linux"}
fi
`,
  );
  executable(
    path.join(bin, "openshell"),
    `#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "openshell ${version}"; exit 0; fi
# ${FEATURES}
exit 0
`,
  );
  executable(
    path.join(bin, "openshell-gateway"),
    `#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "openshell-gateway ${version}"; exit 0; fi
# ${FEATURES}
exit 0
`,
  );
  if (options.sandbox) {
    executable(
      path.join(bin, "openshell-sandbox"),
      `#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "openshell-sandbox ${version}"; exit 0; fi
# ${FEATURES}
exit 0
`,
    );
  }
  executable(
    path.join(bin, "docker"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(dockerCalls)}\nexit 97\n`,
  );
  executable(path.join(bin, "gh"), "#!/usr/bin/env bash\nexit 1\n");
  executable(
    path.join(bin, "curl"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(downloads)}
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then shift; output="$1"; fi
  shift || true
done
[ -n "$output" ] && : >"$output"
exit 0
`,
  );

  const result = spawnSync("bash", [INSTALLER], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: tmp,
      NEMOCLAW_COMPUTE_DRIVER: options.driver,
      NEMOCLAW_OPENSHELL_CHANNEL: "stable",
      NEMOCLAW_OPENSHELL_SANDBOX_BIN: options.missingSandboxOverride
        ? path.join(tmp, "missing-openshell-sandbox")
        : "",
      PATH: `${bin}:/usr/bin:/bin`,
    },
  });
  const outcome = {
    downloads: fs.existsSync(downloads) ? fs.readFileSync(downloads, "utf8") : "",
    dockerCalls: fs.existsSync(dockerCalls) ? fs.readFileSync(dockerCalls, "utf8") : "",
    output: `${result.stdout}${result.stderr}`,
    status: result.status,
  };
  fs.rmSync(tmp, { recursive: true, force: true });
  return outcome;
}

describe("install-openshell.sh Podman component contract", () => {
  it("reuses a coherent CLI and gateway without requiring a Docker sandbox binary", () => {
    const result = runOpenShellInstaller({ driver: "podman" });

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(`openshell already installed: ${REQUIRED_VERSION}`);
    expect(result.output).not.toContain("missing Docker-driver binaries");
    expect(result.downloads).toBe("");
    expect(result.dockerCalls).toBe("");
  });

  it("ignores an explicit sandbox override only for Podman", () => {
    const result = runOpenShellInstaller({
      driver: "podman",
      missingSandboxOverride: true,
    });

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(`openshell already installed: ${REQUIRED_VERSION}`);
    expect(result.output).not.toContain("explicit OpenShell sandbox binary");
  });

  it("keeps validating an explicit sandbox override for macOS auto/Docker", () => {
    const result = runOpenShellInstaller({
      driver: "auto",
      hostArch: "arm64",
      hostOs: "Darwin",
      missingSandboxOverride: true,
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain("explicit OpenShell sandbox binary");
    expect(result.output).toContain("missing, unreadable, or not executable");
  });

  it("keeps the default Docker install dependent on its sandbox helper", () => {
    const result = runOpenShellInstaller({ driver: "auto" });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("missing Docker-driver binaries");
    expect(result.output).toContain(`Installing OpenShell from release 'v${REQUIRED_VERSION}'`);
    expect(result.dockerCalls).toBe("");
  });

  it("downloads only CLI and gateway artifacts for a fresh Podman install", () => {
    const result = runOpenShellInstaller({
      driver: "podman",
      installedVersion: "0.0.1",
    });

    expect(result.status).not.toBe(0);
    expect(result.downloads).toContain("openshell-x86_64-unknown-linux-musl.tar.gz");
    expect(result.downloads).toContain("openshell-gateway-x86_64-unknown-linux-gnu.tar.gz");
    expect(result.downloads).not.toContain("openshell-sandbox-");
    expect(result.downloads).not.toContain("openshell-sandbox-checksums-sha256.txt");
    expect(result.dockerCalls).toBe("");
  });

  it("continues to request the sandbox artifact for a fresh default Docker install", () => {
    const result = runOpenShellInstaller({
      driver: "auto",
      installedVersion: "0.0.1",
    });

    expect(result.status).not.toBe(0);
    expect(result.downloads).toContain("openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz");
    expect(result.downloads).toContain("openshell-sandbox-checksums-sha256.txt");
    expect(result.dockerCalls).toBe("");
  });
});
