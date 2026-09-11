// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#pragma once

#include <windows.h>
#include "namespace-path.h"

namespace nemoclaw_msys {

struct ScopedDescriptor {
    SECURITY_DESCRIPTOR descriptor;
    alignas(DWORD) BYTE acl[sizeof(ACL) + 2 * (sizeof(ACCESS_ALLOWED_ACE) + SECURITY_MAX_SID_SIZE)];
};

inline bool make_scoped_descriptor(PSID user, PSID container, ScopedDescriptor& output) {
    if (!IsValidSid(user) || !IsValidSid(container) || EqualSid(user, container)) return false;
    ZeroMemory(&output, sizeof(output));
    auto acl = reinterpret_cast<PACL>(output.acl);
    return InitializeSecurityDescriptor(&output.descriptor, SECURITY_DESCRIPTOR_REVISION) &&
        InitializeAcl(acl, sizeof(output.acl), ACL_REVISION) &&
        AddAccessAllowedAceEx(acl, ACL_REVISION, 0, directory_access, user) &&
        AddAccessAllowedAceEx(acl, ACL_REVISION, 0, directory_access, container) &&
        SetSecurityDescriptorDacl(&output.descriptor, TRUE, acl, FALSE) &&
        SetSecurityDescriptorControl(&output.descriptor, SE_DACL_PROTECTED, SE_DACL_PROTECTED);
}

// Exact shape produced by pinned MSYS _everyone_sd(CYG_SHARED_DIR_ACCESS).
// An unrelated, malformed, NULL, inherited, or more permissive descriptor is
// never silently replaced. The Windows caller protects pointer reads with SEH.
inline bool is_msys_directory_descriptor(PSECURITY_DESCRIPTOR descriptor, PSID world) {
    if (!descriptor || !IsValidSecurityDescriptor(descriptor)) return false;
    SECURITY_DESCRIPTOR_CONTROL control = 0;
    DWORD revision = 0;
    if (!GetSecurityDescriptorControl(descriptor, &control, &revision) ||
        revision != SECURITY_DESCRIPTOR_REVISION || control != SE_DACL_PRESENT) return false;
    PSID owner = nullptr, group = nullptr;
    BOOL defaulted = FALSE;
    if (!GetSecurityDescriptorOwner(descriptor, &owner, &defaulted) || owner || defaulted ||
        !GetSecurityDescriptorGroup(descriptor, &group, &defaulted) || group || defaulted) return false;
    PACL acl = nullptr;
    BOOL present = FALSE;
    if (!GetSecurityDescriptorDacl(descriptor, &present, &acl, &defaulted) ||
        !present || !acl || defaulted || !IsValidAcl(acl) || acl->AclRevision != ACL_REVISION ||
        acl->Sbz1 || acl->Sbz2 || acl->AceCount != 1) return false;
    void* value = nullptr;
    if (!GetAce(acl, 0, &value)) return false;
    auto ace = static_cast<ACCESS_ALLOWED_ACE*>(value);
    const DWORD expected_size = static_cast<DWORD>(offsetof(ACCESS_ALLOWED_ACE, SidStart)) + GetLengthSid(world);
    return acl->AclSize == sizeof(ACL) + expected_size &&
        ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && ace->Header.AceFlags == 0 &&
        ace->Header.AceSize == expected_size && ace->Mask == directory_access &&
        IsValidSid(&ace->SidStart) && EqualSid(&ace->SidStart, world);
}

} // namespace nemoclaw_msys
