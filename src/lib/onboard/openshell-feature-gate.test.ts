// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  hasRequiredOpenshellMessagingFeatures,
  pinnedOpenShellSandboxBuildVersion,
  REQUIRED_OPENSHELL_MCP_FEATURES,
  REQUIRED_OPENSHELL_SANDBOX_MCP_FEATURE,
  resolveOpenShellComponentBuildVersion,
} from "./openshell-feature-gate";

function writeExecutable(target: string, contents: string, version = "0.0.72") {
  fs.writeFileSync(
    target,
    `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then echo "${path.basename(target)} ${version}"; exit 0; fi
# ${contents}
exit 0
`,
    { mode: 0o755 },
  );
}

describe("OpenShell MCP feature gate", () => {
  it("identifies the pinned v0.0.72 sandbox artifacts without executing them", () => {
    const sandbox = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-features-")),
      "openshell-sandbox",
    );
    try {
      writeExecutable(sandbox, "non-host-runnable sandbox");
      fs.writeFileSync(
        sandbox,
        `#!/bin/sh\nexit 127\n# ${REQUIRED_OPENSHELL_SANDBOX_MCP_FEATURE}\n`,
        { mode: 0o755 },
      );
      const digest = "f9f991a24d10772ad5d24ae27a8ea6baad8cac671695bd90fcd0355e0e0ad198";
      const arm64Digest = "32ca44fe7d9e6d332f2a753c6b8a1a6117b7388281dad9b5274d23ffc67e216f";

      expect(pinnedOpenShellSandboxBuildVersion(digest)).toBe("0.0.72");
      expect(pinnedOpenShellSandboxBuildVersion(arm64Digest)).toBe("0.0.72");
      expect(pinnedOpenShellSandboxBuildVersion("0".repeat(64))).toBeNull();
      expect(resolveOpenShellComponentBuildVersion(sandbox, "sandbox", () => digest)).toBe(
        "0.0.72",
      );
      expect(resolveOpenShellComponentBuildVersion(sandbox, "gateway", () => digest)).toBeNull();
      expect(
        resolveOpenShellComponentBuildVersion(sandbox, "sandbox", () => "0".repeat(64)),
      ).toBeNull();
    } finally {
      fs.rmSync(path.dirname(sandbox), { recursive: true, force: true });
    }
  });

  it("identifies the pinned v0.0.82 sandbox artifacts without executing them", () => {
    const sandbox = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-features-")),
      "openshell-sandbox",
    );
    try {
      fs.writeFileSync(
        sandbox,
        `#!/bin/sh\nexit 127\n# ${REQUIRED_OPENSHELL_SANDBOX_MCP_FEATURE}\n`,
        { mode: 0o755 },
      );
      const digest = "145246049bd73c60452ac3c2b4b1801663196c8e2f80575af820289c78c1cf09";
      const arm64Digest = "76bc19b70d9f1e1e9871307045796cd39cc7b8fc4c08ffc90593cc934f36d500";

      expect(pinnedOpenShellSandboxBuildVersion(digest)).toBe("0.0.82");
      expect(pinnedOpenShellSandboxBuildVersion(arm64Digest)).toBe("0.0.82");
      expect(resolveOpenShellComponentBuildVersion(sandbox, "sandbox", () => digest)).toBe(
        "0.0.82",
      );
    } finally {
      fs.rmSync(path.dirname(sandbox), { recursive: true, force: true });
    }
  });

  it("identifies the pinned v0.0.85 sandbox artifacts without executing them", () => {
    const sandbox = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-features-")),
      "openshell-sandbox",
    );
    try {
      fs.writeFileSync(
        sandbox,
        `#!/bin/sh\nexit 127\n# ${REQUIRED_OPENSHELL_SANDBOX_MCP_FEATURE}\n`,
        { mode: 0o755 },
      );
      const digest = "863ef21ab7ef623f5e7a8728c4e5532b46bfbae3ace3b800665a1c6353a1f7d2";
      const arm64Digest = "680115dbc2affde0e88261ab09f4044726d1cc9e01de55dc5077d1118f52968d";

      expect(pinnedOpenShellSandboxBuildVersion(digest)).toBe("0.0.85");
      expect(pinnedOpenShellSandboxBuildVersion(arm64Digest)).toBe("0.0.85");
      expect(resolveOpenShellComponentBuildVersion(sandbox, "sandbox", () => digest)).toBe(
        "0.0.85",
      );
    } finally {
      fs.rmSync(path.dirname(sandbox), { recursive: true, force: true });
    }
  });

  it("finds provider rewrite and MCP L7 markers across OpenShell binaries", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-features-"));
    try {
      const openshell = path.join(dir, "openshell");
      const gateway = path.join(dir, "openshell-gateway");
      const sandbox = path.join(dir, "openshell-sandbox");
      writeExecutable(openshell, `binary ${REQUIRED_OPENSHELL_MCP_FEATURES[0]}`);
      writeExecutable(gateway, `binary ${REQUIRED_OPENSHELL_MCP_FEATURES[1]}`);
      writeExecutable(
        sandbox,
        `binary ${REQUIRED_OPENSHELL_MCP_FEATURES.slice(2).join(" ")} ${REQUIRED_OPENSHELL_SANDBOX_MCP_FEATURE}`,
      );

      expect(
        hasRequiredOpenshellMessagingFeatures({
          openshellBin: openshell,
          gatewayBin: null,
          sandboxBin: null,
        }),
      ).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects mixed install roots unless the component paths are explicit overrides", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-features-"));
    try {
      const cliDir = path.join(root, "cli");
      const runtimeDir = path.join(root, "runtime");
      fs.mkdirSync(cliDir);
      fs.mkdirSync(runtimeDir);
      const openshell = path.join(cliDir, "openshell");
      const gateway = path.join(runtimeDir, "openshell-gateway");
      const sandbox = path.join(runtimeDir, "openshell-sandbox");
      writeExecutable(openshell, `binary ${REQUIRED_OPENSHELL_MCP_FEATURES.join(" ")}`);
      writeExecutable(gateway, "selected external gateway");
      writeExecutable(sandbox, `binary ${REQUIRED_OPENSHELL_SANDBOX_MCP_FEATURE}`);

      const selected = { openshellBin: openshell, gatewayBin: gateway, sandboxBin: sandbox };
      expect(hasRequiredOpenshellMessagingFeatures(selected)).toBe(false);
      expect(
        hasRequiredOpenshellMessagingFeatures({
          ...selected,
          gatewayBin: path.join(runtimeDir, "missing-gateway"),
          allowExternalGatewayBin: true,
          allowExternalSandboxBin: true,
        }),
      ).toBe(false);
      expect(
        hasRequiredOpenshellMessagingFeatures({
          ...selected,
          allowExternalGatewayBin: true,
          allowExternalSandboxBin: true,
        }),
      ).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("compares canonical roots so a symlink farm cannot combine releases", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-features-"));
    try {
      const linksDir = path.join(root, "links");
      const cliDir = path.join(root, "cli");
      const runtimeDir = path.join(root, "runtime");
      fs.mkdirSync(linksDir);
      fs.mkdirSync(cliDir);
      fs.mkdirSync(runtimeDir);
      const realOpenshell = path.join(cliDir, "openshell");
      const realGateway = path.join(runtimeDir, "openshell-gateway");
      const realSandbox = path.join(runtimeDir, "openshell-sandbox");
      writeExecutable(realOpenshell, `binary ${REQUIRED_OPENSHELL_MCP_FEATURES.join(" ")}`);
      writeExecutable(realGateway, "stale gateway");
      writeExecutable(realSandbox, `binary ${REQUIRED_OPENSHELL_SANDBOX_MCP_FEATURE}`);
      const openshell = path.join(linksDir, "openshell");
      fs.symlinkSync(realOpenshell, openshell);
      fs.symlinkSync(realGateway, path.join(linksDir, "openshell-gateway"));
      fs.symlinkSync(realSandbox, path.join(linksDir, "openshell-sandbox"));

      expect(
        hasRequiredOpenshellMessagingFeatures({
          openshellBin: openshell,
          gatewayBin: null,
          sandboxBin: null,
        }),
      ).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a selected component that is not executable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-features-"));
    try {
      const openshell = path.join(root, "openshell");
      const gateway = path.join(root, "openshell-gateway");
      writeExecutable(openshell, `binary ${REQUIRED_OPENSHELL_MCP_FEATURES.join(" ")}`);
      fs.writeFileSync(gateway, "non-executable gateway", { mode: 0o644 });

      expect(
        hasRequiredOpenshellMessagingFeatures({
          openshellBin: openshell,
          gatewayBin: gateway,
          sandboxBin: null,
        }),
      ).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a stale component copied into the active install root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-features-"));
    try {
      const openshell = path.join(root, "openshell");
      const gateway = path.join(root, "openshell-gateway");
      writeExecutable(openshell, `binary ${REQUIRED_OPENSHELL_MCP_FEATURES.join(" ")}`);
      writeExecutable(gateway, "stale gateway", "0.0.71");

      expect(
        hasRequiredOpenshellMessagingFeatures({
          openshellBin: openshell,
          gatewayBin: gateway,
          sandboxBin: null,
        }),
      ).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts equivalent dev build identities with different git-prefix lengths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-features-"));
    try {
      const openshell = path.join(root, "openshell");
      const gateway = path.join(root, "openshell-gateway");
      writeExecutable(
        openshell,
        `binary ${REQUIRED_OPENSHELL_MCP_FEATURES.join(" ")}`,
        "0.0.72-dev.8+g7bce1223d",
      );
      writeExecutable(gateway, "current gateway", "0.0.72-dev.8+g7bce1223");

      expect(
        hasRequiredOpenshellMessagingFeatures({
          openshellBin: openshell,
          gatewayBin: gateway,
          sandboxBin: null,
        }),
      ).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a selected sandbox runtime that cannot be read", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-features-"));
    try {
      const openshell = path.join(root, "openshell");
      const sandbox = path.join(root, "openshell-sandbox");
      writeExecutable(openshell, `binary ${REQUIRED_OPENSHELL_MCP_FEATURES.join(" ")}`);
      fs.writeFileSync(sandbox, `binary ${REQUIRED_OPENSHELL_SANDBOX_MCP_FEATURE}`, {
        mode: 0o111,
      });

      expect(
        hasRequiredOpenshellMessagingFeatures({
          openshellBin: openshell,
          gatewayBin: null,
          sandboxBin: sandbox,
        }),
      ).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when any required marker is absent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-features-"));
    try {
      const openshell = path.join(dir, "openshell");
      writeExecutable(openshell, `binary ${REQUIRED_OPENSHELL_MCP_FEATURES[0]}`);

      expect(
        hasRequiredOpenshellMessagingFeatures({
          openshellBin: openshell,
          gatewayBin: null,
          sandboxBin: null,
        }),
      ).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires native MCP policy support from the exact sandbox runtime binary", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-features-"));
    try {
      const openshell = path.join(dir, "openshell");
      const sandbox = path.join(dir, "openshell-sandbox");
      writeExecutable(
        openshell,
        `binary ${REQUIRED_OPENSHELL_MCP_FEATURES.join(" ")} ${REQUIRED_OPENSHELL_SANDBOX_MCP_FEATURE}`,
      );
      writeExecutable(sandbox, "binary without the transport boundary");

      expect(
        hasRequiredOpenshellMessagingFeatures({
          openshellBin: openshell,
          gatewayBin: null,
          sandboxBin: sandbox,
        }),
      ).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not let a capable sibling rescue an explicit stale sandbox runtime", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-features-"));
    try {
      const cliDir = path.join(root, "cli");
      const runtimeDir = path.join(root, "runtime");
      fs.mkdirSync(cliDir);
      fs.mkdirSync(runtimeDir);
      const openshell = path.join(cliDir, "openshell");
      const siblingSandbox = path.join(cliDir, "openshell-sandbox");
      const selectedSandbox = path.join(runtimeDir, "openshell-sandbox");
      writeExecutable(openshell, `binary ${REQUIRED_OPENSHELL_MCP_FEATURES.join(" ")}`);
      writeExecutable(siblingSandbox, `binary ${REQUIRED_OPENSHELL_SANDBOX_MCP_FEATURE}`);
      writeExecutable(selectedSandbox, "stale sandbox without the MCP policy marker");

      expect(
        hasRequiredOpenshellMessagingFeatures({
          openshellBin: openshell,
          gatewayBin: null,
          sandboxBin: selectedSandbox,
          allowExternalSandboxBin: true,
        }),
      ).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("defers a compressed VM supervisor check to the in-sandbox runtime probe", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-features-"));
    try {
      const openshell = path.join(dir, "openshell");
      const vmDriver = path.join(dir, "openshell-driver-vm");
      writeExecutable(openshell, `binary ${REQUIRED_OPENSHELL_MCP_FEATURES.join(" ")}`);
      writeExecutable(vmDriver, "compressed supervisor payload without inspectable markers");

      expect(
        hasRequiredOpenshellMessagingFeatures({
          openshellBin: openshell,
          gatewayBin: null,
          sandboxBin: null,
        }),
      ).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores stale sibling and fallback sandbox artifacts for a macOS VM-driver install", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-features-"));
    try {
      const cliDir = path.join(root, "cli");
      const fallbackDir = path.join(root, "fallback");
      fs.mkdirSync(cliDir);
      fs.mkdirSync(fallbackDir);
      const openshell = path.join(cliDir, "openshell");
      const gateway = path.join(cliDir, "openshell-gateway");
      const siblingSandbox = path.join(cliDir, "openshell-sandbox");
      const fallbackSandbox = path.join(fallbackDir, "openshell-sandbox");
      writeExecutable(openshell, `binary ${REQUIRED_OPENSHELL_MCP_FEATURES.join(" ")}`);
      writeExecutable(gateway, "current gateway");
      writeExecutable(siblingSandbox, "stale sibling sandbox", "0.0.44");
      writeExecutable(fallbackSandbox, "stale fallback sandbox", "0.0.44");

      for (const sandboxBin of [siblingSandbox, fallbackSandbox]) {
        expect(
          hasRequiredOpenshellMessagingFeatures({
            openshellBin: openshell,
            gatewayBin: gateway,
            sandboxBin,
            requireSandboxBin: false,
          }),
        ).toBe(true);
      }
      expect(
        hasRequiredOpenshellMessagingFeatures({
          openshellBin: openshell,
          gatewayBin: gateway,
          sandboxBin: siblingSandbox,
          requireSandboxBin: true,
        }),
      ).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
