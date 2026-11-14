# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Small synthetic minidump controls; no dump or Windows executable is executed."""

from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import tempfile
import time
import unittest


spec = importlib.util.spec_from_file_location(
    "chrome_minidump", Path(__file__).with_name("parse-chrome-minidump.py")
)
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)


class SyntheticDump:
    """Populate the documented structures and optional unused directory entries."""

    def __init__(self, *, misc_info=None, extra_streams=()):
        count = 4 + (misc_info is not None) + len(extra_streams)
        self.data = bytearray(32 + count * 12)
        self.offsets = {}
        self.directory = {}
        self.context = bytearray(1232)
        struct.pack_into("<I", self.context, 48, 0x100003)
        for index, register in enumerate(
            ("Rax", "Rcx", "Rdx", "Rbx", "Rsp", "Rbp", "Rsi", "Rdi")
            + tuple(f"R{i}" for i in range(8, 16))
            + ("Rip",)
        ):
            value = 0x30000000 if register == "Rsp" else 0x10000100 + index * 8
            struct.pack_into("<Q", self.context, 120 + index * 8, value)
        self.add("context", self.context)
        self.add(
            "stack", struct.pack("<140Q", *(0x10001000 + i * 8 for i in range(140)))
        )
        for name, path in (
            ("chrome_name", r"C:\private-user\owned-runtime\chrome.dll"),
            ("ntdll_name", r"C:\Windows\System32\ntdll.dll"),
        ):
            encoded = path.encode("utf-16-le")
            self.add(name, struct.pack("<I", len(encoded)) + encoded)

        system = bytearray(56)
        struct.pack_into("<H", system, 0, 9)
        modules = bytearray(4 + 2 * 108)
        struct.pack_into("<I", modules, 0, 2)
        for index, (base, name) in enumerate(
            ((0x10000000, "chrome_name"), (0x20000000, "ntdll_name"))
        ):
            offset = 4 + index * 108
            struct.pack_into("<QI", modules, offset, base, 0x10000)
            struct.pack_into("<I", modules, offset + 20, self.offsets[name])
        threads = bytearray(4 + 48)
        struct.pack_into("<II", threads, 0, 1, 77)
        struct.pack_into(
            "<QIIII",
            threads,
            4 + 24,
            0x30000000,
            140 * 8,
            self.offsets["stack"],
            1232,
            self.offsets["context"],
        )
        exception = bytearray(168)
        struct.pack_into("<I", exception, 0, 77)
        struct.pack_into("<II", exception, 8, 0xC0000008, 0x80)
        struct.pack_into("<Q", exception, 24, 0x20000180)
        struct.pack_into("<I", exception, 32, 2)
        struct.pack_into("<QQ", exception, 40, 0x11223344, 0)
        struct.pack_into("<II", exception, 160, 1232, self.offsets["context"])
        streams = [
            ("system", 7, system),
            ("modules", 4, modules),
            ("threads", 3, threads),
            ("exception", 6, exception),
        ]
        if misc_info is not None:
            streams.append(("misc", 15, misc_info))
        streams.extend(extra_streams)
        for index, (name, stream_type, content) in enumerate(streams):
            self.add(name, content)
            self.directory[name] = 32 + index * 12
            struct.pack_into(
                "<III",
                self.data,
                self.directory[name],
                stream_type,
                len(content),
                self.offsets[name],
            )
        struct.pack_into(
            "<IIIIIIQ", self.data, 0, 0x504D444D, 0xA793, count, 32, 0, 1700000123, 0
        )

    def add(self, name, content):
        self.data.extend(bytes((-len(self.data)) % 8))
        self.offsets[name] = len(self.data)
        self.data.extend(content)

    def set(self, format_, offset, *values):
        struct.pack_into(format_, self.data, offset, *values)


