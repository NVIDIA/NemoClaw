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

function makeLauncherFixture(tempDir: string): {
  launcherPath: string;
  markerPath: string;
  wrapperMarkerPath: string;
} {
  const launcherPath = path.join(tempDir, "dcode-launcher.sh");
  const markerPath = path.join(tempDir, "observability-enabled");
  const hostPath = path.join(tempDir, "trusted-proxy-host");
  const portPath = path.join(tempDir, "trusted-proxy-port");
  const wrapperPath = path.join(tempDir, "dcode-wrapper.sh");
  const wrapperMarkerPath = path.join(tempDir, "wrapper-ran");
  const source = fs
    .readFileSync(LAUNCHER_PATH, "utf8")
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
  fs.writeFileSync(
    wrapperPath,
    `#!/bin/sh\nprintf ran > ${JSON.stringify(wrapperMarkerPath)}\nexit 99\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(launcherPath, source, { mode: 0o755 });
  return { launcherPath, markerPath, wrapperMarkerPath };
}

describe("Deep Agents Code side-effect-free managed exec", () => {
  it("preserves enabled observability during route diagnostics (#6504)", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-managed-exec-"));
    try {
      const { launcherPath, markerPath, wrapperMarkerPath } = makeLauncherFixture(tempDir);
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
      expect(fs.readFileSync(markerPath, "utf8")).toBe("1\n");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves disabled observability during route diagnostics (#6504)", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-managed-exec-"));
    try {
      const { launcherPath, markerPath, wrapperMarkerPath } = makeLauncherFixture(tempDir);

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
      expect(fs.existsSync(markerPath)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed without a managed command and preserves the marker (#6504)", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-managed-exec-"));
    try {
      const { launcherPath, markerPath, wrapperMarkerPath } = makeLauncherFixture(tempDir);
      fs.writeFileSync(markerPath, "1\n", { mode: 0o444 });

      const result = spawnSync(launcherPath, [], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        encoding: "utf8",
      });

      expect(result.status).toBe(64);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("dcode-managed-exec requires a command.\n");
      expect(fs.readFileSync(markerPath, "utf8")).toBe("1\n");
      expect(fs.existsSync(wrapperMarkerPath)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
