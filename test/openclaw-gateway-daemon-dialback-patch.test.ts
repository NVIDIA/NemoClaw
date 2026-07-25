// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import {
  CALL_CONTEXT_MARKER,
  CONNECTION_DETAILS_MARKER,
  patchGatewayCallContextText,
  patchGatewayConnectionDetailsText,
  patchGatewayToolTargetText,
  patchOpenClawGatewayDaemonDialback,
  TOOL_TARGET_MARKER,
} from "../scripts/patch-openclaw-gateway-daemon-dialback.mts";

const PATCH_SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "patch-openclaw-gateway-daemon-dialback.mts",
);

const CALL_CONTEXT_SOURCE = [
  "function trimToUndefined(value) { return value?.trim() || undefined; }",
  "function resolveGatewayCallContext(opts) {",
  "\tconst cliUrlOverride = trimToUndefined(opts.url);",
  "\tconst envUrlOverride = cliUrlOverride || opts.localPortOverride !== void 0 ? void 0 : trimToUndefined(process.env.OPENCLAW_GATEWAY_URL);",
  "\treturn cliUrlOverride ?? envUrlOverride ?? 'ws://127.0.0.1:18789';",
  "}",
  "export { resolveGatewayCallContext };",
  "",
].join("\n");

const CONNECTION_DETAILS_SOURCE = [
  "function normalizeOptionalString(value) { return value?.trim() || undefined; }",
  "function buildGatewayConnectionDetails(options) {",
  "\tconst cliUrlOverride = normalizeOptionalString(options.url);",
  "\tconst envUrlOverride = cliUrlOverride || options.ignoreEnvUrlOverride || options.localPortOverride !== void 0 ? void 0 : normalizeOptionalString(process.env.OPENCLAW_GATEWAY_URL);",
  "\treturn cliUrlOverride ?? envUrlOverride ?? 'ws://127.0.0.1:18789';",
  "}",
  "export { buildGatewayConnectionDetails };",
  "",
].join("\n");

const TOOL_TARGET_SOURCE = [
  "function resolveDefaultGatewayTarget(params) {",
  '\tif (params.envGatewayUrl) return "remote";',
  '\tif (params.remoteUrl) return "remote";',
  '\treturn "local";',
  "}",
  "export { resolveDefaultGatewayTarget };",
  "",
].join("\n");

async function importFixture<T>(tmp: string, name: string, source: string): Promise<T> {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, source);
  return (await import(`${pathToFileURL(file).href}?case=${crypto.randomUUID()}`)) as T;
}

function withGatewayEnvironment<T>(
  values: { openshell?: string; title: string; url?: string },
  run: () => T,
): T {
  const previousTitle = process.title;
  const previousSandbox = process.env.OPENSHELL_SANDBOX;
  const previousUrl = process.env.OPENCLAW_GATEWAY_URL;
  try {
    process.title = values.title;
    if (values.openshell === undefined) delete process.env.OPENSHELL_SANDBOX;
    else process.env.OPENSHELL_SANDBOX = values.openshell;
    if (values.url === undefined) delete process.env.OPENCLAW_GATEWAY_URL;
    else process.env.OPENCLAW_GATEWAY_URL = values.url;
    return run();
  } finally {
    process.title = previousTitle;
    if (previousSandbox === undefined) delete process.env.OPENSHELL_SANDBOX;
    else process.env.OPENSHELL_SANDBOX = previousSandbox;
    if (previousUrl === undefined) delete process.env.OPENCLAW_GATEWAY_URL;
    else process.env.OPENCLAW_GATEWAY_URL = previousUrl;
  }
}

