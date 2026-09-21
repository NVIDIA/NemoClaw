// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXPORTED_VLLM_PROFILE_ID } from "../../config/model";
import { loadServingCatalog } from "./catalog-loader";
import { servingProfileProvenance } from "./profile-provenance";
import { runtimeAuthFingerprint } from "./runtime-auth-fingerprint";
import {
  HOST_LOCAL_VLLM_AUTH_LABEL,
  HOST_LOCAL_VLLM_CATALOG_LABEL,
  HOST_LOCAL_VLLM_MANAGED_LABEL,
  HOST_LOCAL_VLLM_PRESET_DIGEST_LABEL,
  HOST_LOCAL_VLLM_PRESET_LABEL,
  HOST_LOCAL_VLLM_RECIPE_DIGEST_LABEL,
  HOST_LOCAL_VLLM_RECIPE_LABEL,
  persistHostLocalVllmRuntimeReceipt,
} from "./vllm-host-local-lifecycle";
import { observeManagedVllmForExport, type VllmExportRuntimeOptions } from "./vllm-export-runtime";

const temporaryDirectories: string[] = [];
const key = "e".repeat(64);
const containerId = "a".repeat(64);
const imageId = `sha256:${"b".repeat(64)}`;
const profile = () => servingProfileProvenance(loadServingCatalog(), EXPORTED_VLLM_PROFILE_ID);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const provenance = profile();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-vllm-export-"));
  temporaryDirectories.push(directory);
  const fingerprint = runtimeAuthFingerprint(key);
  persistHostLocalVllmRuntimeReceipt(
    {
      containerId,
      authFingerprint: fingerprint,
      serving: {
        catalogDigest: provenance.catalogDigest,
        presetId: provenance.preset.id,
        presetDigest: provenance.preset.digest,
        recipeId: provenance.recipe.id,
        recipeDigest: provenance.recipe.digest,
      },
    },
    directory,
  );
  const image = { Id: imageId, Os: "linux", Architecture: "amd64", Environment: ["PATH=/usr/bin"] };
  const network = {
    Id: "c".repeat(64),
    Name: "openshell-docker",
    Driver: "bridge",
    Config: [{ Gateway: "172.18.0.1", Subnet: "172.18.0.0/16" }],
  };
  const container = {
    Id: containerId,
    Name: "/nemoclaw-vllm",
    Image: imageId,
    StartedAt: "2026-09-10T10:00:00Z",
    Matches: true,
    State: { Running: true },
    Config: {
      Env: [`VLLM_API_KEY=${key}`],
      Labels: {
        [HOST_LOCAL_VLLM_AUTH_LABEL]: fingerprint,
        [HOST_LOCAL_VLLM_MANAGED_LABEL]: "true",
        [HOST_LOCAL_VLLM_CATALOG_LABEL]: provenance.catalogDigest,
        [HOST_LOCAL_VLLM_PRESET_LABEL]: provenance.preset.id,
        [HOST_LOCAL_VLLM_PRESET_DIGEST_LABEL]: provenance.preset.digest,
        [HOST_LOCAL_VLLM_RECIPE_LABEL]: provenance.recipe.id,
        [HOST_LOCAL_VLLM_RECIPE_DIGEST_LABEL]: provenance.recipe.digest,
      },
    },
    NetworkSettings: {
      Ports: {
        "8000/tcp": [
          { HostIp: "127.0.0.1", HostPort: "18000" },
          { HostIp: "172.18.0.1", HostPort: "18000" },
        ],
      },
    },
  };
  const capture = vi.fn<NonNullable<VllmExportRuntimeOptions["capture"]>>((args) => {
    return JSON.stringify(
      { image, network, container }[args[0] as "image" | "network" | "container"],
    );
  });
  const loadApiKey = vi.fn(() => key);
  const options = {
    capture,
    platform: "linux",
    architecture: "x64",
    authentication: { stateDir: directory, loadApiKey },
  };
  return { provenance, directory, image, network, container, capture, loadApiKey, options };
}

