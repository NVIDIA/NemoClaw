# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Build the pinned ARM64 OpenSSL SDK for the unchanged Hermes Python lock."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tarfile
import time
import urllib.request
import zipfile


def digest(file):
    with Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(file, value):
    with Path(file).open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")


def download(item, directory):
    file = directory / item["file"]
    if file.name != item["file"] or not item["url"].startswith("https://"):
        raise ValueError("Invalid pinned OpenSSL build input")
    started = time.monotonic()
    size = 0
    with (
        urllib.request.urlopen(item["url"], timeout=30) as response,
        file.open("xb") as output,
    ):
        while block := response.read(1024 * 1024):
            size += len(block)
            if size > item["size"] or time.monotonic() - started > 300:
                raise ValueError("A build input exceeded its byte/time bound")
            output.write(block)
    if size != item["size"] or digest(file) != item["sha256"]:
        raise ValueError("A pinned OpenSSL build input differs from its hash/size")
    return file


def extract(archive, target):
    target.mkdir()
    count = 0
    total = 0

    def output(name, size):
        nonlocal count, total
        parts = name.replace("\\", "/").split("/")
        if (
            name.startswith(("/", "\\"))
            or ".." in parts
            or any(":" in p for p in parts)
        ):
            raise ValueError("Build archive path escapes its fresh root")
        count += 1
        total += size
        if count > 100000 or total > 4 * 1024**3:
            raise ValueError("Build archive exceeds its extraction bound")
        return target.joinpath(*parts)

    if archive.name.endswith(".zip"):
        with zipfile.ZipFile(archive) as handle:
            for entry in handle.infolist():
                file = output(entry.filename, entry.file_size)
                if entry.is_dir():
                    file.mkdir(parents=True, exist_ok=True)
                else:
                    if (entry.external_attr >> 16) & 0o170000 == 0o120000:
                        raise ValueError("Build archive contains a symbolic link")
                    file.parent.mkdir(parents=True, exist_ok=True)
                    with handle.open(entry) as source, file.open("xb") as sink:
                        shutil.copyfileobj(source, sink)
    else:
        with tarfile.open(archive, "r:gz") as handle:
            for entry in handle:
                file = output(entry.name, entry.size)
                if entry.isdir():
                    file.mkdir(parents=True, exist_ok=True)
                elif entry.isfile():
                    file.parent.mkdir(parents=True, exist_ok=True)
                    with handle.extractfile(entry) as source, file.open("xb") as sink:
                        shutil.copyfileobj(source, sink)
                else:
                    raise ValueError("Build archive contains a non-file entry")


def windows_taskkill(environment):
    # os.environ is case-insensitive on Windows, but its copy() is a plain
    # dictionary with uppercase keys. Accept the same Windows key identity.
    roots = {
        value for name, value in environment.items() if name.upper() == "SYSTEMROOT"
    }
    if len(roots) != 1:
        raise ValueError("Windows process cleanup requires one unambiguous SystemRoot")
    root = roots.pop()
    if not root or not Path(root).is_absolute():
        raise ValueError("Windows process cleanup requires an absolute SystemRoot")
    return Path(root) / "System32" / "taskkill.exe"


