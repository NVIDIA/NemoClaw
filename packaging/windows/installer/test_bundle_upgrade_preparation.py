# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from pathlib import Path
import unittest


ROOT = Path(__file__).parents[3]


class BundleUpgradePreparationTests(unittest.TestCase):
    def test_legacy_cleanup_runs_after_new_msi_and_before_finalization(self):
        bundle = (ROOT / "packaging/windows/Bundle.wxs").read_text()
        msi = bundle.index('<MsiPackage Id="NemoClawArm64Msi"')
        preparation = bundle.index('<ExePackage\n        Id="NemoClawLegacyRuntimePreparation"')
        finalization = bundle.index('<ExePackage\n        Id="NemoClawRuntimeFinalization"')
        self.assertLess(msi, preparation)
        self.assertLess(preparation, finalization)
        self.assertIn(
            'InstallArguments="--runtime-bundle prepare-upgrade $(var.RuntimeId)"',
            bundle,
        )
        preparation_package = bundle[preparation:finalization]
        self.assertNotIn("RepairArguments=", preparation_package)
        self.assertNotIn("UninstallArguments=", preparation_package)
        self.assertIn('Permanent="yes"', preparation_package)
        self.assertIn('Vital="yes"', preparation_package)

    def test_release_package_explicitly_enables_upgrade_preparation(self):
        build = (
            ROOT / "packaging/windows/installer/build-immutable-package.ps1"
        ).read_text()
        self.assertIn("'-d', 'RuntimeUpgradePreparation=true'", build)


if __name__ == "__main__":
    unittest.main()
