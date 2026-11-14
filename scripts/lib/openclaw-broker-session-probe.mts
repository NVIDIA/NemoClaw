// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES.
// SPDX-License-Identifier: Apache-2.0

// OpenShell 0.1.7 denies process-group signals, including signal-zero probes.
// A detached broker or child owns a private POSIX session.
// Keep native signalling and cleanup failures; replace only its absence probe.
// Remove this bridge when the pinned OpenClaw runtime supports that boundary.
export const BROKER_SESSION_PROBE_SOURCE = String.raw`
function nemoclawPrivateBrokerSessionGone(sessionId) {
  if (!Number.isSafeInteger(sessionId) || sessionId <= 1 || sessionId === process.pid)
    throw new Error("Invalid private broker session identity");
  const fs = process.getBuiltinModule("node:fs");
  const started = performance.now();
  const checkBudget = () => {
    if (performance.now() - started > 250)
      throw new Error("Private broker session inventory exceeded its bound");
  };
  const readBounded = (file, maxBytes) => {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const bytes = Buffer.alloc(maxBytes + 1);
      let size = 0;
      for (;;) {
        checkBudget();
        const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
        size += count;
        if (size > maxBytes) throw new Error("Private broker session inventory exceeded its size bound");
        if (count === 0) return bytes.subarray(0, size).toString("utf8");
      }
    } finally { fs.closeSync(fd); }
  };
  // NSpid is relative to the namespace that owns this procfs mount. A single
  // matching ID proves the view without reading another user's namespace link.
  if (fs.statfsSync("/proc").type !== 0x9fa0)
    throw new Error("Private broker session inventory requires procfs");
  const namespaceRows = readBounded("/proc/self/status", 65536).split("\n").filter((line) => line.startsWith("NSpid:"));
  if (namespaceRows.length !== 1 || namespaceRows[0].trim() !== "NSpid:\t" + process.pid)
    throw new Error("Private broker session inventory has the wrong PID namespace");
  const mounts = readBounded("/proc/self/mountinfo", 262144).split("\n").filter((line) => line.split(" ")[4] === "/proc");
  if (mounts.length !== 1) throw new Error("Ambiguous private broker procfs mount");
  const mount = mounts[0].split(" - ");
  const fields = mount[0].split(" ");
  const filesystem = mount[1]?.split(" ");
  if (fields[3] !== "/" || filesystem?.[0] !== "proc" || !filesystem[2])
    throw new Error("Incomplete private broker procfs mount");
  if ((fields[5] + "," + filesystem[2]).split(",").some((option) => option.startsWith("hidepid=") && option !== "hidepid=0" && option !== "hidepid=off"))
    throw new Error("Private broker procfs mount hides processes");
  const forks = () => {
    const rows = readBounded("/proc/stat", 262144).split("\n").filter((line) => line.startsWith("processes "));
    if (rows.length !== 1 || !/^processes [0-9]+$/.test(rows[0]))
      throw new Error("Private broker session inventory has no fork generation");
    return BigInt(rows[0].slice(10));
  };
  const before = forks();
  let entries = 0;
  const directory = fs.opendirSync("/proc");
  try {
    for (;;) {
      checkBudget();
      const entry = directory.readSync();
      if (!entry) break;
      if (++entries > 8192) throw new Error("Private broker session inventory exceeded its entry bound");
      if (!/^[1-9][0-9]*$/.test(entry.name)) continue;
      const pid = Number(entry.name);
      if (!Number.isSafeInteger(pid)) throw new Error("Invalid procfs process identity");
      let stat;
      try { stat = readBounded("/proc/" + entry.name + "/stat", 65536); }
      catch (error) { if (error?.code === "ENOENT" || error?.code === "ESRCH") continue; throw error; }
      const end = stat.lastIndexOf(")");
      if (!stat.startsWith(entry.name + " (") || end < entry.name.length + 2)
        throw new Error("Malformed procfs process identity");
      const fields = stat.slice(end + 1).trim().split(/\s+/);
      if (fields.length < 20 || !/^[A-Za-z]$/.test(fields[0]) || !/^[0-9]+$/.test(fields[3]))
        throw new Error("Malformed procfs process session");
      const observedSession = Number(fields[3]);
      if (!Number.isSafeInteger(observedSession)) throw new Error("Invalid procfs process session");
      if (observedSession === sessionId) return false;
    }
  } finally { directory.closeSync(); }
  checkBudget();
  // An existing process cannot join another POSIX session. New members require
  // a fork, so a changed kernel fork counter invalidates an empty inventory.
  // A busy, unreadable or incomplete inventory never establishes absence.
  return forks() === before;
}
`;