class MinidumpParser(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.path = self.root / "owned-crash.dmp"

    def parse(self, fixture):
        self.path.write_bytes(fixture.data)
        return owner.parse_minidump(self.path)

    def test_amd64_context_module_mapping_bounded_stack_and_private_data(self):
        fixture = SyntheticDump(
            misc_info=struct.pack("<6I", 24, 3, 2468, 1700000000, 0, 0)
        )
        output = io.StringIO()
        with redirect_stdout(output):
            result = self.parse(fixture)
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(
            result["file"],
            {
                "name": self.path.name,
                "bytes": len(fixture.data),
                "sha256": hashlib.sha256(fixture.data).hexdigest(),
            },
        )
        self.assertEqual(result["systemInfo"]["processorArchitecture"], 9)
        self.assertEqual(result["headerTimeDateStamp"], 1700000123)
        self.assertEqual(
            result["miscInfo"],
            {
                "sizeOfInfo": 24,
                "flags1": "0x3",
                "processId": 2468,
                "processCreateTime": 1700000000,
            },
        )
        self.assertEqual(result["exception"]["threadId"], 77)
        self.assertEqual(int(result["exception"]["code"], 16), 0xC0000008)
        self.assertEqual(int(result["exception"]["flags"], 16), 0x80)
        self.assertEqual(
            [int(value, 16) for value in result["exception"]["information"]],
            [0x11223344, 0],
        )
        self.assertEqual(result["exception"]["location"]["module"], "ntdll.dll")
        self.assertEqual(int(result["exception"]["location"]["rva"], 16), 0x180)
        self.assertEqual(
            [module["name"] for module in result["modules"]],
            ["chrome.dll", "ntdll.dll"],
        )
        self.assertEqual(result["context"]["status"], "amd64")
        self.assertEqual(result["context"]["bytes"], 1232)
        self.assertEqual(int(result["context"]["registers"]["Rsp"], 16), 0x30000000)
        self.assertEqual(int(result["context"]["registers"]["Rip"], 16), 0x10000180)
        stack = result["stack"]
        self.assertFalse(stack["unwound"])
        self.assertLessEqual(stack["scannedWords"], 128)
        self.assertEqual(len(stack["candidates"]), 16)
        self.assertEqual(stack["candidates"][0]["stackOffsetBytes"], 0)
        self.assertEqual(int(stack["candidates"][0]["rva"], 16), 0x1000)
        self.assertNotIn("private-user", json.dumps(result))
        self.assertNotIn("owned-runtime", json.dumps(result))
        self.assertNotIn(str(self.root), json.dumps(result))
        for flags in (0, 1, 2, 8):
            with self.subTest(misc_flags=flags):
                result = self.parse(
                    SyntheticDump(
                        misc_info=struct.pack("<6I", 24, flags, 2468, 1700000000, 0, 0)
                    )
                )
                self.assertEqual(int(result["miscInfo"]["flags1"], 16), flags)
                self.assertEqual(
                    result["miscInfo"]["processId"], 2468 if flags & 1 else None
                )
                self.assertEqual(
                    result["miscInfo"]["processCreateTime"],
                    1700000000 if flags & 2 else None,
                )
        for stream_type in (0, 16, 0x10000):
            with self.subTest(repeated_unused_stream=stream_type):
                fixture = SyntheticDump(
                    extra_streams=(
                        ("unused1", stream_type, b"unused-one"),
                        ("unused2", stream_type, b"unused-two"),
                    )
                )
                result = self.parse(fixture)
                self.assertEqual(result["context"]["status"], "amd64")
                self.assertNotIn("unused-one", json.dumps(result))
                fixture.set(
                    "<I", fixture.directory["unused2"] + 8, len(fixture.data) - 1
                )
                with self.assertRaises(ValueError):
                    self.parse(fixture)

    def test_unsupported_context_preserves_exception_and_modules(self):
        for case in ("arm64", "architecture-flags", "missing-integer", "short-context"):
            with self.subTest(case=case):
                fixture = SyntheticDump()
                if case == "arm64":
                    fixture.set("<H", fixture.offsets["system"], 12)
                elif case == "architecture-flags":
                    fixture.set("<I", fixture.offsets["context"] + 48, 0x400003)
                elif case == "missing-integer":
                    fixture.set("<I", fixture.offsets["context"] + 48, 0x100001)
                else:
                    fixture.set("<I", fixture.offsets["exception"] + 160, 256)
                result = self.parse(fixture)
                self.assertNotEqual(result["context"]["status"], "amd64")
                self.assertNotIn("registers", result["context"])
                self.assertEqual(int(result["exception"]["code"], 16), 0xC0000008)
                self.assertEqual(len(result["modules"]), 2)
                self.assertFalse(result["stack"]["unwound"])

    def test_malformed_ranges_duplicates_and_overlapping_modules_are_rejected(self):
        mutations = {
            "signature": lambda f: f.set("<I", 0, 0),
            "truncated-directory": lambda f: f.set("<I", 12, len(f.data) - 1),
            "truncated-stream": lambda f: f.set(
                "<I", f.directory["system"] + 8, len(f.data) - 1
            ),
            "duplicate-stream": lambda f: f.set("<I", f.directory["system"], 6),
            "duplicate-misc": lambda f: f.set("<I", f.directory["system"], 15),
            "overlapping-stream": lambda f: f.set(
                "<I", f.directory["system"] + 8, f.offsets["modules"]
            ),
            "overlapping-modules": lambda f: f.set(
                "<Q", f.offsets["modules"] + 4 + 108, 0x10000008
            ),
            "truncated-name": lambda f: f.set(
                "<I", f.offsets["modules"] + 4 + 20, len(f.data) - 1
            ),
            "context-outside-file": lambda f: f.set(
                "<I", f.offsets["exception"] + 164, len(f.data) - 1
            ),
            "too-many-exception-parameters": lambda f: f.set(
                "<I", f.offsets["exception"] + 32, 16
            ),
            "misc-size-past-stream": lambda f: f.set("<I", f.offsets["misc"], 28),
            "misc-size-too-small": lambda f: f.set("<I", f.offsets["misc"], 4),
            "misc-pid-needs-twelve-bytes": lambda f: f.set(
                "<II", f.offsets["misc"], 8, 1
            ),
            "misc-times-need-twenty-four-bytes": lambda f: f.set(
                "<II", f.offsets["misc"], 20, 2
            ),
            "truncated-misc-stream": lambda f: f.set("<I", f.directory["misc"] + 4, 20),
        }
        for case, mutate in mutations.items():
            with self.subTest(case=case):
                fixture = SyntheticDump(
                    misc_info=struct.pack("<6I", 24, 3, 2468, 1700000000, 0, 0)
                )
                mutate(fixture)
                with self.assertRaises(ValueError):
                    self.parse(fixture)

    def test_declared_limits_and_expired_deadline_fail_before_large_reads(self):
        mutations = {
            "stream-count": lambda f: f.set("<I", 8, 65),
            "module-count": lambda f: f.set("<I", f.offsets["modules"], 257),
            "thread-count": lambda f: f.set("<I", f.offsets["threads"], 257),
            "name-bytes": lambda f: f.set("<I", f.offsets["chrome_name"], 8194),
            "context-bytes": lambda f: f.set("<I", f.offsets["exception"] + 160, 65537),
        }
        for case, mutate in mutations.items():
            with self.subTest(case=case):
                fixture = SyntheticDump()
                mutate(fixture)
                with self.assertRaises(ValueError):
                    self.parse(fixture)
        self.path.write_bytes(SyntheticDump().data)
        with self.assertRaises(TimeoutError):
            owner.parse_minidump(self.path, deadline=time.monotonic() - 1)
        with self.path.open("r+b") as stream:
            stream.truncate(16 * 1024 * 1024 + 1)
        with self.assertRaises(ValueError):
            owner.parse_minidump(self.path)

    def test_only_ordinary_single_link_files_are_accepted(self):
        self.path.write_bytes(SyntheticDump().data)
        with self.assertRaises(ValueError):
            owner.parse_minidump(self.root)
        link = self.root / "linked-crash.dmp"
        link.symlink_to(self.path)
        with self.assertRaises(ValueError):
            owner.parse_minidump(link)
        link.unlink()
        os.link(self.path, link)
        with self.assertRaises(ValueError):
            owner.parse_minidump(self.path)


if __name__ == "__main__":
    unittest.main()