describe("OpenClaw gateway daemon dial-back patch", () => {
  it("uses loopback only for the OpenShell gateway daemon while descendants keep the private URL", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-dialback-runtime-"));
    try {
      const callRuntime = await importFixture<{
        resolveGatewayCallContext(opts: { localPortOverride?: number; url?: string }): string;
      }>(tmp, "call.mjs", patchGatewayCallContextText(CALL_CONTEXT_SOURCE).text);
      const detailsRuntime = await importFixture<{
        buildGatewayConnectionDetails(options: {
          ignoreEnvUrlOverride?: boolean;
          localPortOverride?: number;
          url?: string;
        }): string;
      }>(
        tmp,
        "connection-details.mjs",
        patchGatewayConnectionDetailsText(CONNECTION_DETAILS_SOURCE).text,
      );
      const targetRuntime = await importFixture<{
        resolveDefaultGatewayTarget(params: {
          envGatewayUrl?: string;
          remoteUrl?: string;
        }): "local" | "remote";
      }>(tmp, "gateway-tools.mjs", patchGatewayToolTargetText(TOOL_TARGET_SOURCE).text);
      const privateUrl = "ws://10.200.0.2:18789";

      withGatewayEnvironment(
        { openshell: "sandbox-name", title: "openclaw-gateway", url: privateUrl },
        () => {
          expect(callRuntime.resolveGatewayCallContext({})).toBe("ws://127.0.0.1:18789");
          expect(detailsRuntime.buildGatewayConnectionDetails({})).toBe("ws://127.0.0.1:18789");
          expect(targetRuntime.resolveDefaultGatewayTarget({ envGatewayUrl: privateUrl })).toBe(
            "local",
          );
        },
      );

      withGatewayEnvironment(
        { openshell: "sandbox-name", title: "openclaw", url: privateUrl },
        () => {
          expect(callRuntime.resolveGatewayCallContext({})).toBe(privateUrl);
          expect(detailsRuntime.buildGatewayConnectionDetails({})).toBe(privateUrl);
          expect(targetRuntime.resolveDefaultGatewayTarget({ envGatewayUrl: privateUrl })).toBe(
            "remote",
          );
        },
      );
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("preserves explicit URL and non-OpenShell behavior", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-dialback-explicit-"));
    try {
      const runtime = await importFixture<{
        resolveGatewayCallContext(opts: { url?: string }): string;
      }>(tmp, "call.mjs", patchGatewayCallContextText(CALL_CONTEXT_SOURCE).text);
      const privateUrl = "ws://10.200.0.2:18789";

      withGatewayEnvironment({ title: "openclaw-gateway", url: privateUrl }, () => {
        expect(runtime.resolveGatewayCallContext({})).toBe(privateUrl);
      });
      withGatewayEnvironment({ openshell: "1", title: "openclaw-gateway", url: privateUrl }, () => {
        expect(runtime.resolveGatewayCallContext({ url: "wss://gateway.example.test" })).toBe(
          "wss://gateway.example.test",
        );
      });
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("patches exactly one target for each resolver and is idempotent", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-dialback-dist-"));
    try {
      fs.writeFileSync(path.join(tmp, "call.js"), CALL_CONTEXT_SOURCE);
      fs.writeFileSync(path.join(tmp, "connection-details.js"), CONNECTION_DETAILS_SOURCE);
      fs.writeFileSync(path.join(tmp, "gateway-tools.js"), TOOL_TARGET_SOURCE);

      expect(patchOpenClawGatewayDaemonDialback(tmp).status).toBe("patched");
      expect(patchOpenClawGatewayDaemonDialback(tmp).status).toBe("already-patched");
      expect(patchOpenClawGatewayDaemonDialback(tmp, { audit: true }).status).toBe(
        "already-patched",
      );
      expect(fs.readFileSync(path.join(tmp, "call.js"), "utf8")).toContain(CALL_CONTEXT_MARKER);
      expect(fs.readFileSync(path.join(tmp, "connection-details.js"), "utf8")).toContain(
        CONNECTION_DETAILS_MARKER,
      );
      expect(fs.readFileSync(path.join(tmp, "gateway-tools.js"), "utf8")).toContain(
        TOOL_TARGET_MARKER,
      );
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("fails closed on missing or ambiguous upstream shapes", () => {
    expect(() => patchGatewayCallContextText("const unrelated = true;")).toThrow(
      /expected one unpatched or one patched gateway call context shape/,
    );
    expect(() =>
      patchGatewayCallContextText(`${CALL_CONTEXT_SOURCE}\n${CALL_CONTEXT_SOURCE}`),
    ).toThrow(/found 2 upstream/);
  });

  it("provides an auditable command-line contract", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-dialback-cli-"));
    try {
      fs.writeFileSync(path.join(tmp, "call.js"), CALL_CONTEXT_SOURCE);
      fs.writeFileSync(path.join(tmp, "connection-details.js"), CONNECTION_DETAILS_SOURCE);
      fs.writeFileSync(path.join(tmp, "gateway-tools.js"), TOOL_TARGET_SOURCE);

      const apply = spawnSync(process.execPath, ["--experimental-strip-types", PATCH_SCRIPT, tmp], {
        encoding: "utf8",
      });
      expect(apply.status, apply.stderr).toBe(0);
      expect(apply.stdout).toContain("patched OpenClaw gateway daemon dial-back (3 files)");

      const audit = spawnSync(
        process.execPath,
        ["--experimental-strip-types", PATCH_SCRIPT, "--audit", tmp],
        { encoding: "utf8" },
      );
      expect(audit.status, audit.stderr).toBe(0);
      expect(audit.stdout).toContain("audited OpenClaw gateway daemon dial-back (3 files)");
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });
});
