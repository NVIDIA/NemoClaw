// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const installer = path.resolve(import.meta.dirname, "../../../agents/hermes/install-switchyard.py");

// Synthetic archives exercise the verifier without downloading or loading native code.
// Only the release digests are substituted; all validation and installation use production code.
const fixture = String.raw`
import hashlib, importlib.util, io, json, stat, sys, tarfile, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("installer", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
case = json.loads(sys.argv[2])
arch = case.get("arch", "x86_64")
machine = 183 if arch == "aarch64" else 62
library = bytearray(64)
library[:7] = b"\x7fELF\x02\x01\x01"
library[16:18] = (3).to_bytes(2, "little")
library[18:20] = machine.to_bytes(2, "little")
if case.get("elf") == "architecture": library[18:20] = (40).to_bytes(2, "little")
if case.get("elf") == "format": library[:4] = b"MACH"
if case.get("elf") == "class": library[4] = 1
if case.get("elf") == "type": library[16:18] = (2).to_bytes(2, "little")
library = bytes(library)
library_digest = hashlib.sha256(library).hexdigest()
manifest = f'''manifest_version = 1
[plugin]
id = "nvidia.switchyard"
kind = "rust_dynamic"
[compat]
relay = ">=0.8.0, <1.0.0"
native_api = "1"
[defaults]
enabled = false
[capabilities]
items = ["plugin_native", "config_schema"]
[config_schema]
path = "config.schema.json"
[source]
artifact = "libswitchyard_nemo_relay_plugin.so"
[integrity]
sha256 = "sha256:{library_digest}"
[load]
library = "libswitchyard_nemo_relay_plugin.so"
symbol = "nemo_relay_register_plugin"
'''
if "replace" in case: manifest = manifest.replace(*case["replace"])
files = {name: ("notice: " + name).encode() for name in (
    "LICENSE", "NOTICE", "ATTRIBUTIONS-Rust.md", "THIRD_PARTY_NOTICES.md",
    "notices/protocol/LICENSE", "notices/protocol/NOTICE",
    "notices/switchyard-translation/LICENSE", "notices/switchyard-translation/NOTICE")}
files.update({"relay-plugin.toml": manifest.encode(), "config.schema.json": b'{"type":"object"}',
              "libswitchyard_nemo_relay_plugin.so": library})
if "missing" in case: del files[case["missing"]]
if case.get("schema"): files["config.schema.json"] = b'{broken'
if case.get("library_digest"): files["libswitchyard_nemo_relay_plugin.so"] += b'corrupt'
with tempfile.TemporaryDirectory() as directory:
    archive = Path(directory) / "release.tar.gz"
    destination = Path(directory) / "installed"
    with tarfile.open(archive, "w:gz") as bundle:
        for name, data in files.items():
            member = tarfile.TarInfo("switchyard-plugin/" + name)
            member.size = len(data)
            member.mode = 0o777
            bundle.addfile(member, io.BytesIO(data))
        if "member" in case:
            member = tarfile.TarInfo(case["member"])
            kind = case.get("kind")
            if kind in ("symlink", "hardlink"):
                member.type = tarfile.SYMTYPE if kind == "symlink" else tarfile.LNKTYPE
                member.linkname = "../../outside"
            bundle.addfile(member, io.BytesIO(b""))
    module.RELEASES["x86_64" if arch == "unsupported" else arch] = {
        "archive": "0" * 64 if case.get("archive_digest") else hashlib.sha256(archive.read_bytes()).hexdigest(),
        "library": library_digest, "machine": machine}
    try:
        module.install(archive, destination, arch, case.get("hermes", "0.21.3"), case.get("relay", "0.8.3"))
    except (ValueError, json.JSONDecodeError) as error:
        assert not destination.exists(), "validation must precede all destination writes"
        print(json.dumps({"error": str(error)}))
    else:
        actual = {str(p.relative_to(destination)): p.read_bytes() for p in destination.rglob("*") if p.is_file()}
        assert actual == files
        assert all(stat.S_IMODE(p.stat().st_mode) == (0o755 if p.is_dir() else 0o444)
                   for p in [destination, *destination.rglob("*")])
        print(json.dumps({"installed": sorted(actual)}))
`;

function runFixture(options: Record<string, unknown>) {
  const result = spawnSync("python3", ["-I", "-c", fixture, installer, JSON.stringify(options)], {
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { error?: string; installed?: string[] };
}

describe("released Switchyard package validation (#13861)", () => {
  it.each(["x86_64", "aarch64"])(
    "installs the complete disabled bundle read-only for %s",
    (arch) => {
      const result = runFixture({ arch });
      expect(result.error).toBeUndefined();
      expect(result.installed).toHaveLength(11);
      expect(result.installed).toContain("notices/switchyard-translation/NOTICE");
    },
  );

  it.each([
    ["archive digest", { archive_digest: true }, "archive digest mismatch"],
    ["library digest", { library_digest: true }, "library digest mismatch"],
    ["unsupported architecture", { arch: "unsupported" }, "unsupported Switchyard architecture"],
    ["Hermes version", { hermes: "0.22.4" }, "reviewed Hermes"],
    ["Relay version", { relay: "0.10.0" }, "reviewed Hermes"],
    [
      "plugin ID",
      { replace: ['id = "nvidia.switchyard"', 'id = "foreign"'] },
      "incompatible Switchyard manifest",
    ],
    [
      "native API",
      { replace: ['native_api = "1"', 'native_api = "2"'] },
      "incompatible Switchyard manifest",
    ],
    [
      "Relay range",
      { replace: [">=0.8.0, <1.0.0", ">=0.10.0"] },
      "incompatible Switchyard manifest",
    ],
    [
      "enabled default",
      { replace: ["enabled = false", "enabled = true"] },
      "incompatible Switchyard manifest",
    ],
    [
      "load symbol",
      { replace: ["nemo_relay_register_plugin", "other_symbol"] },
      "incompatible Switchyard manifest",
    ],
    ["ELF architecture", { elf: "architecture" }, "expected Linux ELF"],
    ["non-ELF library", { elf: "format" }, "expected Linux ELF"],
    ["32-bit library", { elf: "class" }, "expected Linux ELF"],
    ["executable instead of shared object", { elf: "type" }, "expected Linux ELF"],
    ["missing schema", { missing: "config.schema.json" }, "incomplete Switchyard bundle"],
    ["missing notice", { missing: "notices/protocol/NOTICE" }, "incomplete Switchyard bundle"],
    ["extra file", { member: "switchyard-plugin/extra" }, "unsafe or unexpected"],
    ["path traversal", { member: "switchyard-plugin/../../outside" }, "unsafe or unexpected"],
    ["absolute path", { member: "/outside" }, "unsafe or unexpected"],
    ["symlink", { member: "switchyard-plugin/link", kind: "symlink" }, "unsafe or unexpected"],
    ["hard link", { member: "switchyard-plugin/link", kind: "hardlink" }, "unsafe or unexpected"],
    [
      "duplicate member",
      { member: "switchyard-plugin/LICENSE" },
      "duplicate Switchyard archive member",
    ],
  ] as const)("rejects %s before installation", (_name, options, error) => {
    expect(runFixture(options).error).toContain(error);
  });

  it("rejects a malformed schema before installation", () => {
    expect(runFixture({ schema: true }).error).toBeDefined();
  });
});
