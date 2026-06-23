// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const exportScript = ".github/actions/export-e2e-hosted-inference/export.sh";

function runExportAction(env: Record<string, string>) {
  const tmp = mkdtempSync(path.join(tmpdir(), "e2e-hosted-export-"));
  const githubEnv = path.join(tmp, "github-env");
  const result = spawnSync("bash", [exportScript], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_ENV: githubEnv,
      INPUT_REQUIRE_HOSTED_INFERENCE: "true",
      ...env,
    },
  });
  const exported = result.status === 0 ? readFileSync(githubEnv, "utf8") : "";
  rmSync(tmp, { recursive: true, force: true });
  return { ...result, exported };
}

describe("export-e2e-hosted-inference action", () => {
  it("rejects multiline credentials before writing GITHUB_ENV", () => {
    const result = runExportAction({
      INPUT_NVIDIA_INFERENCE_API_KEY: "nvapi-good\nMALICIOUS=1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Hosted inference credentials must be single-line values");
    expect(result.exported).toBe("");
  });

  it("promotes the legacy-only NVIDIA_API_KEY input to canonical hosted exports", () => {
    const result = runExportAction({
      INPUT_NVIDIA_API_KEY: "nvapi-test-legacy-credential",
    });

    expect(result.status).toBe(0);
    expect(result.exported).toContain("NVIDIA_INFERENCE_API_KEY=nvapi-test-legacy-credential\n");
    expect(result.exported).toContain("COMPATIBLE_API_KEY=nvapi-test-legacy-credential\n");
    expect(result.exported).not.toContain("NVIDIA_API_KEY=nvapi-test-legacy-credential\n");
  });

  it("exports NVIDIA_API_KEY only for explicit legacy alias callers", () => {
    const result = runExportAction({
      INPUT_NVIDIA_INFERENCE_API_KEY: "nvapi-test-hosted-credential",
      INPUT_EXPORT_NVIDIA_API_KEY: "true",
    });

    expect(result.status).toBe(0);
    expect(result.exported).toContain("NVIDIA_INFERENCE_API_KEY=nvapi-test-hosted-credential\n");
    expect(result.exported).toContain("COMPATIBLE_API_KEY=nvapi-test-hosted-credential\n");
    expect(result.exported).toContain("NVIDIA_API_KEY=nvapi-test-hosted-credential\n");
  });

  it("falls back from a non-hosted canonical secret to the hosted legacy alias", () => {
    const result = runExportAction({
      INPUT_NVIDIA_INFERENCE_API_KEY: "not-hosted-secret",
      INPUT_NVIDIA_API_KEY: "nvapi-test-legacy-credential",
      INPUT_EXPORT_NVIDIA_API_KEY: "true",
    });

    expect(result.status).toBe(0);
    expect(result.exported).toContain("NVIDIA_INFERENCE_API_KEY=nvapi-test-legacy-credential\n");
    expect(result.exported).toContain("COMPATIBLE_API_KEY=nvapi-test-legacy-credential\n");
    expect(result.exported).toContain("NVIDIA_API_KEY=nvapi-test-legacy-credential\n");
  });

  it("normalizes a non-hosted NVIDIA_API_KEY alias to the canonical hosted credential", () => {
    const result = runExportAction({
      INPUT_NVIDIA_INFERENCE_API_KEY: "nvapi-test-hosted-credential",
      INPUT_NVIDIA_API_KEY: "not-hosted-secret",
      INPUT_EXPORT_NVIDIA_API_KEY: "true",
    });

    expect(result.status).toBe(0);
    expect(result.exported).toContain("NVIDIA_INFERENCE_API_KEY=nvapi-test-hosted-credential\n");
    expect(result.exported).toContain("COMPATIBLE_API_KEY=nvapi-test-hosted-credential\n");
    expect(result.exported).toContain("NVIDIA_API_KEY=nvapi-test-hosted-credential\n");
    expect(result.exported).not.toContain("not-hosted-secret");
  });

  it("exports hosted inference aliases from the canonical credential", () => {
    const result = runExportAction({
      INPUT_NVIDIA_INFERENCE_API_KEY: "nvapi-test-hosted-credential",
    });

    expect(result.status).toBe(0);
    expect(result.exported).toContain("NVIDIA_INFERENCE_API_KEY=nvapi-test-hosted-credential\n");
    expect(result.exported).toContain("COMPATIBLE_API_KEY=nvapi-test-hosted-credential\n");
    expect(result.exported).not.toContain("NVIDIA_API_KEY=nvapi-test-hosted-credential\n");
    expect(result.exported).toContain("NEMOCLAW_PROVIDER=custom\n");
  });
});
