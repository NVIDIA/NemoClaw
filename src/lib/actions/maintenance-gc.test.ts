// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_IMAGE_REPOS } from "../domain/sandbox/image-tag";

const mocks = vi.hoisted(() => ({
  dockerListImagesFormat: vi.fn(),
  dockerRmi: vi.fn(),
  prompt: vi.fn(),
}));
vi.mock("../adapters/docker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/docker")>()),
  dockerListImagesFormat: mocks.dockerListImagesFormat,
  dockerRmi: mocks.dockerRmi,
}));
vi.mock("../credentials/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../credentials/store")>()),
  prompt: mocks.prompt,
}));
vi.mock("../state/sandbox", () => ({}));
vi.mock("../state/mcp-lifecycle-lock", () => ({}));
vi.mock("../state/migrations/removed-immutability", () => ({}));
vi.mock("../openshell-sandbox-list", () => ({}));
vi.mock("./sandbox/snapshot/backup-authority", () => ({}));
vi.mock("./sandbox/snapshot/strict-pre-upgrade-recovery", () => ({}));
vi.mock("./sandbox/stopped-sandbox-backup", () => ({}));
vi.mock("../state/portable-uninstall-retirement", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/portable-uninstall-retirement")>()),
  isCurrentPortableHostFenceHeld: () => true,
}));

let home: string;
const aliceImage = "openshell/sandbox-from:alice";
const bobImage = "nemoclaw-sandbox-local:bob";
const orphanImage = "nemoclaw-sandbox-local:orphan";

function writeRegistry(port: number, imageTag: unknown, name = "sandbox"): string {
  const root =
    port === 8080
      ? path.join(home, ".nemoclaw")
      : path.join(home, ".nemoclaw", "gateways", String(port));
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, "sandboxes.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      defaultSandbox: name,
      sandboxes: { [name]: { name, gatewayPort: port, imageTag } },
    }),
  );
  return file;
}

