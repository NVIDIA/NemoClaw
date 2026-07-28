// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createNvidiaSpeechHooks,
  installNvidiaManifestOverlay,
  NVIDIA_INDEX_SUFFIX,
  patchNvidiaIndexSource,
  patchNvidiaManifestSource,
  REVIEWED_NVIDIA_INDEX_SHA256,
  REVIEWED_NVIDIA_MANIFEST_SHA256,
} from "./openclaw-nvidia-speech";

const INDEX_FIXTURE = [
  'import { t as defineSingleProviderPluginEntry } from "../../provider-entry-B7bRwYH-.js";',
  'import { a as buildSelectableLiveNvidiaProvider, i as buildNvidiaProvider, r as buildLiveNvidiaProvider } from "../../provider-catalog-nFFsCw7o.js";',
  'import { n as applyNvidiaConfig, t as NVIDIA_DEFAULT_MODEL_REF } from "../../onboard-Dk2KiUua.js";',
  "var nvidia_default = defineSingleProviderPluginEntry({",
  '\tid: "nvidia",',
  "\tprovider: {",
  '\t\tlabel: "NVIDIA"',
  "\t}",
  "});",
  "export { nvidia_default as default };",
  "",
].join("\n");
const MANIFEST_FIXTURE = `${JSON.stringify({
  id: "nvidia",
  configSchema: { type: "object", additionalProperties: false, properties: {} },
})}\n`;
const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("VoiceClaw OpenClaw NVIDIA speech preload", () => {
  it("adds NVIDIA TTS registration to the reviewed entrypoint (#6387)", () => {
    const patched = patchNvidiaIndexSource(INDEX_FIXTURE, REVIEWED_NVIDIA_INDEX_SHA256);

    expect(patched).toContain('from "./voiceclaw-nvidia-speech-provider.js"');
    expect(patched).not.toContain("registerMediaUnderstandingProvider");
    expect(patched).toContain("api.registerSpeechProvider(buildNvidiaSpeechProvider())");
  });

  it("leaves an unreviewed OpenClaw entrypoint unchanged (#6387)", () => {
    expect(patchNvidiaIndexSource(INDEX_FIXTURE, "0".repeat(64))).toBe(INDEX_FIXTURE);
  });

  it("serves channel-owned provider modules through synchronous module hooks (#6387)", () => {
    const virtualSources = {
      "voiceclaw-nvidia-speech-config.js": "export const config = true;",
      "voiceclaw-nvidia-speech-http.runtime.js": "export const http = true;",
      "voiceclaw-nvidia-speech-provider.js": "export const tts = true;",
      "voiceclaw-wave-audio.js": "export const wave = true;",
    };
    const hooks = createNvidiaSpeechHooks(virtualSources, () => REVIEWED_NVIDIA_INDEX_SHA256);
    const indexUrl = `file:///usr/local/lib/node_modules/openclaw${NVIDIA_INDEX_SUFFIX}`;
    const virtualUrl = hooks.resolve(
      "./voiceclaw-nvidia-speech-provider.js",
      { parentURL: indexUrl },
      vi.fn(),
    );

    expect(virtualUrl).toMatchObject({ shortCircuit: true });
    expect(hooks.load(virtualUrl.url, {}, vi.fn())).toEqual({
      format: "module",
      source: "export const tts = true;",
      shortCircuit: true,
    });
    expect(
      hooks.load(indexUrl, {}, () => ({ format: "module", source: INDEX_FIXTURE })),
    ).toMatchObject({
      format: "module",
      source: expect.stringContaining("registerSpeechProvider"),
    });
  });

  it("overlays NVIDIA speech contracts in memory without changing OpenClaw files (#6387)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-voiceclaw-preload-"));
    temporaryDirectories.push(root);
    const extensionRoot = path.join(root, "dist", "extensions", "nvidia");
    fs.mkdirSync(extensionRoot, { recursive: true });
    const manifestPath = path.join(extensionRoot, "openclaw.plugin.json");
    fs.writeFileSync(manifestPath, MANIFEST_FIXTURE);
    const ioFs = {
      openSync: fs.openSync.bind(fs),
      readFileSync: fs.readFileSync.bind(fs),
      closeSync: fs.closeSync.bind(fs),
    };
    const restore = installNvidiaManifestOverlay(ioFs, () => REVIEWED_NVIDIA_MANIFEST_SHA256);

    const fd = ioFs.openSync(manifestPath, "r");
    const patched = JSON.parse(ioFs.readFileSync(fd, "utf8") as string);
    ioFs.closeSync(fd);
    restore();

    expect(patched).toMatchObject({
      contracts: {
        speechProviders: ["nvidia"],
      },
    });
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(MANIFEST_FIXTURE);
  });

  it("leaves an unreviewed NVIDIA manifest unchanged (#6387)", () => {
    expect(patchNvidiaManifestSource(MANIFEST_FIXTURE, "0".repeat(64))).toBe(MANIFEST_FIXTURE);
  });
});
