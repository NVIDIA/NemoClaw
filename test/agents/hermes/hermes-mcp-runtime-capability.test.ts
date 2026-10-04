// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const IMAGE_BUILD_PROBES = path.join(ROOT, "agents", "hermes", "image-build-probes.py");

function runHermesOptionalRuntimeValidation({
  mcpAvailable,
  httpAvailable,
  acpVersion = "0.9.0",
  acpModuleFilename = "acp.py",
}: {
  mcpAvailable: boolean;
  httpAvailable: boolean;
  acpVersion?: string;
  acpModuleFilename?: string;
}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-mcp-runtime-"));
  const toolsDir = path.join(tmp, "tools");
  const acpAdapterDir = path.join(tmp, "acp_adapter");
  const acpDistInfo = path.join(tmp, `agent_client_protocol-${acpVersion}.dist-info`);
  try {
    for (const directory of [toolsDir, acpAdapterDir, acpDistInfo]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    fs.writeFileSync(path.join(tmp, acpModuleFilename), "# ACP SDK fixture\n");
    fs.writeFileSync(path.join(acpAdapterDir, "__init__.py"), "");
    fs.writeFileSync(path.join(acpAdapterDir, "server.py"), "class HermesACPAgent:\n    pass\n");
    fs.writeFileSync(
      path.join(acpDistInfo, "METADATA"),
      `Metadata-Version: 2.4\nName: agent-client-protocol\nVersion: ${acpVersion}\n`,
    );
    fs.writeFileSync(path.join(tmp, "mcp.py"), "# MCP SDK fixture\n");
    fs.writeFileSync(path.join(toolsDir, "__init__.py"), "");
    fs.writeFileSync(
      path.join(toolsDir, "mcp_tool.py"),
      "_MCP_AVAILABLE = False\n" +
        "_MCP_HTTP_AVAILABLE = False\n" +
        "def _ensure_mcp_sdk():\n" +
        "    global _MCP_AVAILABLE, _MCP_HTTP_AVAILABLE\n" +
        `    _MCP_AVAILABLE = ${mcpAvailable ? "True" : "False"}\n` +
        `    _MCP_HTTP_AVAILABLE = ${httpAvailable ? "True" : "False"}\n` +
        "    return _MCP_AVAILABLE\n",
    );
    return spawnSync("python3", [IMAGE_BUILD_PROBES, "managed-runtime-capability"], {
      encoding: "utf-8",
      env: { ...process.env, PYTHONPATH: tmp },
      timeout: 5000,
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("Hermes managed optional runtime capability", () => {
  it("requires the pinned ACP adapter and MCP Streamable HTTP client in the final image", () => {
    const complete = runHermesOptionalRuntimeValidation({
      mcpAvailable: true,
      httpAvailable: true,
    });
    expect(complete.status, complete.stderr).toBe(0);

    const missingHttp = runHermesOptionalRuntimeValidation({
      mcpAvailable: true,
      httpAvailable: false,
    });
    expect(missingHttp.status).toBe(1);
    expect(missingHttp.stderr).toContain("Hermes MCP Streamable HTTP runtime is unavailable");

    const wrongAcp = runHermesOptionalRuntimeValidation({
      mcpAvailable: true,
      httpAvailable: true,
      acpVersion: "0.8.0",
    });
    expect(wrongAcp.status).toBe(1);
    expect(wrongAcp.stderr).toContain("Hermes ACP SDK version is unavailable");

    const missingAcp = runHermesOptionalRuntimeValidation({
      mcpAvailable: true,
      httpAvailable: true,
      acpModuleFilename: "not_acp.py",
    });
    expect(missingAcp.status).toBe(1);
    expect(missingAcp.stderr).toContain("No module named 'acp'");
  });
});
