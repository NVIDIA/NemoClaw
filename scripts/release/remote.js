// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

function isCanonicalNemoClawRemote(remote) {
  if (/^git@github[.]com:NVIDIA\/NemoClaw(?:[.]git)?\/?$/iu.test(remote)) {
    return true;
  }
  try {
    const url = new URL(remote);
    const protocolAllowed =
      url.protocol === "https:" || (url.protocol === "ssh:" && url.username === "git");
    const repository = url.pathname
      .replace(/\/$/u, "")
      .replace(/[.]git$/iu, "")
      .toLowerCase();
    return (
      protocolAllowed &&
      url.hostname.toLowerCase() === "github.com" &&
      repository === "/nvidia/nemoclaw"
    );
  } catch {
    return false;
  }
}

module.exports = { isCanonicalNemoClawRemote };

if (require.main === module) {
  process.stdout.write(
    isCanonicalNemoClawRemote(process.argv[2] ?? "") ? "canonical" : "noncanonical",
  );
}
