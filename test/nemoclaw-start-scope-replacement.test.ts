// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const START_SCRIPT = path.resolve(import.meta.dirname, "../scripts/nemoclaw-start.sh");

function runtimeShellEnvBlock(source: string): string {
  const start = source.indexOf("write_runtime_shell_env() {");
  const end = source.indexOf("# cleanup_on_signal", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

const ORIGINAL_REQUEST = {
  requestId: "request-1",
  deviceId: "device-1",
  publicKey: "public-key-1",
  clientId: "openclaw-cli",
  clientMode: "cli",
  role: "operator",
  roles: ["operator"],
  scopes: ["operator.write"],
};

const PAIRED_DEVICE = {
  deviceId: "device-1",
  publicKey: "public-key-1",
  clientId: "openclaw-cli",
  clientMode: "cli",
  role: "operator",
  roles: ["operator"],
  scopes: ["operator.pairing"],
  approvedScopes: ["operator.pairing"],
  tokens: { operator: { role: "operator", scopes: ["operator.pairing"] } },
};

function runReplacementCase(
  replacement: Record<string, unknown>,
  mentionedId = "request-2",
  options: {
    additionalPending?: Record<string, Record<string, unknown>>;
    coexistOriginal?: boolean;
    opaqueOutput?: string;
    persistedApprovedScopes?: boolean;
  } = {},
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-scope-replacement-"));
  const fakeBin = path.join(tmpDir, "bin");
  const proxyEnv = path.join(tmpDir, "proxy-env.sh");
  const stateDir = path.join(tmpDir, "openclaw-state");
  const devicesDir = path.join(stateDir, "devices");
  const pendingFile = path.join(devicesDir, "pending.json");
  const pairedFile = path.join(devicesDir, "paired.json");
  fs.mkdirSync(fakeBin);
  fs.mkdirSync(devicesDir, { recursive: true });
  fs.writeFileSync(pendingFile, JSON.stringify({ original: ORIGINAL_REQUEST }));
  const approvedScopes = ["operator.pairing", "operator.read", "operator.write"];
  const pairedDevice = options.persistedApprovedScopes
    ? {
        ...PAIRED_DEVICE,
        scopes: approvedScopes,
        approvedScopes,
        tokens: { operator: { role: "operator", scopes: approvedScopes } },
      }
    : PAIRED_DEVICE;
  fs.writeFileSync(pairedFile, JSON.stringify({ "device-1": pairedDevice }));
  const pairedBefore = fs.readFileSync(pairedFile, "utf8");
  const replacementState = {
    ...(options.coexistOriginal ? { original: ORIGINAL_REQUEST } : {}),
    replacement,
    ...options.additionalPending,
  };
  const approvalFailureOutput =
    options.opaqueOutput ??
    `gateway connect failed: GatewayClientRequestError: scope upgrade pending approval (requestId: ${mentionedId})`;
  const requestIdErrorLine =
    options.opaqueOutput === undefined ? 'echo "unknown requestId" >&2' : ":";
  fs.writeFileSync(
    path.join(fakeBin, "openclaw"),
    `#!/usr/bin/env bash
cat > "\${OPENCLAW_STATE_DIR}/devices/pending.json" <<'JSON'
${JSON.stringify(replacementState)}
JSON
printf '%s\n' ${JSON.stringify(approvalFailureOutput)} >&2
${requestIdErrorLine}
exit 1
`,
    { mode: 0o755 },
  );

  const source = fs.readFileSync(START_SCRIPT, "utf8");
  const runtimeBlock = `${runtimeShellEnvBlock(source)}\nwrite_runtime_shell_env`.replaceAll(
    "/tmp/nemoclaw-proxy-env.sh",
    proxyEnv,
  );
  const writer = path.join(tmpDir, "write-env.sh");
  fs.writeFileSync(
    writer,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'emit_sandbox_sourced_file() { local target="$1"; cat > "$target"; chmod 444 "$target"; }',
      'PROXY_HOST="10.200.0.1"',
      'PROXY_PORT="3128"',
      '_PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"',
      '_NO_PROXY_VAL="localhost,127.0.0.1,::1,${PROXY_HOST}"',
      '_SANDBOX_SAFETY_NET="/tmp/safety-net.js"',
      '_PROXY_FIX_SCRIPT="/tmp/http-proxy-fix.js"',
      '_NEMOTRON_FIX_SCRIPT="/tmp/nemotron-fix.js"',
      '_SECCOMP_GUARD_SCRIPT="/tmp/seccomp-guard.js"',
      '_CIAO_GUARD_SCRIPT="/tmp/ciao-guard.js"',
      "emit_messaging_connect_runtime_preload_exports() { :; }",
      'export OPENCLAW_GATEWAY_URL="ws://127.0.0.1:18789"',
      'export OPENCLAW_GATEWAY_PORT="18789"',
      'export OPENCLAW_GATEWAY_TOKEN="test-gateway-token"',
      "_TOOL_REDIRECTS=()",
      "set +u",
      runtimeBlock,
    ].join("\n"),
    { mode: 0o700 },
  );
  const write = spawnSync("bash", [writer], { encoding: "utf8", timeout: 5_000 });
  expect(write.status, write.stderr).toBe(0);

  const result = spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `source ${JSON.stringify(proxyEnv)}; export OPENCLAW_STATE_DIR=${JSON.stringify(stateDir)}; openclaw devices approve request-1 --json`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      timeout: 5_000,
    },
  );
  return { tmpDir, result, pendingFile, pairedFile, pairedBefore };
}

