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
} from "../../../scripts/openclaw/patch-gateway-daemon-dialback.mts";
import { restoreEnv } from "../../helpers/env-test-helpers";

const PATCH_SCRIPT = path.join(
  import.meta.dirname,
  "../../..",
  "scripts",
  "openclaw",
  "patch-gateway-daemon-dialback.mts",
);
const DOCKERFILE = path.join(import.meta.dirname, "../../..", "Dockerfile");

const CALL_CONTEXT_SOURCE = [
  "function trimToUndefined(value) { return value?.trim() || undefined; }",
  "function resolveGatewayCallContext(opts) {",
  "\tconst cliUrlOverride = trimToUndefined(opts.url);",
  "\tconst envUrlOverride = cliUrlOverride || opts.localPortOverride !== void 0 ? void 0 : trimToUndefined(process.env.OPENCLAW_GATEWAY_URL);",
  "\treturn cliUrlOverride ?? envUrlOverride ?? `ws://127.0.0.1:${opts.localPortOverride ?? 18789}`;",
  "}",
  "export { resolveGatewayCallContext };",
  "",
].join("\n");

const CONNECTION_DETAILS_SOURCE = [
  "function normalizeOptionalString(value) { return value?.trim() || undefined; }",
  "function buildGatewayConnectionDetails(options) {",
  "\tconst cliUrlOverride = normalizeOptionalString(options.url);",
  "\tconst envUrlOverride = cliUrlOverride || options.ignoreEnvUrlOverride || options.localPortOverride !== void 0 ? void 0 : normalizeOptionalString(process.env.OPENCLAW_GATEWAY_URL);",
  "\treturn cliUrlOverride ?? envUrlOverride ?? `ws://127.0.0.1:${options.localPortOverride ?? 18789}`;",
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
    restoreEnv("OPENSHELL_SANDBOX", values.openshell);
    restoreEnv("OPENCLAW_GATEWAY_URL", values.url);
    return run();
  } finally {
    process.title = previousTitle;
    restoreEnv("OPENSHELL_SANDBOX", previousSandbox);
    restoreEnv("OPENCLAW_GATEWAY_URL", previousUrl);
  }
}

function readGatewayDaemonDialbackBuildCommand(): string {
  const continuation = String.fromCharCode(92);
  const newline = String.fromCharCode(10);
  const expectedBlock = [
    `RUN if [ "$OPENCLAW_VERSION" = "2026.7.1" ]; then ${continuation}`,
    `      node --experimental-strip-types /usr/local/lib/nemoclaw/patch-openclaw-gateway-daemon-dialback.mts ${continuation}`,
    `        /usr/local/lib/node_modules/openclaw/dist; ${continuation}`,
    "    fi",
  ].join(newline);
  const dockerfile = fs.readFileSync(DOCKERFILE, "utf8");
  expect(dockerfile).toContain(expectedBlock);
  return expectedBlock
    .slice("RUN ".length)
    .split(`${continuation}${newline}`)
    .map((line) => line.trim())
    .join(" ");
}

