// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dockerRunCommandBetween } from "../../helpers/dockerfile-run-shell";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const HERMES_DOCKERFILE = path.join(ROOT, "agents", "hermes", "Dockerfile");

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
  const dockerfile = fs.readFileSync(HERMES_DOCKERFILE, "utf-8");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-mcp-runtime-"));
  const toolsDir = path.join(tmp, "tools");
  const acpAdapterDir = path.join(tmp, "acp_adapter");
  const acpDistInfo = path.join(tmp, `agent_client_protocol-${acpVersion}.dist-info`);
  const imageCommand = dockerRunCommandBetween(
    dockerfile,
    "# Managed MCP and ACP require their packaged Hermes client surfaces",
    "# Published base images can lag Dockerfile.base",
  );
  const command = imageCommand.replaceAll("/opt/hermes/.venv/bin/python -I", "python3");
  try {
    for (const directory of [toolsDir, acpAdapterDir, acpDistInfo]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    fs.writeFileSync(path.join(tmp, acpModuleFilename), "# ACP SDK fixture\n");
    fs.writeFileSync(path.join(acpAdapterDir, "__init__.py"), "");
    fs.writeFileSync(
      path.join(acpAdapterDir, "server.py"),
      "class HermesACPAgent:\n    pass\n",
    );
    fs.writeFileSync(
      path.join(acpDistInfo, "METADATA"),
      `Metadata-Version: 2.4\nName: agent-client-protocol\nVersion: ${acpVersion}\n`,
    );
    fs.writeFileSync(path.join(tmp, "mcp.py"), "# MCP SDK fixture\n");
    fs.writeFileSync(path.join(toolsDir, "__init__.py"), "");
    fs.writeFileSync(
      path.join(toolsDir, "mcp_tool.py"),
      `_MCP_AVAILABLE = ${mcpAvailable ? "True" : "False"}\n` +
        `_MCP_HTTP_AVAILABLE = ${httpAvailable ? "True" : "False"}\n`,
    );
    return {
      imageCommand,
      result: spawnSync("bash", ["-c", command], {
        encoding: "utf-8",
        env: { ...process.env, PYTHONPATH: tmp },
        timeout: 5000,
      }),
    };
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
    expect(complete.imageCommand).toContain("/opt/hermes/.venv/bin/python -I -c");
    expect(complete.imageCommand).toContain('metadata.version("agent-client-protocol")');
    expect(complete.imageCommand).toContain("import acp");
    expect(complete.imageCommand).toContain(
      "from acp_adapter.server import HermesACPAgent",
    );
    expect(complete.imageCommand).not.toContain("assert ");
    expect(complete.result.status, complete.result.stderr).toBe(0);

    const missingHttp = runHermesOptionalRuntimeValidation({
      mcpAvailable: true,
      httpAvailable: false,
    });
    expect(missingHttp.result.status).toBe(1);
    expect(missingHttp.result.stderr).toContain(
      "Hermes MCP Streamable HTTP runtime is unavailable",
    );

    const wrongAcp = runHermesOptionalRuntimeValidation({
      mcpAvailable: true,
      httpAvailable: true,
      acpVersion: "0.8.0",
    });
    expect(wrongAcp.result.status).toBe(1);
    expect(wrongAcp.result.stderr).toContain("Hermes ACP SDK version is unavailable");

    const missingAcp = runHermesOptionalRuntimeValidation({
      mcpAvailable: true,
      httpAvailable: true,
      acpModuleFilename: "not_acp.py",
    });
    expect(missingAcp.result.status).toBe(1);
    expect(missingAcp.result.stderr).toContain("No module named 'acp'");
  });
});