describe("nemoclaw-start scope replacement recovery (#4462)", () => {
  it("recovers the exact output-mentioned non-admin replacement without chasing request ids", () => {
    const replacement = {
      ...ORIGINAL_REQUEST,
      requestId: "request-2",
      scopes: ["operator.pairing", "operator.read", "operator.write"],
    };
    const run = runReplacementCase(replacement);
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(JSON.parse(run.result.stdout).compatibility).toBe(
        "openclaw-approve-recovered-same-scope-replacement",
      );
      expect(JSON.parse(fs.readFileSync(run.pendingFile, "utf8"))).toEqual({});
      const paired = JSON.parse(fs.readFileSync(run.pairedFile, "utf8"));
      expect(paired["device-1"].approvedScopes).toEqual([
        "operator.pairing",
        "operator.read",
        "operator.write",
      ]);
      expect(JSON.stringify(paired)).not.toContain("operator.admin");
    } finally {
      fs.rmSync(run.tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["client identity", { clientId: undefined }],
    ["client mode", { clientMode: undefined }],
  ])("rejects a non-admin replacement missing %s", (_case, missingField) => {
    const replacement = {
      ...ORIGINAL_REQUEST,
      requestId: "request-2",
      scopes: ["operator.pairing", "operator.read", "operator.write"],
      ...missingField,
    };
    const run = runReplacementCase(replacement);
    try {
      expect(run.result.status).toBe(1);
      expect(JSON.parse(fs.readFileSync(run.pendingFile, "utf8"))).toEqual({ replacement });
      expect(fs.readFileSync(run.pairedFile, "utf8")).toBe(run.pairedBefore);
    } finally {
      fs.rmSync(run.tmpDir, { recursive: true, force: true });
    }
  });

  it("recovers the sole OpenClaw admin repair without granting admin", () => {
    const replacement = {
      requestId: "request-2",
      deviceId: "device-1",
      publicKey: "public-key-1",
      role: "operator",
      roles: ["operator"],
      scopes: ["operator.admin"],
      isRepair: true,
    };
    const run = runReplacementCase(replacement);
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(JSON.parse(run.result.stdout).compatibility).toBe(
        "openclaw-approve-recovered-replacement",
      );
      expect(JSON.parse(fs.readFileSync(run.pendingFile, "utf8"))).toEqual({});
      const paired = JSON.parse(fs.readFileSync(run.pairedFile, "utf8"));
      expect(paired["device-1"].approvedScopes).toEqual([
        "operator.pairing",
        "operator.read",
        "operator.write",
      ]);
      expect(JSON.stringify(paired)).not.toContain("operator.admin");
    } finally {
      fs.rmSync(run.tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects an admin fallback without the OpenClaw repair marker", () => {
    const replacement = {
      requestId: "request-2",
      deviceId: "device-1",
      publicKey: "public-key-1",
      role: "operator",
      roles: ["operator"],
      scopes: ["operator.admin"],
      isRepair: false,
    };
    const run = runReplacementCase(replacement);
    try {
      expect(run.result.status).toBe(1);
      expect(JSON.parse(fs.readFileSync(run.pendingFile, "utf8"))).toEqual({ replacement });
      expect(fs.readFileSync(run.pairedFile, "utf8")).toBe(run.pairedBefore);
    } finally {
      fs.rmSync(run.tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects a marked admin repair after unrelated opaque output", () => {
    const replacement = {
      requestId: "request-2",
      deviceId: "device-1",
      publicKey: "public-key-1",
      role: "operator",
      roles: ["operator"],
      scopes: ["operator.admin"],
      isRepair: true,
    };
    const run = runReplacementCase(replacement, "", { opaqueOutput: "authorization denied" });
    try {
      expect(run.result.status).toBe(1);
      expect(JSON.parse(fs.readFileSync(run.pendingFile, "utf8"))).toEqual({ replacement });
      expect(fs.readFileSync(run.pairedFile, "utf8")).toBe(run.pairedBefore);
    } finally {
      fs.rmSync(run.tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves an unrelated entry whose map key equals the original request ID", () => {
    const replacement = {
      ...ORIGINAL_REQUEST,
      requestId: "request-2",
      scopes: ["operator.pairing", "operator.read", "operator.write"],
    };
    const unrelated = { requestId: "other-request", deviceId: "other-device" };
    const run = runReplacementCase(replacement, "request-2", {
      additionalPending: { "request-1": unrelated },
    });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(run.pendingFile, "utf8"))).toEqual({
        "request-1": unrelated,
      });
    } finally {
      fs.rmSync(run.tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing client identity", { ...ORIGINAL_REQUEST, clientId: undefined }],
    ["admin repair scopes", { ...ORIGINAL_REQUEST, scopes: ["operator.admin"], isRepair: true }],
  ])("rejects a still-pending original with %s", (_case, currentOriginal) => {
    const run = runReplacementCase(currentOriginal, "request-2");
    try {
      expect(run.result.status).toBe(1);
      expect(JSON.parse(fs.readFileSync(run.pendingFile, "utf8"))).toEqual({
        replacement: currentOriginal,
      });
      expect(fs.readFileSync(run.pairedFile, "utf8")).toBe(run.pairedBefore);
    } finally {
      fs.rmSync(run.tmpDir, { recursive: true, force: true });
    }
  });

  it("removes the exact replacement after OpenClaw already persisted the approved scopes", () => {
    const replacement = {
      ...ORIGINAL_REQUEST,
      requestId: "request-2",
      scopes: ["operator.pairing", "operator.read", "operator.write"],
    };
    const run = runReplacementCase(replacement, "request-2", {
      persistedApprovedScopes: true,
    });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(JSON.parse(run.result.stdout).compatibility).toBe(
        "openclaw-approve-recovered-same-scope-replacement",
      );
      expect(JSON.parse(fs.readFileSync(run.pendingFile, "utf8"))).toEqual({});
      expect(JSON.stringify(JSON.parse(fs.readFileSync(run.pairedFile, "utf8")))).not.toContain(
        "operator.admin",
      );
    } finally {
      fs.rmSync(run.tmpDir, { recursive: true, force: true });
    }
  });

  it("does not accept an unmentioned replacement after approved scopes persisted", () => {
    const replacement = {
      ...ORIGINAL_REQUEST,
      requestId: "request-2",
      scopes: ["operator.pairing", "operator.read", "operator.write"],
    };
    const run = runReplacementCase(replacement, "request-9", {
      persistedApprovedScopes: true,
    });
    try {
      expect(run.result.status).toBe(1);
      expect(JSON.parse(fs.readFileSync(run.pendingFile, "utf8"))).toEqual({ replacement });
      expect(fs.readFileSync(run.pairedFile, "utf8")).toBe(run.pairedBefore);
    } finally {
      fs.rmSync(run.tmpDir, { recursive: true, force: true });
    }
  });

  it("does not accept a divergent mentioned replacement after approved scopes persisted", () => {
    const replacement = {
      ...ORIGINAL_REQUEST,
      requestId: "request-2",
      scopes: ["operator.pairing"],
    };
    const run = runReplacementCase(replacement, "request-2", {
      persistedApprovedScopes: true,
    });
    try {
      expect(run.result.status).toBe(1);
      expect(JSON.parse(fs.readFileSync(run.pendingFile, "utf8"))).toEqual({ replacement });
      expect(fs.readFileSync(run.pairedFile, "utf8")).toBe(run.pairedBefore);
    } finally {
      fs.rmSync(run.tmpDir, { recursive: true, force: true });
    }
  });

  it("does not accept a mentioned admin residual beside an exact persisted replacement", () => {
    const replacement = {
      ...ORIGINAL_REQUEST,
      requestId: "request-2",
      scopes: ["operator.pairing", "operator.read", "operator.write"],
    };
    const admin = {
      ...ORIGINAL_REQUEST,
      requestId: "request-admin",
      scopes: ["operator.pairing", "operator.read", "operator.write", "operator.admin"],
    };
    const run = runReplacementCase(replacement, "request-admin", {
      additionalPending: { admin },
      persistedApprovedScopes: true,
    });
    try {
      expect(run.result.status).toBe(1);
      expect(JSON.parse(fs.readFileSync(run.pendingFile, "utf8"))).toEqual({
        replacement,
        admin,
      });
      expect(fs.readFileSync(run.pairedFile, "utf8")).toBe(run.pairedBefore);
    } finally {
      fs.rmSync(run.tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects divergent replacement scope views without mutating paired state", () => {
    const replacement = {
      ...ORIGINAL_REQUEST,
      requestId: "request-2",
      scopes: ["operator.pairing", "operator.read", "operator.write"],
      requestedScopes: ["operator.pairing"],
    };
    const run = runReplacementCase(replacement);
    try {
      expect(run.result.status).toBe(1);
      expect(JSON.parse(fs.readFileSync(run.pendingFile, "utf8"))).toEqual({ replacement });
      expect(fs.readFileSync(run.pairedFile, "utf8")).toBe(run.pairedBefore);
    } finally {
      fs.rmSync(run.tmpDir, { recursive: true, force: true });
    }
  });

  it("recovers one exact replacement while the original request remains pending", () => {
    const replacement = {
      ...ORIGINAL_REQUEST,
      requestId: "request-2",
      scopes: ["operator.pairing", "operator.read", "operator.write"],
    };
    const run = runReplacementCase(replacement, "request-2", { coexistOriginal: true });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(JSON.parse(run.result.stdout).compatibility).toBe(
        "openclaw-approve-recovered-coexisting-same-scope-replacement",
      );
      expect(JSON.parse(fs.readFileSync(run.pendingFile, "utf8"))).toEqual({});
      expect(fs.readFileSync(run.pairedFile, "utf8")).not.toContain("operator.admin");
    } finally {
      fs.rmSync(run.tmpDir, { recursive: true, force: true });
    }
  });
});
