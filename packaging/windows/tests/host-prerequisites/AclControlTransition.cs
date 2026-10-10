// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

namespace Nvidia.NemoClaw.HostPrerequisiteControls;

internal enum AclControlTransition
{
    Forbidden,
    Unchanged,
    DaclInheritanceModelRecorded
}

internal static class AclControlPolicy
{
    // SetSecurityInfo can record conversion to the current inheritance model.
    // This is a one-way addition after a DACL write, not permission to ignore
    // inheritance protection, request bits, or the flags/bytes of any ACE.
    // https://learn.microsoft.com/en-us/windows/win32/secauthz/automatic-propagation-of-inheritable-aces
    internal static AclControlTransition AfterDaclWrite(ushort before, ushort after)
    {
        const ushort daclAutoInherited = 0x0400;
        if (after == before) return AclControlTransition.Unchanged;
        if ((before & daclAutoInherited) == 0 && after == (before | daclAutoInherited))
            return AclControlTransition.DaclInheritanceModelRecorded;
        return AclControlTransition.Forbidden;
    }
}
