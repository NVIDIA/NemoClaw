// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { withDockerManagedStartupReceiptVolume } from "./docker-receipt-volume";

const IMAGE = `sha256:${"a".repeat(64)}`;
const OPTIONS = { ignoreError: true };
const RECEIPT_DIRECTORY = "/run/nemoclaw/receipt";
const RECEIPT_PATH = "/private/tmp/nemoclaw-receipt/receipt";

describe("Docker managed-startup receipt volume", () => {
  it("uploads through a stopped seed and gives the helper a read-only daemon mount (#10348)", () => {
    const events: string[] = [];
    let seedName = "";
    let volumeName = "";
    const dockerRun = vi
      .fn()
      .mockImplementationOnce((args: readonly string[]) => {
        events.push("volume-create");
        volumeName = String(args[2]);
        return { status: 0, stdout: `${volumeName}\n` };
      })
      .mockImplementationOnce((args: readonly string[]) => {
        events.push("seed-create");
        seedName = String(args[2]);
        expect(args).toContain(
          `type=volume,src=${volumeName},dst=${RECEIPT_DIRECTORY},volume-nocopy`,
        );
        expect(args).toEqual(
          expect.arrayContaining([
            "--pull",
            "never",
            "--network",
            "none",
            "--security-opt",
            "no-new-privileges",
            "--cap-drop",
            "ALL",
          ]),
        );
        expect(args).not.toContain("--privileged");
        return { status: 0, stdout: `${"b".repeat(64)}\n` };
      })
      .mockImplementationOnce((args: readonly string[]) => {
        events.push("upload");
        expect(args).toEqual([
          "cp",
          "-a",
          `${RECEIPT_PATH}${path.sep}.`,
          `${seedName}:${RECEIPT_DIRECTORY}`,
        ]);
        return { status: 0 };
      })
      .mockImplementationOnce((args: readonly string[]) => {
        events.push("seed-remove");
        expect(args).toEqual(["rm", "-f", seedName]);
        return { status: 0 };
      })
      .mockImplementationOnce((args: readonly string[]) => {
        events.push("volume-remove");
        expect(args).toEqual(["volume", "rm", volumeName]);
        return { status: 0 };
      });

    expect(
      withDockerManagedStartupReceiptVolume(
        {
          image: IMAGE,
          options: OPTIONS,
          receiptDirectory: RECEIPT_DIRECTORY,
          receiptPath: RECEIPT_PATH,
        },
        { dockerRun },
        (mount) => {
          events.push("helper");
          expect(mount).toBe(
            `type=volume,src=${volumeName},dst=${RECEIPT_DIRECTORY},readonly,volume-nocopy`,
          );
          return "verified";
        },
      ),
    ).toBe("verified");
    expect(events).toEqual([
      "volume-create",
      "seed-create",
      "upload",
      "helper",
      "seed-remove",
      "volume-remove",
    ]);
  });

  it("removes daemon resources and keeps the helper closed when upload fails (#10348)", () => {
    const useReceiptMount = vi.fn();
    const dockerRun = vi
      .fn()
      .mockImplementationOnce(() => ({ status: 0 }))
      .mockImplementationOnce(() => ({ status: 0 }))
      .mockImplementationOnce(() => ({ status: 1, stderr: "upload failed" }))
      .mockImplementationOnce(() => ({ status: 0 }))
      .mockImplementationOnce(() => ({ status: 0 }));

    expect(() =>
      withDockerManagedStartupReceiptVolume(
        {
          image: IMAGE,
          options: OPTIONS,
          receiptDirectory: RECEIPT_DIRECTORY,
          receiptPath: RECEIPT_PATH,
        },
        { dockerRun },
        useReceiptMount,
      ),
    ).toThrow("Could not upload the managed-startup receipt into daemon storage");
    expect(useReceiptMount).not.toHaveBeenCalled();
    expect(dockerRun.mock.calls.at(-2)?.[0]?.slice(0, 2)).toEqual(["rm", "-f"]);
    expect(dockerRun.mock.calls.at(-1)?.[0]?.slice(0, 2)).toEqual(["volume", "rm"]);
  });

  it("removes daemon storage when the stopped seed cannot be created (#10348)", () => {
    const useReceiptMount = vi.fn();
    const dockerRun = vi
      .fn()
      .mockImplementationOnce(() => ({ status: 0 }))
      .mockImplementationOnce(() => ({ status: 1, stderr: "seed create failed" }))
      .mockImplementationOnce(() => ({ status: 0 }));

    expect(() =>
      withDockerManagedStartupReceiptVolume(
        {
          image: IMAGE,
          options: OPTIONS,
          receiptDirectory: RECEIPT_DIRECTORY,
          receiptPath: RECEIPT_PATH,
        },
        { dockerRun },
        useReceiptMount,
      ),
    ).toThrow("Could not create the managed-startup receipt transfer container");
    expect(useReceiptMount).not.toHaveBeenCalled();
    expect(dockerRun).toHaveBeenCalledTimes(3);
    expect(dockerRun.mock.calls.at(-1)?.[0]?.slice(0, 2)).toEqual(["volume", "rm"]);
  });

  it("fails a completed helper when protected daemon storage cannot be removed (#10348)", () => {
    const dockerRun = vi
      .fn()
      .mockImplementationOnce(() => ({ status: 0 }))
      .mockImplementationOnce(() => ({ status: 0 }))
      .mockImplementationOnce(() => ({ status: 0 }))
      .mockImplementationOnce(() => ({ status: 0 }))
      .mockImplementationOnce(() => ({ status: 1, stderr: "volume is still in use" }));

    expect(() =>
      withDockerManagedStartupReceiptVolume(
        {
          image: IMAGE,
          options: OPTIONS,
          receiptDirectory: RECEIPT_DIRECTORY,
          receiptPath: RECEIPT_PATH,
        },
        { dockerRun },
        () => "verified",
      ),
    ).toThrow(/receipt cleanup failed.*volume is still in use/u);
  });
});
