// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const LAUNCHER_PATH = path.join(
  process.cwd(),
  "agents",
  "langchain-deepagents-code",
  "dcode-launcher.sh",
);
const TEST_OWNER_UID = process.getuid?.() ?? 0;

type RlimitHelperInstaller = (helperPath: string, markerPath: string) => void;

function installDefaultRlimitHelper(helperPath: string, markerPath: string): void {
  fs.writeFileSync(
    helperPath,
    [
      `harden_resource_limits() { printf '%s\\n' hardened > ${JSON.stringify(markerPath)}; }`,
      `verify_resource_limits_exact() { printf '%s\\n' verified >> ${JSON.stringify(markerPath)}; }`,
      "",
    ].join("\n"),
  );
}

function installFailingVerificationRlimitHelper(helperPath: string, markerPath: string): void {
  fs.writeFileSync(
    helperPath,
    [
      `harden_resource_limits() { printf '%s\\n' hardened > ${JSON.stringify(markerPath)}; }`,
      "verify_resource_limits() { :; }",
      "verify_resource_limits_exact() { printf '%s\\n' 'fixture exact verification failed' >&2; return 1; }",
      "",
    ].join("\n"),
  );
}

function makeLauncherFixture(
  tempDir: string,
  options: { installRlimitHelper?: RlimitHelperInstaller } = {},
): {
  launcherPath: string;
  markerPath: string;
  rlimitMarkerPath: string;
  wrapperMarkerPath: string;
} {
  const installRlimitHelper = options.installRlimitHelper ?? installDefaultRlimitHelper;
  const launcherPath = path.join(tempDir, "dcode-launcher.sh");
  const markerPath = path.join(tempDir, "observability-enabled");
  const hostPath = path.join(tempDir, "trusted-proxy-host");
  const portPath = path.join(tempDir, "trusted-proxy-port");
  const wrapperPath = path.join(tempDir, "dcode-wrapper.sh");
  const wrapperMarkerPath = path.join(tempDir, "wrapper-ran");
  const rlimitPath = path.join(tempDir, "sandbox-rlimits.sh");
  const rlimitMarkerPath = path.join(tempDir, "rlimits-hardened");
  const source = fs
    .readFileSync(LAUNCHER_PATH, "utf8")
    .replace("/usr/local/lib/nemoclaw/sandbox-rlimits.sh", rlimitPath)
    .replace(
      'readonly MANAGED_DCODE_WRAPPER="/usr/local/lib/nemoclaw/dcode-wrapper.sh"',
      `readonly MANAGED_DCODE_WRAPPER="${wrapperPath}"`,
    )
    .replace(
      'readonly MANAGED_EXEC_LAUNCHER="/usr/local/lib/nemoclaw/dcode-managed-exec"',
      `readonly MANAGED_EXEC_LAUNCHER="${launcherPath}"`,
    )
    .replace(
      'readonly MANAGED_OBSERVABILITY_MARKER="/sandbox/.deepagents/.nemoclaw-observability-enabled"',
      `readonly MANAGED_OBSERVABILITY_MARKER="${markerPath}"`,
    )
    .replace(
      'readonly MANAGED_PROXY_HOST_FILE="/usr/local/share/nemoclaw/dcode-proxy-host"',
      `readonly MANAGED_PROXY_HOST_FILE="${hostPath}"`,
    )
    .replace(
      'readonly MANAGED_PROXY_PORT_FILE="/usr/local/share/nemoclaw/dcode-proxy-port"',
      `readonly MANAGED_PROXY_PORT_FILE="${portPath}"`,
    )
    .replace(
      "readonly MANAGED_PROXY_OWNER_UID=0",
      `readonly MANAGED_PROXY_OWNER_UID=${TEST_OWNER_UID}`,
    );

  fs.writeFileSync(hostPath, "managed-proxy.internal\n", { mode: 0o444 });
  fs.writeFileSync(portPath, "3128\n", { mode: 0o444 });
  installRlimitHelper(rlimitPath, rlimitMarkerPath);
  fs.writeFileSync(
    wrapperPath,
    `#!/bin/sh\nprintf ran > ${JSON.stringify(wrapperMarkerPath)}\nexit 99\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(launcherPath, source, { mode: 0o755 });
  return { launcherPath, markerPath, rlimitMarkerPath, wrapperMarkerPath };
}

describe("Deep Agents Code side-effect-free managed exec", () => {
  it("preserves enabled observability during route diagnostics (#6504)", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-managed-exec-"));
    try {
      const { launcherPath, markerPath, rlimitMarkerPath, wrapperMarkerPath } =
        makeLauncherFixture(tempDir);
      fs.writeFileSync(markerPath, "1\n", { mode: 0o444 });

      const result = spawnSync(
        launcherPath,
        [
          "/bin/sh",
          "-c",
          'printf "OBS=%s PROXY=%s" "${NEMOCLAW_OBSERVABILITY-__unset__}" "$HTTPS_PROXY"',
        ],
        {
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
          encoding: "utf8",
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("OBS=1 PROXY=http://managed-proxy.internal:3128");
      expect(fs.existsSync(wrapperMarkerPath)).toBe(false);
      expect(fs.readFileSync(rlimitMarkerPath, "utf8")).toBe("hardened\nverified\n");
      expect(fs.readFileSync(markerPath, "utf8")).toBe("1\n");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves disabled observability during route diagnostics (#6504)", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-managed-exec-"));
    try {
      const { launcherPath, markerPath, rlimitMarkerPath, wrapperMarkerPath } =
        makeLauncherFixture(tempDir);

      const result = spawnSync(
        launcherPath,
        [
          "/bin/sh",
          "-c",
          'printf "OBS=%s PROXY=%s" "${NEMOCLAW_OBSERVABILITY-__unset__}" "$HTTPS_PROXY"',
        ],
        {
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            NEMOCLAW_OBSERVABILITY: "1",
          },
          encoding: "utf8",
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("OBS=__unset__ PROXY=http://managed-proxy.internal:3128");
      expect(fs.existsSync(wrapperMarkerPath)).toBe(false);
      expect(fs.readFileSync(rlimitMarkerPath, "utf8")).toBe("hardened\nverified\n");
      expect(fs.existsSync(markerPath)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed without a managed command and preserves the marker (#6504)", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-managed-exec-"));
    try {
      const { launcherPath, markerPath, rlimitMarkerPath, wrapperMarkerPath } =
        makeLauncherFixture(tempDir);
      fs.writeFileSync(markerPath, "1\n", { mode: 0o444 });

      const result = spawnSync(launcherPath, [], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        encoding: "utf8",
      });

      expect(result.status).toBe(64);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("dcode-managed-exec requires a command.\n");
      expect(fs.readFileSync(markerPath, "utf8")).toBe("1\n");
      expect(fs.readFileSync(rlimitMarkerPath, "utf8")).toBe("hardened\nverified\n");
      expect(fs.existsSync(wrapperMarkerPath)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("refuses a direct managed launch when the rlimit helper is missing (#6545)", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-managed-exec-"));
    try {
      const { launcherPath, rlimitMarkerPath, wrapperMarkerPath } = makeLauncherFixture(tempDir, {
        installRlimitHelper: () => undefined,
      });

      const result = spawnSync(launcherPath, ["/bin/sh", "-c", "printf SHOULD_NOT_RUN"], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        encoding: "utf8",
      });

      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("SHOULD_NOT_RUN");
      expect(result.stderr).toContain(
        "[SECURITY] Required sandbox-rlimits.sh is missing; refusing to launch dcode unhardened.",
      );
      expect(fs.existsSync(rlimitMarkerPath)).toBe(false);
      expect(fs.existsSync(wrapperMarkerPath)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("refuses a direct managed launch when effective rlimits fail verification (#6545)", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-managed-exec-"));
    try {
      const { launcherPath, rlimitMarkerPath, wrapperMarkerPath } = makeLauncherFixture(tempDir, {
        installRlimitHelper: installFailingVerificationRlimitHelper,
      });

      const result = spawnSync(launcherPath, ["/bin/sh", "-c", "printf SHOULD_NOT_RUN"], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        encoding: "utf8",
      });

      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("SHOULD_NOT_RUN");
      expect(result.stderr).toContain("fixture exact verification failed");
      expect(result.stderr).toContain(
        "[SECURITY] Effective sandbox resource limits do not match policy; refusing to launch dcode unhardened.",
      );
      expect(fs.readFileSync(rlimitMarkerPath, "utf8")).toBe("hardened\n");
      expect(fs.existsSync(wrapperMarkerPath)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
