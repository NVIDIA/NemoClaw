// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { McpBridgeEntry } from "../../state/registry";
import {
  buildCredentialResolutionProbeCommand,
  classifyCredentialResolutionProbe,
  MCP_PROBE_CONTROL_BEARER,
  MCP_PROBE_CONTROL_EXIT_MARKER,
  MCP_PROBE_CONTROL_HTTP_MARKER,
  MCP_PROBE_EXIT_MARKER,
  MCP_PROBE_HTTP_MARKER,
  PROBE_SANITIZED_ENV_VARS,
} from "./mcp-bridge-resolution-probe";

const baseEntry: McpBridgeEntry = {
  server: "github",
  agent: "openclaw",
  adapter: "mcporter",
  url: "https://api.githubcopilot.com/mcp/",
  env: ["GITHUB_TOKEN"],
  providerName: "alpha-mcp-github",
  providerId: "11111111-2222-4333-8444-555555555555",
  policyName: "mcp-bridge-github",
  addedAt: new Date(0).toISOString(),
};

function probeStdout(
  parts: {
    httpStatus?: number;
    curlExit: number;
    controlHttpStatus?: number;
    controlExit?: number;
  },
  resultMarker?: string,
): string {
  const nonce = resultMarker ? `${resultMarker}:` : "";
  return [
    ...(parts.httpStatus === undefined
      ? []
      : [`${MCP_PROBE_HTTP_MARKER}${nonce}${parts.httpStatus}`]),
    `${MCP_PROBE_EXIT_MARKER}${nonce}${parts.curlExit}`,
    ...(parts.controlHttpStatus === undefined
      ? []
      : [`${MCP_PROBE_CONTROL_HTTP_MARKER}${nonce}${parts.controlHttpStatus}`]),
    ...(parts.controlExit === undefined
      ? []
      : [`${MCP_PROBE_CONTROL_EXIT_MARKER}${nonce}${parts.controlExit}`]),
  ].join("\n");
}

