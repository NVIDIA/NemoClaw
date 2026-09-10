// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

namespace Nvidia.NemoClaw.HostPrerequisiteControls;

internal static class AclControlPolicyTests
{
    internal static int Run()
    {
        var checks = 0;
        void Check(ushort before, ushort after, AclControlTransition expected)
        {
            var actual = AclControlPolicy.AfterDaclWrite(before, after);
            if (actual != expected)
                throw new InvalidOperationException($"Control transition 0x{before:x4}->0x{after:x4}: expected {expected}, got {actual}.");
            checks++;
        }

        Check(0x8004, 0x8004, AclControlTransition.Unchanged);
        Check(0x8404, 0x8404, AclControlTransition.Unchanged);
        Check(0x8004, 0x8404, AclControlTransition.DaclInheritanceModelRecorded);
        Check(0x9004, 0x9404, AclControlTransition.DaclInheritanceModelRecorded);
        Check(0x8404, 0x8004, AclControlTransition.Forbidden);
        Check(0x8004, 0x9404, AclControlTransition.Forbidden);
        Check(0x9004, 0x8404, AclControlTransition.Forbidden);
        // Every other single-bit change must be rejected, both when AI was
        // absent and when AI and DACL protection were already present.
        foreach (var original in new ushort[] { 0x8004, 0x9404 })
        {
            for (var bit = 0; bit < 16; bit++)
            {
                var changed = (ushort)(original ^ (1 << bit));
                var expected = original == 0x8004 && bit == 10
                    ? AclControlTransition.DaclInheritanceModelRecorded
                    : AclControlTransition.Forbidden;
                Check(original, changed, expected);
            }
        }
        return checks;
    }
}
