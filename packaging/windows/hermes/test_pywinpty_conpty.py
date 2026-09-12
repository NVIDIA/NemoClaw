# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import importlib.util
from pathlib import Path
import tempfile
import tomllib
import types
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location(
    "conpty_build", Path(__file__).with_name("pywinpty-conpty.py")
)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

probe_spec = importlib.util.spec_from_file_location(
    "personal_python", Path(__file__).with_name("probe-personal-python.py")
)
probe = importlib.util.module_from_spec(probe_spec)
probe_spec.loader.exec_module(probe)

SOURCE = """[project]
name = "control-only"
[tool.uv]
override-dependencies = ["cryptography>=50,<51", "pynacl>=1.6,<1.7"]
exclude-newer = "14 days"
[tool.uv.exclude-newer-package]
cryptography = false
maturin = false
[tool.setuptools]
packages = ["unrelated"]
"""


class ConptyBuildConfiguration(unittest.TestCase):
    def test_retains_all_upstream_uv_values_and_scopes_only_pywinpty(self):
        original = tomllib.loads(SOURCE)["tool"]["uv"]
        configured = tomllib.loads(helper.render_configuration(SOURCE))
        settings = configured.pop("config-settings-package")
        self.assertEqual(configured, original)
        self.assertEqual(
            settings,
            {"pywinpty": {"build-args": "--features winpty-rs/conpty --locked"}},
        )
        self.assertNotIn("cryptography", settings)
        self.assertNotIn("tool", configured)

    def test_unknown_upstream_uv_schema_requires_explicit_review(self):
        with self.assertRaisesRegex(ValueError, "fresh explicit review"):
            helper.render_configuration(
                SOURCE.replace(
                    'exclude-newer = "14 days"',
                    'exclude-newer = "14 days"\nnew-option = true',
                )
            )

    def test_duplicate_toml_is_refused_before_writing(self):
        with self.assertRaises(tomllib.TOMLDecodeError):
            helper.render_configuration(SOURCE + "\n[tool.uv]\n")

    def test_changed_canonical_source_cannot_create_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / "pyproject.toml"
            project.write_text(SOURCE)
            with self.assertRaisesRegex(ValueError, "exact canonical source"):
                helper.prepare_configuration(
                    project, root / "uv.toml", root / "receipt.json"
                )
            self.assertFalse((root / "uv.toml").exists())
            self.assertFalse((root / "receipt.json").exists())