def run(executable, args, cwd, environment, evidence, label, timeout):
    started = time.monotonic()
    process = None
    primary = None
    cleanup = []
    stdout = evidence / (label + ".stdout.log")
    stderr = evidence / (label + ".stderr.log")
    print("[OpenSSL prerequisite] " + label, flush=True)
    with stdout.open("xb") as out, stderr.open("xb") as err:
        try:
            killer = windows_taskkill(environment) if os.name == "nt" else None
            process = subprocess.Popen(
                [str(executable), *map(str, args)],
                cwd=cwd,
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=err,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            while True:
                try:
                    code = process.wait(
                        timeout=min(
                            15, max(0.1, timeout - (time.monotonic() - started))
                        )
                    )
                    break
                except subprocess.TimeoutExpired:
                    elapsed = time.monotonic() - started
                    print(f"[OpenSSL prerequisite] {label}: {elapsed:.0f}s", flush=True)
                    if (
                        elapsed >= timeout
                        or os.fstat(out.fileno()).st_size
                        + os.fstat(err.fileno()).st_size
                        > 64 * 1024**2
                    ):
                        raise TimeoutError(
                            "OpenSSL prerequisite exceeded its owned execution/output bound"
                        )
            if (
                code == 0
                and os.fstat(out.fileno()).st_size + os.fstat(err.fileno()).st_size
                > 64 * 1024**2
            ):
                raise ValueError(
                    "OpenSSL prerequisite exceeded its diagnostic output bound"
                )
            if code != 0:
                raise RuntimeError(f"OpenSSL prerequisite {label} exited {code}")
        except BaseException as error:
            primary = error
        finally:
            if process is not None and process.poll() is None:
                try:
                    if os.name == "nt":
                        subprocess.run(
                            [
                                str(killer),
                                "/PID",
                                str(process.pid),
                                "/T",
                                "/F",
                            ],
                            env=environment,
                            stdout=err,
                            stderr=err,
                            timeout=10,
                            check=True,
                        )
                    else:
                        process.kill()
                    process.wait(timeout=10)
                except Exception as error:
                    cleanup.append(str(error))
    result = {
        "label": label,
        "executable": str(executable),
        "arguments": list(map(str, args)),
        "elapsedSeconds": time.monotonic() - started,
        "processId": None if process is None else process.pid,
        "exitCode": None if process is None else process.poll(),
        "cleanupFailures": cleanup,
        "passed": primary is None and not cleanup,
    }
    try:
        write_json(evidence / (label + ".process.json"), result)
    except Exception as error:
        if primary is None:
            raise
        primary.add_note("Receipt also failed: " + str(error))
    if primary is not None:
        raise primary
    if cleanup:
        raise RuntimeError("OpenSSL build did not confirm owned cleanup")
    return result


def pe_machine(file):
    with Path(file).open("rb") as stream:
        header = stream.read(64)
        if len(header) != 64 or header[:2] != b"MZ":
            raise ValueError("A build tool is not a PE executable")
        offset = struct.unpack_from("<I", header, 60)[0]
        if offset > Path(file).stat().st_size - 6:
            raise ValueError("A PE header is outside the executable")
        stream.seek(offset)
        pe = stream.read(6)
        if pe[:4] != b"PE\0\0":
            raise ValueError("A build executable has an invalid PE signature")
        return hex(struct.unpack_from("<H", pe, 4)[0])


def verify_static_arm64_library(file):
    """Require COFF objects, not an import library or a foreign-architecture SDK."""
    objects = 0
    with Path(file).open("rb") as handle:
        if handle.read(8) != b"!<arch>\n":
            raise ValueError("Expected a COFF archive")
        while header := handle.read(60):
            if len(header) != 60 or header[58:] != b"`\n":
                raise ValueError("Invalid COFF member header")
            size = int(header[48:58])
            if size < 0 or size > 256 * 1024**2:
                raise ValueError("COFF member exceeds its byte bound")
            name = header[:16].decode("ascii").strip()
            data = handle.read(size)
            if len(data) != size:
                raise ValueError("Incomplete COFF archive member")
            if size % 2 and handle.read(1) != b"\n":
                raise ValueError("Missing COFF member alignment")
            if name in ("/", "//"):
                continue
            if len(data) < 20:
                raise ValueError("Invalid COFF object")
            machine = struct.unpack_from("<H", data)[0]
            if data[:4] == b"\0\0\xff\xff":
                version, machine = struct.unpack_from("<HH", data, 4)
                if version < 2:
                    raise ValueError(
                        "A dynamic import library cannot substitute for static OpenSSL"
                    )
            if machine != 0xAA64:
                raise ValueError("OpenSSL contains a non-ARM64 object")
            objects += 1
    if objects == 0:
        raise ValueError("OpenSSL library has no ARM64 objects")
    return {
        "sha256": digest(file),
        "bytes": Path(file).stat().st_size,
        "arm64Objects": objects,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-directory", type=Path, required=True)
    parser.add_argument("--compiler-directory", type=Path, required=True)
    parser.add_argument("--build-tool-path", action="append", default=[], type=Path)
    parser.add_argument(
        "--lock",
        type=Path,
        default=Path(__file__).with_name("official-openssl.lock.json"),
    )
    args = parser.parse_args()
    if os.name != "nt":
        raise ValueError(
            "The OpenSSL SDK requires the selected native Windows ARM64 compiler"
        )
    root = args.artifact_directory.resolve()
    root.mkdir(parents=True, exist_ok=False)
    lock = json.loads(args.lock.read_text(encoding="utf-8"))
    if (
        lock["schemaVersion"] != 1
        or lock["upstreamHermes"] != "2237be355906fbe6065ce1815711eee52b2d646e"
        or lock["opensslVersion"] != "3.5.8"
        or lock["target"] != "VC-WIN64-ARM"
    ):
        raise ValueError("Unexpected official OpenSSL prerequisite identity")
    receipt = {
        "schemaVersion": 1,
        "classification": "official-hermes-openssl-build-prerequisite",
        "status": "failed",
        "completeRuntime": False,
        "installedAcceptance": False,
        "opensslVersion": lock["opensslVersion"],
        "inputLockSha256": digest(args.lock),
        "sourceAuthority": lock["sourceAuthority"],
        "configuration": lock["configuration"],
        "static": True,
        "stages": [],
        "artifacts": lock["artifacts"],
    }
    try:
        downloads = root / "downloads"
        downloads.mkdir()
        for item in lock["artifacts"]:
            print("[OpenSSL prerequisite] Downloading " + item["id"], flush=True)
            extract(download(item, downloads), root / item["id"])
            if "executable" in item:
                expected = item["executable"]
                executable = root / item["id"] / expected["path"]
                if (
                    executable.stat().st_size != expected["bytes"]
                    or digest(executable) != expected["sha256"]
                    or pe_machine(executable) != expected["machine"]
                ):
                    raise ValueError(
                        "A pinned build executable differs from its verified archive member"
                    )
        compiler = args.compiler_directory.resolve(strict=True)
        for name in ("cl.exe", "link.exe", "lib.exe", "nmake.exe"):
            if (
                not (compiler / name).is_file()
                or pe_machine(compiler / name) != "0xaa64"
            ):
                raise ValueError("The selected native MSVC tool is missing")
        receipt["compilerTools"] = [
            {"name": name, "sha256": digest(compiler / name)}
            for name in ("cl.exe", "link.exe", "lib.exe", "nmake.exe")
        ]
        allowed = (
            "SystemRoot",
            "SystemDrive",
            "WINDIR",
            "COMSPEC",
            "OS",
            "TEMP",
            "TMP",
            "INCLUDE",
            "LIB",
            "LIBPATH",
            "VCINSTALLDIR",
            "VCToolsInstallDir",
            "WindowsSdkDir",
            "WindowsSDKVersion",
            "WindowsSdkVerBinPath",
            "UniversalCRTSdkDir",
            "UCRTVersion",
            "PROCESSOR_ARCHITECTURE",
            "NUMBER_OF_PROCESSORS",
            "RUNNER_TRACKING_ID",
        )
        environment = {name: os.environ[name] for name in allowed if name in os.environ}
        perl = root / "strawberryperl/perl/bin/perl.exe"
        nasm = root / "nasm-windows-bin/nasm-2.16.03"
        jom = root / "jom-windows-bin/jom.exe"
        if not perl.is_file() or not jom.is_file() or not (nasm / "nasm.exe").is_file():
            raise ValueError("An exact pinned build tool is missing")
        environment.update(
            PATH=os.pathsep.join(
                map(
                    str,
                    [
                        compiler,
                        perl.parent,
                        nasm,
                        jom.parent,
                        *[p.resolve(strict=True) for p in args.build_tool_path],
                        Path(environment["SystemRoot"]) / "System32",
                        Path(environment["SystemRoot"]),
                    ],
                )
            ),
            PATHEXT=".COM;.EXE;.BAT;.CMD",
            CL="/FS",
        )
        source = root / "openssl" / ("openssl-" + lock["opensslVersion"])
        receipt["buildTools"] = [
            {"path": str(p.relative_to(root)), "sha256": digest(p)}
            for p in (perl, nasm / "nasm.exe", jom)
        ]
        for executable, arguments, label, timeout in [
            (perl, ["-v"], "perl-version", 30),
            (
                perl,
                ["Configure", *lock["configuration"], lock["target"]],
                "configure",
                120,
            ),
            (jom, ["/J", "4"], "compile-static-libraries", 900),
        ]:
            receipt["stages"].append(
                run(executable, arguments, source, environment, root, label, timeout)
            )
        sdk = root / "sdk"
        sdk.mkdir()
        (sdk / "lib").mkdir()
        shutil.copytree(source / "include", sdk / "include")
        shutil.copyfile(source / "LICENSE.txt", sdk / "LICENSE.txt")
        receipt["libraries"] = {}
        for name in ("libcrypto.lib", "libssl.lib"):
            receipt["libraries"][name] = verify_static_arm64_library(source / name)
            shutil.copyfile(source / name, sdk / "lib" / name)
        receipt["files"] = [
            {
                "path": p.relative_to(sdk).as_posix(),
                "sha256": digest(p),
                "bytes": p.stat().st_size,
            }
            for p in sorted(sdk.rglob("*"))
            if p.is_file()
        ]
        receipt["sdkRoot"] = str(sdk)
        receipt["status"] = "sdk-built"
    except BaseException as error:
        receipt["error"] = str(error)
        raise
    finally:
        primary = sys.exception()
        try:
            write_json(root / "openssl-build.json", receipt)
        except Exception as error:
            if primary is None:
                raise
            primary.add_note("OpenSSL build receipt also failed: " + str(error))


if __name__ == "__main__":
    main()