describe("OpenClaw gateway daemon self-dialback patch", () => {
  it.each([
    { expectedCalls: "", version: "2026.3.11" },
    { expectedCalls: "", version: "2026.4.24" },
    {
      expectedCalls:
        "--experimental-strip-types /usr/local/lib/nemoclaw/patch-openclaw-gateway-daemon-dialback.mts /usr/local/lib/node_modules/openclaw/dist\n",
      version: "2026.7.1",
    },
  ])(
    "runs the exact-version Dockerfile gate for $version (#7230)",
    ({ expectedCalls, version }) => {
      const shellCommand = readGatewayDaemonDialbackBuildCommand();

      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-dialback-gate-"));
      const callLog = path.join(tmp, "node-calls.log");
      const nodeStub = path.join(tmp, "node");
      try {
        fs.writeFileSync(
          nodeStub,
          ["#!/bin/sh", `printf "%s\\n" "$*" >> "$PATCH_CALL_LOG"`, ""].join("\n"),
          { mode: 0o755 },
        );
        const result = spawnSync("sh", ["-c", shellCommand], {
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_VERSION: version,
            PATCH_CALL_LOG: callLog,
            PATH: `${tmp}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        });

        expect(result.status, result.stderr).toBe(0);
        expect(fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8") : "").toBe(expectedCalls);
      } finally {
        fs.rmSync(tmp, { force: true, recursive: true });
      }
    },
  );

  it.each(["0", "false", " ", "sandbox-name"])(
    "uses loopback only for the OpenShell gateway daemon while descendants keep the private URL [%s]",
    async (openshell) => {
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
          { openshell: "1", title: "openclaw-gateway", url: privateUrl },
          () => {
            expect(callRuntime.resolveGatewayCallContext({})).toBe("ws://127.0.0.1:18789");
            expect(detailsRuntime.buildGatewayConnectionDetails({})).toBe("ws://127.0.0.1:18789");
            expect(targetRuntime.resolveDefaultGatewayTarget({ envGatewayUrl: privateUrl })).toBe(
              "local",
            );
          },
        );

        withGatewayEnvironment({ openshell: "1", title: "openclaw", url: privateUrl }, () => {
          expect(callRuntime.resolveGatewayCallContext({})).toBe(privateUrl);
          expect(detailsRuntime.buildGatewayConnectionDetails({})).toBe(privateUrl);
          expect(targetRuntime.resolveDefaultGatewayTarget({ envGatewayUrl: privateUrl })).toBe(
            "remote",
          );
        });

        withGatewayEnvironment({ openshell, title: "openclaw-gateway", url: privateUrl }, () => {
          expect(callRuntime.resolveGatewayCallContext({})).toBe(privateUrl);
          expect(detailsRuntime.buildGatewayConnectionDetails({})).toBe(privateUrl);
          expect(targetRuntime.resolveDefaultGatewayTarget({ envGatewayUrl: privateUrl })).toBe(
            "remote",
          );
        });
      } finally {
        fs.rmSync(tmp, { force: true, recursive: true });
      }
    },
  );

  it("preserves OPENCLAW_GATEWAY_URL outside OpenShell and explicit URL precedence", async () => {
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

  it("preserves explicit URL, local port, and configured remote URL precedence for the OpenShell gateway daemon (#7230)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-dialback-precedence-"));
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
      const explicitUrl = "wss://gateway.example.test";

      withGatewayEnvironment({ openshell: "1", title: "openclaw-gateway", url: privateUrl }, () => {
        expect(callRuntime.resolveGatewayCallContext({ url: explicitUrl })).toBe(explicitUrl);
        expect(callRuntime.resolveGatewayCallContext({ localPortOverride: 19001 })).toBe(
          "ws://127.0.0.1:19001",
        );
        expect(detailsRuntime.buildGatewayConnectionDetails({ url: explicitUrl })).toBe(
          explicitUrl,
        );
        expect(detailsRuntime.buildGatewayConnectionDetails({ ignoreEnvUrlOverride: true })).toBe(
          "ws://127.0.0.1:18789",
        );
        expect(detailsRuntime.buildGatewayConnectionDetails({ localPortOverride: 19001 })).toBe(
          "ws://127.0.0.1:19001",
        );
        expect(
          targetRuntime.resolveDefaultGatewayTarget({
            envGatewayUrl: privateUrl,
            remoteUrl: explicitUrl,
          }),
        ).toBe("remote");
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

  it("leaves earlier targets unchanged when the agent-tool gateway shape is missing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-dialback-atomic-"));
    const callPath = path.join(tmp, "call.js");
    const connectionPath = path.join(tmp, "connection-details.js");
    try {
      fs.writeFileSync(callPath, CALL_CONTEXT_SOURCE);
      fs.writeFileSync(connectionPath, CONNECTION_DETAILS_SOURCE);

      expect(() => patchOpenClawGatewayDaemonDialback(tmp)).toThrow(
        /expected exactly one agent-tool gateway target, found 0/,
      );
      expect(fs.readFileSync(callPath, "utf8")).toBe(CALL_CONTEXT_SOURCE);
      expect(fs.readFileSync(connectionPath, "utf8")).toBe(CONNECTION_DETAILS_SOURCE);
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("fails closed when a marker remains after the patched shape drifts", () => {
    const patched = patchGatewayCallContextText(CALL_CONTEXT_SOURCE).text;
    const drifted = patched.replace(
      " || nemoclawGatewaySelfDialback ? void 0",
      " || false ? void 0",
    );

    expect(drifted).toContain(CALL_CONTEXT_MARKER);
    expect(() => patchGatewayCallContextText(drifted)).toThrow(
      /found 0 upstream, 0 patched, and 1 marker occurrences/,
    );
  });

  it("reports apply and audit results through its command-line interface (#7215)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-dialback-cli-"));
    try {
      fs.writeFileSync(path.join(tmp, "call.js"), CALL_CONTEXT_SOURCE);
      fs.writeFileSync(path.join(tmp, "connection-details.js"), CONNECTION_DETAILS_SOURCE);
      fs.writeFileSync(path.join(tmp, "gateway-tools.js"), TOOL_TARGET_SOURCE);

      const apply = spawnSync(process.execPath, ["--experimental-strip-types", PATCH_SCRIPT, tmp], {
        encoding: "utf8",
      });
      expect(apply.status, apply.stderr).toBe(0);
      expect(apply.stdout).toContain("patched OpenClaw gateway daemon self-dialback (3 files)");

      const audit = spawnSync(
        process.execPath,
        ["--experimental-strip-types", PATCH_SCRIPT, "--audit", tmp],
        { encoding: "utf8" },
      );
      expect(audit.status, audit.stderr).toBe(0);
      expect(audit.stdout).toContain("audited OpenClaw gateway daemon self-dialback (3 files)");
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });
});
