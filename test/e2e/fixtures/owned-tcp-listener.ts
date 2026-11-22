// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

/** Prove a Linux child owns the configured loopback listener, independently of HTTP health. */
export function hasOwnedLoopbackTcpListener(
  pid: number | undefined,
  port: number,
  procRoot = "/proc",
): boolean {
  if (!Number.isSafeInteger(pid) || Number(pid) < 1) return false;
  const endpoint = `0100007F:${port.toString(16).toUpperCase().padStart(4, "0")}`;
  try {
    const directory = path.join(procRoot, String(pid), "fd");
    const descriptors = new Set(
      fs.readdirSync(directory).map((entry) => fs.readlinkSync(path.join(directory, entry))),
    );
    return fs
      .readFileSync(path.join(procRoot, "net", "tcp"), "utf8")
      .split("\n")
      .slice(1)
      .some((line) => {
        const fields = line.trim().split(/\s+/u);
        return (
          fields[1] === endpoint && fields[3] === "0A" && descriptors.has(`socket:[${fields[9]}]`)
        );
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
