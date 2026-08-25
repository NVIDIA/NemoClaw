// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMock = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));
vi.mock("node:child_process", () => childProcessMock);

import { mockRootReplayFilesystem } from "../../../test/helpers/managed-startup-root-replay-filesystem";
import { PEM } from "./__test-helpers__/corporate-ca-fixtures";
import { installCorporateCaSystemAnchors } from "./managed-startup/image-runtime";

const ANCHOR_DIRECTORY = "/usr/local/share/ca-certificates";
const CORPORATE_CA_FILE = "/var/lib/nemoclaw/corporate-ca-source.pem";
const SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
const UPDATE_CA_CERTIFICATES = "/usr/sbin/update-ca-certificates";

describe("managed startup system CA trust", () => {
  beforeEach(() => {
    childProcessMock.spawnSync.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("installs each corporate certificate before refreshing system trust (#9360)", () => {
    let filesystem: ReturnType<typeof mockRootReplayFilesystem>;
    childProcessMock.spawnSync.mockImplementation(() => {
      filesystem.writeFile(SYSTEM_CA_BUNDLE, PEM, 0o444);
      return { error: undefined, status: 0 };
    });
    filesystem = mockRootReplayFilesystem(
      [],
      new Map([
        [CORPORATE_CA_FILE, { contents: `${PEM}${PEM}`, mode: 0o444 }],
        [SYSTEM_CA_BUNDLE, { contents: PEM, mode: 0o444 }],
        [UPDATE_CA_CERTIFICATES, { contents: "executable", mode: 0o555 }],
      ]),
    );

    installCorporateCaSystemAnchors(CORPORATE_CA_FILE);

    expect(filesystem.readFile(`${ANCHOR_DIRECTORY}/nemoclaw-corporate-ca-01.crt`)).toBe(PEM);
    expect(filesystem.readFile(`${ANCHOR_DIRECTORY}/nemoclaw-corporate-ca-02.crt`)).toBe(PEM);
    expect(childProcessMock.spawnSync).toHaveBeenCalledWith(
      UPDATE_CA_CERTIFICATES,
      [],
      expect.objectContaining({
        env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
        stdio: "inherit",
      }),
    );
  });

  it("removes stale managed anchors and refreshes system trust when the profile has no CA (#9360)", () => {
    const anchor = `${ANCHOR_DIRECTORY}/nemoclaw-corporate-ca-01.crt`;
    const filesystem = mockRootReplayFilesystem(
      [],
      new Map([
        [anchor, { contents: PEM, mode: 0o444 }],
        [SYSTEM_CA_BUNDLE, { contents: PEM, mode: 0o444 }],
        [UPDATE_CA_CERTIFICATES, { contents: "executable", mode: 0o555 }],
      ]),
    );
    childProcessMock.spawnSync.mockReturnValue({ error: undefined, status: 0 });

    installCorporateCaSystemAnchors(null);

    expect(filesystem.hasFile(anchor)).toBe(false);
    expect(childProcessMock.spawnSync).toHaveBeenCalledOnce();
  });

  it("refreshes system trust again after stale-anchor cleanup previously failed (#9360)", () => {
    const anchor = `${ANCHOR_DIRECTORY}/nemoclaw-corporate-ca-01.crt`;
    const filesystem = mockRootReplayFilesystem(
      [],
      new Map([
        [anchor, { contents: PEM, mode: 0o444 }],
        [SYSTEM_CA_BUNDLE, { contents: PEM, mode: 0o444 }],
        [UPDATE_CA_CERTIFICATES, { contents: "executable", mode: 0o555 }],
      ]),
    );
    childProcessMock.spawnSync
      .mockReturnValueOnce({ error: undefined, status: 1 })
      .mockReturnValueOnce({ error: undefined, status: 0 });

    expect(() => installCorporateCaSystemAnchors(null)).toThrow(/exited with status 1/u);
    expect(filesystem.hasFile(anchor)).toBe(false);

    installCorporateCaSystemAnchors(null);

    expect(childProcessMock.spawnSync).toHaveBeenCalledTimes(2);
  });

  it("rejects an unsafe managed system CA anchor directory before cleanup (#9360)", () => {
    const filesystem = mockRootReplayFilesystem(
      [],
      new Map([
        [SYSTEM_CA_BUNDLE, { contents: PEM, mode: 0o444 }],
        [UPDATE_CA_CERTIFICATES, { contents: "executable", mode: 0o555 }],
      ]),
    );
    filesystem.chmodDirectory(ANCHOR_DIRECTORY, 0o777);

    expect(() => installCorporateCaSystemAnchors(null)).toThrow(/root:root directory/u);
    expect(childProcessMock.spawnSync).not.toHaveBeenCalled();
  });

  it("rejects a symlinked managed system CA anchor directory before cleanup (#9360)", () => {
    const filesystem = mockRootReplayFilesystem(
      [],
      new Map([
        [SYSTEM_CA_BUNDLE, { contents: PEM, mode: 0o444 }],
        [UPDATE_CA_CERTIFICATES, { contents: "executable", mode: 0o555 }],
      ]),
    );
    filesystem.markDirectorySymlink(ANCHOR_DIRECTORY);

    expect(() => installCorporateCaSystemAnchors(null)).toThrow(/root:root directory/u);
    expect(childProcessMock.spawnSync).not.toHaveBeenCalled();
  });

  it("fails when refreshed system trust omits the corporate CA (#9360)", () => {
    const filesystem = mockRootReplayFilesystem(
      [],
      new Map([
        [CORPORATE_CA_FILE, { contents: PEM, mode: 0o444 }],
        [SYSTEM_CA_BUNDLE, { contents: PEM, mode: 0o444 }],
        [UPDATE_CA_CERTIFICATES, { contents: "executable", mode: 0o555 }],
      ]),
    );
    childProcessMock.spawnSync.mockImplementation(() => {
      filesystem.writeFile(SYSTEM_CA_BUNDLE, "not a CA bundle\n", 0o444);
      return { error: undefined, status: 0 };
    });

    expect(() => installCorporateCaSystemAnchors(CORPORATE_CA_FILE)).toThrow(
      /does not contain the corporate CA/u,
    );
  });
});