async function collect(options: { yes?: boolean; dryRun?: boolean } = { yes: true }) {
  const { garbageCollectImages } = await import("./maintenance");
  return garbageCollectImages(options);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gc-")));
  vi.stubEnv("HOME", home);
  vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "8080");
  mocks.dockerListImagesFormat.mockImplementation(
    (repo: string) =>
      (
        ({
          "openshell/sandbox-from": `${aliceImage}\t1GB`,
          "nemoclaw-sandbox-local": `${bobImage}\t2GB\n${orphanImage}\t3GB`,
        }) as Record<string, string>
      )[repo] ?? "",
  );
  mocks.dockerRmi.mockReturnValue({ status: 0, stdout: "", stderr: "" });
  mocks.prompt.mockResolvedValue("n");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${String(code)}`);
  });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("garbage collection across gateway registries", () => {
  it.each([8080, 8090])(
    "preserves both registered images from gateway %i without containers (#12582)",
    async (port) => {
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(port));
      writeRegistry(8080, aliceImage);
      writeRegistry(8090, bobImage);

      await collect();

      expect(mocks.dockerRmi.mock.calls.map(([tag]) => tag)).toEqual([orphanImage]);
      expect(mocks.prompt).not.toHaveBeenCalled();
    },
  );

  it("reports only genuine orphans during dry-run (#12582)", async () => {
    writeRegistry(8080, aliceImage);
    writeRegistry(8090, bobImage);

    await collect({ dryRun: true });

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain(orphanImage);
    expect(output).not.toContain(aliceImage);
    expect(output).not.toContain(bobImage);
    expect(mocks.dockerRmi).not.toHaveBeenCalled();
    expect(mocks.prompt).not.toHaveBeenCalled();
  });

  it("preserves shared tags and an image registered only in a sibling root (#12582)", async () => {
    writeRegistry(8080, aliceImage);
    writeRegistry(8090, aliceImage);
    writeRegistry(8091, bobImage);

    await collect();

    expect(mocks.dockerRmi.mock.calls.map(([tag]) => tag)).toEqual([orphanImage]);
  });

  it.each([8080, 8090])(
    "collects genuine orphans with only gateway %i present (#12582)",
    async (port) => {
      writeRegistry(port, bobImage);

      await collect();

      expect(mocks.dockerRmi.mock.calls.map(([tag]) => tag)).toEqual([aliceImage, orphanImage]);
    },
  );

  it("collects images when every registry root is absent (#12582)", async () => {
    await collect();

    expect(mocks.dockerRmi.mock.calls.map(([tag]) => tag)).toEqual([
      aliceImage,
      bobImage,
      orphanImage,
    ]);
  });

  it.each(["{", "[]", '{"sandboxes":{"broken":null}}'])(
    "refuses deletion with malformed sibling state %s (#12582)",
    async (raw) => {
      writeRegistry(8080, aliceImage);
      const file = writeRegistry(8090, bobImage);
      fs.writeFileSync(file, raw);

      await expect(collect()).rejects.toThrow(/gateway state|EACCES|ELOOP/);

      expect(mocks.dockerRmi).not.toHaveBeenCalled();
      expect(mocks.prompt).not.toHaveBeenCalled();
    },
  );

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "refuses deletion when reading a sibling registry is denied (#12582)",
    async () => {
      writeRegistry(8080, aliceImage);
      const file = writeRegistry(8090, bobImage);
      fs.chmodSync(file, 0);

      await expect(collect()).rejects.toThrow(/gateway state|EACCES|ELOOP/);

      expect(mocks.dockerRmi).not.toHaveBeenCalled();
    },
  );

  it.runIf(process.platform !== "win32")(
    "refuses deletion with a symlinked sibling root (#12582)",
    async () => {
      writeRegistry(8080, aliceImage);
      const target = path.join(home, "sibling");
      fs.mkdirSync(target);
      fs.mkdirSync(path.join(home, ".nemoclaw", "gateways"));
      fs.symlinkSync(target, path.join(home, ".nemoclaw", "gateways", "8090"), "dir");

      await expect(collect()).rejects.toThrow(/gateway state|EACCES|ELOOP/);

      expect(mocks.dockerRmi).not.toHaveBeenCalled();
    },
  );

  it.runIf(process.platform !== "win32")(
    "refuses deletion with a symlinked sibling registry (#12582)",
    async () => {
      writeRegistry(8080, aliceImage);
      const file = writeRegistry(8090, bobImage);
      fs.renameSync(file, path.join(home, "registry.json"));
      fs.symlinkSync(path.join(home, "registry.json"), file);

      await expect(collect()).rejects.toThrow(/gateway state|EACCES|ELOOP/);

      expect(mocks.dockerRmi).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["non-string", 42],
    ["empty", ""],
    ["whitespace-only", " \t\n"],
  ])("refuses deletion when a sibling image tag is %s (#12582)", async (_label, imageTag) => {
    writeRegistry(8080, aliceImage);
    writeRegistry(8090, imageTag);

    await expect(collect()).rejects.toThrow(/invalid imageTag/);

    expect(mocks.dockerRmi).not.toHaveBeenCalled();
  });

  it("keeps every image when confirmation is declined (#12582)", async () => {
    writeRegistry(8080, aliceImage);
    writeRegistry(8090, bobImage);

    await collect({});

    expect(mocks.prompt).toHaveBeenCalledOnce();
    expect(mocks.dockerRmi).not.toHaveBeenCalled();
  });

  it("refreshes sibling roots and image ownership after confirmation (#12582)", async () => {
    writeRegistry(8080, aliceImage);
    mocks.prompt.mockImplementation(async () => {
      expect(fs.existsSync(path.join(home, ".nemoclaw", "sandboxes.json.lock"))).toBe(false);
      expect(fs.existsSync(path.join(home, ".nemoclaw-portable-host.lock"))).toBe(false);
      // This tag was in the original orphan candidate list, but becomes live
      // in a newly-created sibling root while the user is deciding.
      writeRegistry(8090, orphanImage);
      return "y";
    });

    mocks.dockerRmi.mockImplementation(() => {
      expect(fs.existsSync(path.join(home, ".nemoclaw", "sandboxes.json.lock", "owner"))).toBe(
        true,
      );
      expect(
        fs.existsSync(
          path.join(home, ".nemoclaw", "gateways", "8090", "sandboxes.json.lock", "owner"),
        ),
      ).toBe(true);
      return { status: 0, stdout: "", stderr: "" };
    });
    await collect({});

    expect(mocks.dockerRmi).toHaveBeenCalledOnce();
    expect(mocks.dockerRmi.mock.calls[0]?.[0]).toBe(bobImage);
    expect(mocks.dockerListImagesFormat.mock.calls.map(([repo]) => repo)).toEqual([
      ...SANDBOX_IMAGE_REPOS,
      ...SANDBOX_IMAGE_REPOS,
    ]);
    expect(fs.existsSync(path.join(home, ".nemoclaw-portable-host.lock"))).toBe(false);
  });

  it("refuses deletion when sibling state becomes unsafe during confirmation (#12582)", async () => {
    writeRegistry(8080, aliceImage);
    mocks.prompt.mockImplementation(async () => {
      fs.writeFileSync(writeRegistry(8090, bobImage), "{");
      return "y";
    });

    await expect(collect({})).rejects.toThrow(/gateway state/);

    expect(mocks.dockerRmi).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(home, ".nemoclaw", "sandboxes.json.lock"))).toBe(false);
    expect(
      fs.existsSync(path.join(home, ".nemoclaw", "gateways", "8090", "sandboxes.json.lock")),
    ).toBe(false);
  });

  it("reports Docker deletion failures after protecting registered images (#12582)", async () => {
    writeRegistry(8080, aliceImage);
    writeRegistry(8090, bobImage);
    mocks.dockerRmi.mockReturnValue({ status: 1, stdout: "", stderr: "image is in use" });

    await expect(collect()).rejects.toThrow("exit 1");

    expect(mocks.dockerRmi.mock.calls.map(([tag]) => tag)).toEqual([orphanImage]);
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain("image is in use");
  });
});