describe("fixed managed vLLM export observation", () => {
  it("binds one running runtime to the current catalog and nondefault listener", () => {
    const f = fixture();
    const result = observeManagedVllmForExport(f.provenance, f.options);
    expect(result).toMatchObject({
      containerId,
      imageId,
      networkId: f.network.Id,
      startedAt: f.container.StartedAt,
      serving: {
        profile: { id: EXPORTED_VLLM_PROFILE_ID },
        model: f.provenance.model,
        hostPort: 18000,
      },
    });
    expect(f.loadApiKey).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(key);
    expect(serialized).not.toContain(runtimeAuthFingerprint(key));
    expect(serialized).not.toContain("VLLM_API_KEY");
    expect(serialized).not.toContain(f.directory);
    expect(f.capture.mock.calls.map(([args]) => args.slice(0, 2))).toEqual([
      ["image", "inspect"],
      ["network", "inspect"],
      ["container", "inspect"],
    ]);
    expect(f.capture.mock.calls.map(([args]) => args[2])).toEqual([
      "--format",
      "--format",
      "--format",
    ]);
    expect(JSON.stringify(f.capture.mock.calls.map(([args]) => args))).not.toContain(key);
    const boundedCapture = expect.objectContaining({
      env: expect.objectContaining({ DOCKER_CONTEXT: "default" }),
      timeout: 5000,
      maxBuffer: 65536,
    });
    expect(f.capture.mock.calls.map(([, options]) => options)).toEqual([
      boundedCapture,
      boundedCapture,
      boundedCapture,
    ]);
  });

  it.each([
    [
      "foreign container",
      (f: ReturnType<typeof fixture>) => {
        f.container.Id = "d".repeat(64);
      },
    ],
    [
      "stopped container",
      (f: ReturnType<typeof fixture>) => {
        f.container.State.Running = false;
      },
    ],
    [
      "changed fixed configuration",
      (f: ReturnType<typeof fixture>) => {
        f.container.Matches = false;
      },
    ],
    [
      "substituted image",
      (f: ReturnType<typeof fixture>) => {
        f.container.Image = `sha256:${"d".repeat(64)}`;
      },
    ],
    [
      "foreign serving label",
      (f: ReturnType<typeof fixture>) => {
        f.container.Config.Labels[HOST_LOCAL_VLLM_RECIPE_DIGEST_LABEL] = `sha256:${"d".repeat(64)}`;
      },
    ],
    [
      "mismatched token",
      (f: ReturnType<typeof fixture>) => {
        f.container.Config.Env = [`VLLM_API_KEY=${"d".repeat(64)}`];
      },
    ],
    [
      "additional credential payload",
      (f: ReturnType<typeof fixture>) => {
        f.container.Config.Env.push("SECRET=private-value");
      },
    ],
    [
      "public listener",
      (f: ReturnType<typeof fixture>) => {
        f.container.NetworkSettings.Ports["8000/tcp"][0]!.HostIp = "0.0.0.0";
      },
    ],
    [
      "different bridge listener",
      (f: ReturnType<typeof fixture>) => {
        f.network.Config[0]!.Gateway = "172.19.0.1";
      },
    ],
    [
      "additional port",
      (f: ReturnType<typeof fixture>) => {
        Object.assign(f.container.NetworkSettings.Ports, { "9000/tcp": [] });
      },
    ],
    [
      "unsafe bridge",
      (f: ReturnType<typeof fixture>) => {
        f.network.Config[0]!.Gateway = "169.254.169.254";
      },
    ],
    [
      "wrong architecture",
      (f: ReturnType<typeof fixture>) => {
        f.image.Architecture = "arm64";
      },
    ],
    [
      "duplicate image environment",
      (f: ReturnType<typeof fixture>) => {
        f.image.Environment.push(f.image.Environment[0]!);
      },
    ],
    [
      "missing receipt",
      (f: ReturnType<typeof fixture>) => {
        fs.unlinkSync(path.join(f.directory, "host-local-vllm-runtime.json"));
      },
    ],
    [
      "oversized receipt",
      (f: ReturnType<typeof fixture>) => {
        fs.writeFileSync(path.join(f.directory, "host-local-vllm-runtime.json"), " ".repeat(65537));
      },
    ],
  ])("rejects %s without leaking private observations", (_label, change) => {
    const f = fixture();
    change(f);
    expect(() => observeManagedVllmForExport(f.provenance, f.options)).toThrow(
      "The fixed managed vLLM runtime could not be verified for export.",
    );
  });

  it.each(["{malformed", "x".repeat(65537)])("redacts failed or malformed inspection", (value) => {
    const f = fixture();
    f.capture.mockReturnValue(value);
    expect(() => observeManagedVllmForExport(f.provenance, f.options)).toThrow(
      "The fixed managed vLLM runtime could not be verified for export.",
    );
    expect(f.loadApiKey).not.toHaveBeenCalled();
  });

  it("redacts runtime inspection failures before private authentication access", () => {
    const f = fixture();
    f.capture.mockImplementation(() => {
      throw new Error("timeout credential-canary");
    });
    expect(() => observeManagedVllmForExport(f.provenance, f.options)).toThrow(
      "The fixed managed vLLM runtime could not be verified for export.",
    );
    expect(f.loadApiKey).not.toHaveBeenCalled();
  });

  it("rejects stale catalog identity before Docker and credential access", () => {
    const f = fixture();
    expect(() =>
      observeManagedVllmForExport(
        { ...f.provenance, catalogDigest: `sha256:${"f".repeat(64)}` },
        f.options,
      ),
    ).toThrow();
    expect(f.capture).not.toHaveBeenCalled();
    expect(f.loadApiKey).not.toHaveBeenCalled();
  });

  it("rejects an unqualified host before runtime inspection", () => {
    const f = fixture();
    expect(() =>
      observeManagedVllmForExport(f.provenance, { ...f.options, architecture: "arm64" }),
    ).toThrow();
    expect(f.capture).not.toHaveBeenCalled();
  });
});
