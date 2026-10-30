// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

namespace Nvidia.NemoClaw.Bootstrapper;

internal sealed class NativeHermesUpgrade
{
    private bool compatible;
    private bool incompatible;

    internal void Reset() => (this.compatible, this.incompatible) = (false, false);

    internal void Observe(string packageId, bool perMachine, bool majorUpgrade, string version)
    {
        if (packageId != "NemoClawArm64Msi") return;
        var accepted = perMachine && majorUpgrade && Version.TryParse(version, out _);
        this.compatible |= accepted;
        this.incompatible |= !accepted;
    }

    internal bool CanUpgrade(bool installed, bool relatedOnly, bool hermesOnly, Func<bool> inspectImmutable) =>
        !installed && relatedOnly && hermesOnly && this.compatible && !this.incompatible && inspectImmutable();

    internal static bool RetireSupersededBundle(bool hermesOnly, bool installed, bool relatedUpgrade, bool uninstall) =>
        hermesOnly && !installed && relatedUpgrade && uninstall;
}
