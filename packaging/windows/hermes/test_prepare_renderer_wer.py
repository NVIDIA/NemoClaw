import argparse
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import unittest.mock as mock

spec = importlib.util.spec_from_file_location(
    "wer_owner", Path(__file__).with_name("prepare-renderer-wer.py")
)
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)


class Filesystem:
    close_errors = []

    def file_id(self, path, directory=False):
        owner.ordinary(path, directory)
        value = Path(path).stat()
        return {
            "volumeSerialHex": hex(value.st_dev),
            "fileIdHex": value.st_ino.to_bytes(16, "little").hex(),
        }

    def host_closure(self, host, deadline):
        return {**host, "closed": True, "handleClosed": True, "error": None}


class CloneControls(unittest.TestCase):
    def fixture(self, folder):
        base, root = Path(folder) / "base", Path(folder) / "owned"
        base.mkdir()
        (root / "chrome-win64").mkdir(parents=True)
        (root / "reports").mkdir()
        files = []
        for name, data in (
            ("chrome.exe", b"canonical exe"),
            ("chrome_elf.dll", b"canonical elf"),
            ("chrome_wer.dll", b"canonical wer"),
        ):
            (base / name).write_bytes(data)
            identity = owner.file_identity(base / name)
            files.append(
                {"relative": name, **{k: identity[k] for k in ("bytes", "sha256")}}
            )
            owner.copy_file(base / name, root / "chrome-win64" / name, identity)
        old = owner.file_identity(base / "chrome_wer.dll")
        (root / "chrome-win64/chrome_wer.dll").write_bytes(b"diagnostic observer")
        (root / "renderer-wer-observer.txt").write_text("bounded immutable config\n")
        win = Filesystem()
        receipt = {
            "schemaVersion": 1,
            "classification": "renderer-wer-clone-owner",
            "nonce": "a" * 24,
            "sourceRevision": "b" * 40,
            "cloneRoot": str(root),
            "rootCreated": True,
            "ready": True,
            "chromePath": str(root / "chrome-win64/chrome.exe"),
            "reportRoot": str(root / "reports"),
            "rootIdentity": win.file_id(root, True),
            "chromeDirectoryIdentity": win.file_id(root / "chrome-win64", True),
            "reportDirectoryIdentity": win.file_id(root / "reports", True),
            "expectedChromeFiles": files,
            "expectedChromeDirectories": [],
            "registry": None,
            "cleanupErrors": [],
            "chromeIdentity": {
                **owner.file_identity(root / "chrome-win64/chrome.exe"),
                **win.file_id(root / "chrome-win64/chrome.exe"),
            },
            "config": owner.file_identity(root / "renderer-wer-observer.txt"),
            "observerReplacement": {
                "original": old,
                "replacement": owner.file_identity(
                    root / "chrome-win64/chrome_wer.dll"
                ),
            },
        }
        receipt["cloneVerified"] = owner.verify_clone(receipt, win)
        return base, root, receipt, win

    def host(self, receipt, pid=123):
        return {
            "schemaVersion": 1,
            "classification": "renderer-wer-host-load",
            "sourceRevision": receipt["sourceRevision"],
            "nonce": receipt["nonce"][:12],
            "hostPid": pid,
            "hostCreationFiletime": "456",
            "hostImage": r"C:\Windows\System32\WerFault.exe",
            "configValid": True,
            "hostIdentityComplete": True,
            "callbackExecuted": False,
        }

    def test_copy_verifies_bytes_and_rejects_links(self):
        with tempfile.TemporaryDirectory() as directory:
            base, root, receipt, win = self.fixture(directory)
            original = owner.file_identity(base / "chrome_wer.dll")
            self.assertEqual(original, receipt["observerReplacement"]["original"])
            self.assertNotEqual(
                original["sha256"],
                receipt["observerReplacement"]["replacement"]["sha256"],
            )
            with self.assertRaisesRegex(ValueError, "recorded file"):
                owner.copy_file(
                    base / "chrome.exe",
                    root / "wrong",
                    {"bytes": 1, "sha256": "0" * 64},
                )
            os.link(base / "chrome.exe", base / "linked")
            with self.assertRaisesRegex(ValueError, "hard-linked"):
                owner.file_identity(base / "chrome.exe")
            self.assertEqual(owner.verify_clone(receipt, win), receipt["cloneVerified"])

    def test_post_inventory_rejects_changed_missing_and_extra_objects(self):
        for kind in ("changed", "missing", "extra", "directory"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                _, root, receipt, win = self.fixture(directory)
                if kind == "changed":
                    (root / "chrome-win64/chrome_elf.dll").write_bytes(b"changed")
                elif kind == "missing":
                    (root / "chrome-win64/chrome_elf.dll").unlink()
                elif kind == "extra":
                    (root / "chrome-win64/extra").write_bytes(b"extra")
                else:
                    (root / "unexpected").mkdir()
                with self.assertRaises(ValueError):
                    owner.verify_clone(receipt, win)

    def test_missing_executor_proof_retains_everything_and_partial_prepare_cleans(self):
        with tempfile.TemporaryDirectory() as directory:
            _, root, receipt, win = self.fixture(directory)
            retained = owner.cleanup(
                argparse.Namespace(executor_closed=False, executor_not_started=False),
                receipt,
                win,
            )
            self.assertFalse(retained["cleanupComplete"])
            self.assertTrue(root.exists())
            receipt["ready"] = False
            (root / "chrome-win64/chrome_elf.dll").write_bytes(b"partial copy")
            (root / "unrecorded-directory").mkdir()
            rejected = owner.cleanup(
                argparse.Namespace(executor_closed=False, executor_not_started=True),
                receipt,
                win,
            )
            self.assertFalse(rejected["cleanupComplete"])
            self.assertTrue((root / "unrecorded-directory").exists())
            (root / "unrecorded-directory").rmdir()
            cleaned = owner.cleanup(
                argparse.Namespace(executor_closed=False, executor_not_started=True),
                receipt,
                win,
            )
            self.assertTrue(cleaned["cleanupComplete"])
            self.assertFalse(cleaned["cloneIntegrityAfter"]["complete"])
            self.assertFalse(root.exists())

    def test_reports_retain_failure_fields_and_refuse_oversized_or_malformed_json(self):
        with tempfile.TemporaryDirectory() as directory:
            _, root, receipt, win = self.fixture(directory)
            failure = {
                "schemaVersion": 1,
                "classification": "renderer-wer-observer-failure",
                "sourceRevision": "",
                "nonce": receipt["nonce"][:12],
                "bindingAvailable": False,
                "observerException": "0xc0000005",
                "stage": "initialization",
            }
            file = root / "reports/failure.json"
            file.write_text(json.dumps(failure))
            result = owner.read_reports(receipt, win)
            self.assertFalse(result["complete"])
            self.assertEqual(result["reports"][0]["value"], failure)
            self.assertFalse(result["reports"][0]["bindingValidation"]["valid"])
            file.write_text('{"truncated":')
            result = owner.read_reports(receipt, win)
            self.assertFalse(result["complete"])
            self.assertEqual(result["reports"][0]["rawText"], '{"truncated":')
            file.write_bytes(b"x" * (owner.MAX_REPORT_BYTES + 1))
            self.assertFalse(owner.read_reports(receipt, win)["complete"])
            file.unlink()
            win.close_errors = [{"stage": "CloseHandle", "winerror": 6}]
            self.assertFalse(owner.read_reports(receipt, win)["complete"])
            retained = owner.cleanup(
                argparse.Namespace(executor_closed=False, executor_not_started=False),
                receipt,
                win,
            )
            self.assertIn(win.close_errors[0], retained["errors"])

    def test_final_report_snapshot_includes_late_record_but_retains_new_host(self):
        for new_host in (False, True):
            with (
                self.subTest(new_host=new_host),
                tempfile.TemporaryDirectory() as directory,
            ):
                _, root, receipt, win = self.fixture(directory)
                (root / "reports/host.json").write_text(json.dumps(self.host(receipt)))
                count = []

                def close(host, deadline):
                    count.append(host)
                    value = (
                        self.host(receipt, 456)
                        if new_host
                        else {
                            "schemaVersion": 1,
                            "classification": "renderer-wer-exception-observation",
                            "sourceRevision": receipt["sourceRevision"],
                            "nonce": receipt["nonce"][:12],
                            "hostPid": 123,
                            "hostCreationFiletime": "456",
                            "fileHandlesClosed": True,
                            "ownershipClaimed": False,
                            "callbackReturn": "S_OK",
                        }
                    )
                    (root / "reports/late.json").write_text(json.dumps(value))
                    return {"closed": True, "handleClosed": True, "error": None}

                win.host_closure = close
                result = owner.cleanup(
                    argparse.Namespace(
                        executor_closed=True, executor_not_started=False
                    ),
                    receipt,
                    win,
                )
                self.assertEqual(len(count), 1)
                self.assertEqual(result["cleanupComplete"], not new_host)
                self.assertEqual(root.exists(), new_host)

    def test_failed_host_observation_still_restores_exact_owned_registry(self):
        with tempfile.TemporaryDirectory() as directory:
            _, root, receipt, win = self.fixture(directory)
            (root / "reports/host.json").write_text(json.dumps(self.host(receipt)))
            receipt["registry"] = {"only": "this owned registry receipt"}
            registry = mock.Mock()
            registry.cleanup.return_value = {"passed": True}
            win.host_closure = mock.Mock(
                side_effect=ValueError("invalid reported host")
            )
            with mock.patch.object(owner, "registry_module", return_value=registry):
                result = owner.cleanup(
                    argparse.Namespace(
                        executor_closed=True, executor_not_started=False
                    ),
                    receipt,
                    win,
                )
            registry.cleanup.assert_called_once_with(receipt["registry"])
            self.assertTrue(result["registryRestored"])
            self.assertFalse(result["cleanupComplete"])
            self.assertTrue(root.exists())


if __name__ == "__main__":
    unittest.main()