describe("MCP credential-resolution probe command security", () => {
  it("validates and silences proxy env before framing nonce-bound runtime curls (#6379)", () => {
    const built = buildCredentialResolutionProbeCommand(baseEntry, "mcporter");
    expect(built).not.toBeNull();
    const command = built?.command ?? "";
    const validationIndex = command.indexOf('[ -L "$proxy_env" ]');
    const sourceIndex = command.indexOf('. "$proxy_env"');
    const unsetIndex = command.indexOf(`unset ${PROBE_SANITIZED_ENV_VARS.join(" ")}`);
    const frameIndex = command.indexOf(built?.resultMarker ?? "missing-result-marker");
    const firstChildIndex = command.indexOf("curl");

    expect(command).toContain("expected regular root-owned mode 444 file");
    expect(command).toContain('. "$proxy_env" >/dev/null 2>&1');
    expect(validationIndex).toBeGreaterThan(-1);
    expect(sourceIndex).toBeGreaterThan(validationIndex);
    expect(unsetIndex).toBeGreaterThan(sourceIndex);
    expect(frameIndex).toBeGreaterThan(unsetIndex);
    expect(firstChildIndex).toBeGreaterThan(frameIndex);
    expect(command).toContain("nemoclaw-start node -e");
    expect(command).toContain("'authorization: Bearer openshell:resolve:env:GITHUB_TOKEN'");
    expect(command).toContain(`'authorization: Bearer ${MCP_PROBE_CONTROL_BEARER}'`);
    expect(command).toContain('"method":"initialize"');
    expect(command).toContain(`${MCP_PROBE_HTTP_MARKER}${built?.resultMarker}:`);
    expect(command).toContain(`${MCP_PROBE_CONTROL_HTTP_MARKER}${built?.resultMarker}:`);
    expect(command.trimEnd().endsWith("exit 0")).toBe(true);
  });

  it("uses the selected adapter runtime without capturing endpoint bodies (#6379)", () => {
    const mcporter = buildCredentialResolutionProbeCommand(baseEntry, "mcporter")?.command ?? "";
    const hermes = buildCredentialResolutionProbeCommand(baseEntry, "hermes-config")?.command ?? "";
    const deepagents =
      buildCredentialResolutionProbeCommand(baseEntry, "deepagents-config")?.command ?? "";

    expect(mcporter).toContain("nemoclaw-start node -e");
    expect(hermes).toContain("/opt/hermes/.venv/bin/python -c");
    expect(deepagents).toContain("/opt/venv/bin/python3 -c");
    for (const command of [mcporter, hermes, deepagents]) {
      expect(command).toContain("'/dev/null'");
      expect(command).not.toContain("head -c");
      expect(command).not.toContain("mktemp");
    }
  });

  it("refuses missing credentials and unsafe persisted endpoints (#6379)", () => {
    expect(buildCredentialResolutionProbeCommand({ ...baseEntry, env: [] }, "mcporter")).toBeNull();
    expect(
      buildCredentialResolutionProbeCommand(
        { ...baseEntry, url: "http://api.githubcopilot.com/mcp/" },
        "mcporter",
      ),
    ).toBeNull();
    expect(
      buildCredentialResolutionProbeCommand(
        { ...baseEntry, url: "https://host.openshell.internal:31337/mcp" },
        "mcporter",
      ),
    ).toBeNull();
  });

  it("rejects duplicate and out-of-order result markers (#6379)", () => {
    const built = buildCredentialResolutionProbeCommand(baseEntry, "mcporter");
    expect(built).not.toBeNull();
    const resultMarker = built?.resultMarker ?? "missing-result-marker";
    const duplicated = classifyCredentialResolutionProbe(
      {
        status: 0,
        stdout: [
          resultMarker,
          probeStdout(
            { httpStatus: 200, curlExit: 0, controlHttpStatus: 401, controlExit: 0 },
            resultMarker,
          ),
          probeStdout(
            { httpStatus: 401, curlExit: 0, controlHttpStatus: 401, controlExit: 0 },
            resultMarker,
          ),
        ].join("\n"),
        stderr: "",
      },
      baseEntry,
      resultMarker,
    );
    expect(duplicated.ok).toBeNull();

    const outOfOrder = classifyCredentialResolutionProbe(
      {
        status: 0,
        stdout: [
          resultMarker,
          `${MCP_PROBE_EXIT_MARKER}${resultMarker}:0`,
          `${MCP_PROBE_HTTP_MARKER}${resultMarker}:200`,
          `${MCP_PROBE_CONTROL_HTTP_MARKER}${resultMarker}:401`,
          `${MCP_PROBE_CONTROL_EXIT_MARKER}${resultMarker}:0`,
        ].join("\n"),
        stderr: "",
      },
      baseEntry,
      resultMarker,
    );
    expect(outOfOrder).toEqual({ ok: null, detail: "probe output markers were out of order" });
  });

  it("accepts only fresh nonce-bound markers after the trusted result frame (#6379)", () => {
    const built = buildCredentialResolutionProbeCommand(baseEntry, "mcporter");
    expect(built).not.toBeNull();
    const resultMarker = built?.resultMarker ?? "missing-result-marker";
    const probe = classifyCredentialResolutionProbe(
      {
        status: 0,
        stdout: [
          probeStdout({ httpStatus: 200, curlExit: 0, controlHttpStatus: 401, controlExit: 0 }),
          resultMarker,
          probeStdout(
            { httpStatus: 401, curlExit: 0, controlHttpStatus: 401, controlExit: 0 },
            resultMarker,
          ),
        ].join("\n"),
        stderr: "",
      },
      baseEntry,
      resultMarker,
    );
    expect(probe.ok).toBeNull();
    expect(probe.httpStatus).toBe(401);

    const staleOnly = classifyCredentialResolutionProbe(
      {
        status: 0,
        stdout: [
          resultMarker,
          probeStdout({ httpStatus: 200, curlExit: 0, controlHttpStatus: 401, controlExit: 0 }),
        ].join("\n"),
        stderr: "",
      },
      baseEntry,
      resultMarker,
    );
    expect(staleOnly).toEqual({
      ok: null,
      detail: "probe output missing or ambiguous markers",
    });

    const duplicatedFrame = classifyCredentialResolutionProbe(
      {
        status: 0,
        stdout: [
          resultMarker,
          probeStdout(
            { httpStatus: 200, curlExit: 0, controlHttpStatus: 401, controlExit: 0 },
            resultMarker,
          ),
        ].join("\n"),
        stderr: resultMarker,
      },
      baseEntry,
      resultMarker,
    );
    expect(duplicatedFrame).toEqual({
      ok: null,
      detail: "probe output missing trusted result frame",
    });
  });
});