class PersonalConptyDrain(unittest.TestCase):
    class WinptyError(Exception):
        pass

    def run_probe(self, reads, *, alive=0, exit_code=0, status_error=None):
        state = {"reads": 0, "aliveQueries": 0, "seconds": 0, "released": False}
        self.state = state
        self.nonce = "personal-conpty-sentinel"

        class PTY:
            pid = 42

            def __init__(self, cols, rows, backend):
                assert (cols, rows, backend) == (80, 24, "ConPTY")

            def spawn(self, executable, cmdline, cwd):
                assert executable == probe.sys.executable
                state["command"] = cmdline
                return True

            def read(self, length, blocking):
                assert (length, blocking) == (4096, False)
                value = reads[min(state["reads"], len(reads) - 1)]
                state["reads"] += 1
                # A fresh exception matches the native API; retaining a mock
                # exception outside the probe would also retain its Python self frame.
                if value is PersonalConptyDrain.WinptyError:
                    raise value("Standard out reached EOF")
                if isinstance(value, BaseException):
                    raise value
                return value

            def isalive(self):
                state["aliveQueries"] += 1
                return alive is True or state["aliveQueries"] <= alive

            def get_exitstatus(self):
                if status_error:
                    raise status_error
                return exit_code

            def __del__(self):
                state["released"] = True

        package = types.ModuleType("winpty")
        package.PTY = PTY
        package.WinptyError = self.WinptyError
        enums = types.ModuleType("winpty.enums")
        enums.Backend = types.SimpleNamespace(ConPTY="ConPTY")
        native = types.ModuleType("winpty.winpty")
        native.__file__ = "canonical-winpty.pyd"
        package.winpty = native

        def sleep(duration):
            state["seconds"] += duration

        with (
            mock.patch.dict(
                probe.sys.modules,
                {"winpty": package, "winpty.enums": enums, "winpty.winpty": native},
            ),
            mock.patch.object(
                probe.importlib.metadata, "version", return_value="2.0.15"
            ),
            mock.patch.object(
                probe.time, "monotonic", side_effect=lambda: state["seconds"]
            ),
            mock.patch.object(probe.time, "sleep", side_effect=sleep),
        ):
            return probe.conpty_check(None, self.nonce)

    def test_exact_typed_eof_after_split_sentinel_requires_real_exit_and_releases_owner(
        self,
    ):
        result = self.run_probe(
            [
                "personal-conpty-",
                "sentinel",
                self.WinptyError,
            ],
            alive=4,
        )
        self.assertTrue(result["eofObserved"])
        self.assertTrue(result["childExitObserved"])
        self.assertEqual(result["exitCode"], 0)
        self.assertEqual(result["output"], self.nonce)
        self.assertEqual(self.state["reads"], 3)
        self.assertTrue(self.state["released"])
        self.assertLess(self.state["seconds"], 15)

    def test_eof_alone_missing_sentinel_or_unsuccessful_exit_still_fails(self):
        for output, code in (
            ("wrong output", 0),
            ("personal-conpty-sentinel", 1),
            ("personal-conpty-sentinel", None),
        ):
            with self.subTest(output=output, exit_code=code):
                with self.assertRaisesRegex(
                    AssertionError, "exit successfully"
                ) as caught:
                    self.run_probe(
                        [output, self.WinptyError("Standard out reached EOF")],
                        exit_code=code,
                    )
                note = caught.exception.__notes__[0]
                self.assertIn(output, note)
                self.assertIn('"exitCode": ' + str(code).replace("None", "null"), note)

    def test_only_the_exact_winpty_eof_is_consumed(self):
        for error in (
            self.WinptyError("Access is denied"),
            RuntimeError("Standard out reached EOF"),
        ):
            with self.subTest(error=error):
                with self.assertRaises(type(error)) as caught:
                    self.run_probe(["partial sentinel", error])
                self.assertIs(caught.exception, error)
                self.assertIn("partial sentinel", caught.exception.__notes__[0])
                self.assertIn(
                    '"childExitObserved": true', caught.exception.__notes__[0]
                )

    def test_eof_with_live_child_or_no_eof_keeps_original_deadline(self):
        for reads, alive in (
            (
                [
                    "personal-conpty-sentinel",
                    self.WinptyError("Standard out reached EOF"),
                ],
                True,
            ),
            ([""], 0),
        ):
            with self.subTest(alive=alive):
                with self.assertRaisesRegex(AssertionError, "exit successfully"):
                    self.run_probe(reads, alive=alive)
                self.assertGreaterEqual(self.state["seconds"], 15)
                self.assertLess(self.state["seconds"], 15.03)
                if alive:
                    self.assertEqual(self.state["reads"], 2)

    def test_status_query_failure_preserves_primary_read_error_and_partial_output(self):
        primary = self.WinptyError("read failed")
        with self.assertRaises(self.WinptyError) as caught:
            self.run_probe(
                ["partial output", primary],
                status_error=RuntimeError("exit query failed"),
            )
        self.assertIs(caught.exception, primary)
        self.assertIn("exit query failed", caught.exception.__notes__[0])
        self.assertIn("partial output", caught.exception.__notes__[0])

    def test_output_bound_and_failure_note_remain_bounded(self):
        with self.assertRaisesRegex(AssertionError, "output exceeded") as caught:
            self.run_probe(["x" * 4096])
        self.assertLess(len(caught.exception.__notes__[0]), 9000)
        self.assertEqual(self.state["reads"], 17)


if __name__ == "__main__":
    unittest.main()
