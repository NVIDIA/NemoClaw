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

constexpr ACCESS_MASK shared_section_user_access = 0x000f0007;
constexpr ACCESS_MASK shared_section_container_access = 0x00000007;

// The canonical NULL-DACL shared.5 is accessible outside AppContainer rules,
// but its sibling contained processes need an explicit actual AppContainer ACE.
// Describe only a new private section; never change an existing object ACL.
inline bool make_shared_section_descriptor(PSID user, PSID container, ScopedDescriptor& output) {
    if (!user || !container || !IsValidSid(user) || !IsValidSid(container) || EqualSid(user, container)) {
        SetLastError(ERROR_INVALID_SID);
        return false;
    }
    ZeroMemory(&output, sizeof(output));
    auto acl = reinterpret_cast<PACL>(output.acl);
    return InitializeSecurityDescriptor(&output.descriptor, SECURITY_DESCRIPTOR_REVISION) &&
        InitializeAcl(acl, sizeof(output.acl), ACL_REVISION) &&
        AddAccessAllowedAceEx(acl, ACL_REVISION, 0, shared_section_user_access, user) &&
        AddAccessAllowedAceEx(acl, ACL_REVISION, 0, shared_section_container_access, container) &&
        SetSecurityDescriptorDacl(&output.descriptor, TRUE, acl, FALSE) &&
        SetSecurityDescriptorControl(&output.descriptor, SE_DACL_PROTECTED, SE_DACL_PROTECTED);
}

// Read-only signal-pipe diagnostics. Raw ACL bytes preserve every captured
// ACE's order/type/flags/mask/SID without lookup, allocation or modification.
struct PipeSecurityObservation {
    bool complete = false;
    bool attributesPresent = false;
    DWORD attributesLength = 0;
    BOOL inheritedHandle = FALSE;
    bool descriptorPresent = false;
    SECURITY_DESCRIPTOR_CONTROL control = 0;
    DWORD revision = 0;
    bool ownerPresent = false;
    bool groupPresent = false;
    BOOL ownerDefaulted = FALSE;
    BOOL groupDefaulted = FALSE;
    BOOL daclPresent = FALSE;
    bool nullDacl = false;
    DWORD aclBytes = 0;
    DWORD aceCount = 0;
    DWORD capturedAclBytes = 0;
    BYTE acl[512] = {};
};

inline void observe_pipe_security(const SECURITY_ATTRIBUTES* attributes, PipeSecurityObservation& result) {
    __try {
        if (!attributes) { result.complete = true; return; }
        result.attributesPresent = true;
        result.attributesLength = attributes->nLength;
        if (attributes->nLength != sizeof(SECURITY_ATTRIBUTES)) return;
        result.inheritedHandle = attributes->bInheritHandle;
        auto descriptor = attributes->lpSecurityDescriptor;
        if (!descriptor) { result.complete = true; return; }
        result.descriptorPresent = true;
        if (!GetSecurityDescriptorControl(descriptor, &result.control, &result.revision)) return;
        PSID owner = nullptr, group = nullptr;
        if (!GetSecurityDescriptorOwner(descriptor, &owner, &result.ownerDefaulted) ||
            !GetSecurityDescriptorGroup(descriptor, &group, &result.groupDefaulted)) return;
        result.ownerPresent = owner != nullptr;
        result.groupPresent = group != nullptr;
        PACL acl = nullptr;
        BOOL defaulted = FALSE;
        if (!GetSecurityDescriptorDacl(descriptor, &result.daclPresent, &acl, &defaulted)) return;
        result.nullDacl = result.daclPresent && !acl;
        if (acl) {
            result.aclBytes = acl->AclSize;
            result.aceCount = acl->AceCount;
            result.capturedAclBytes = result.aclBytes < sizeof(result.acl)
                ? result.aclBytes : static_cast<DWORD>(sizeof(result.acl));
            const BYTE* bytes = reinterpret_cast<const BYTE*>(acl);
            for (DWORD n = 0; n < result.capturedAclBytes; ++n) result.acl[n] = bytes[n];
        }
        result.complete = true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        result.complete = false;
    }
}

struct SignalPipeDescriptor {
    SECURITY_ATTRIBUTES attributes;
    SECURITY_DESCRIPTOR descriptor;
    alignas(DWORD) BYTE acl[512 + sizeof(ACCESS_ALLOWED_ACE) + SECURITY_MAX_SID_SIZE];
};

// Only the observed canonical three-ACE descriptor is eligible. Preserve its
// existing ACE bytes/order, then append the actual AppContainer writer rights.
// This describes a new first-instance pipe; it never changes an existing ACL.
inline bool append_signal_container_ace(const PipeSecurityObservation& original, PSID user, PSID container,
                                         SignalPipeDescriptor& result) {
    if (!user || !container || !IsValidSid(user) || !IsValidSid(container) || EqualSid(user, container) ||
        !original.complete || !original.attributesPresent || original.attributesLength != sizeof(SECURITY_ATTRIBUTES) ||
        original.inheritedHandle || !original.descriptorPresent || original.control != SE_DACL_PRESENT ||
        original.revision != SECURITY_DESCRIPTOR_REVISION || original.ownerPresent || original.groupPresent ||
        original.ownerDefaulted || original.groupDefaulted || !original.daclPresent || original.nullDacl ||
        original.aceCount != 3 || original.aclBytes < sizeof(ACL) || original.aclBytes > sizeof(original.acl) ||
        original.capturedAclBytes != original.aclBytes) return false;
    auto acl = reinterpret_cast<PACL>(const_cast<BYTE*>(original.acl));
    if (acl->AclSize != original.aclBytes || acl->AclRevision != ACL_REVISION ||
        acl->Sbz1 || acl->Sbz2 || acl->AceCount != 3 || !IsValidAcl(acl)) return false;
    alignas(void*) BYTE admins[SECURITY_MAX_SID_SIZE] = {}, system[SECURITY_MAX_SID_SIZE] = {};
    DWORD adminSize = sizeof(admins), systemSize = sizeof(system);
    if (!CreateWellKnownSid(WinBuiltinAdministratorsSid, nullptr, admins, &adminSize) ||
        !CreateWellKnownSid(WinLocalSystemSid, nullptr, system, &systemSize)) return false;
    PSID expected[3] = {user, admins, system};
    DWORD used = sizeof(ACL);
    for (DWORD n = 0; n < 3; ++n) {
        void* value = nullptr;
        if (!GetAce(acl, n, &value)) return false;
        auto ace = static_cast<ACCESS_ALLOWED_ACE*>(value);
        const DWORD sidSize = GetLengthSid(expected[n]);
        const DWORD aceSize = static_cast<DWORD>(offsetof(ACCESS_ALLOWED_ACE, SidStart)) + sidSize;
        if (ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE || ace->Header.AceFlags != 0 ||
            ace->Header.AceSize != aceSize || ace->Mask != GENERIC_ALL ||
            used + aceSize > acl->AclSize || memcmp(&ace->SidStart, expected[n], sidSize) != 0) return false;
        used += aceSize;
    }
    if (used != acl->AclSize) return false;
    ZeroMemory(&result, sizeof(result));
    auto next = reinterpret_cast<PACL>(result.acl);
    if (!InitializeAcl(next, sizeof(result.acl), ACL_REVISION) ||
        !AddAce(next, ACL_REVISION, MAXDWORD, const_cast<BYTE*>(original.acl + sizeof(ACL)), used - static_cast<DWORD>(sizeof(ACL))) ||
        !AddAccessAllowedAceEx(next, ACL_REVISION, 0, signal_writer_access, container) ||
        !InitializeSecurityDescriptor(&result.descriptor, SECURITY_DESCRIPTOR_REVISION) ||
        !SetSecurityDescriptorDacl(&result.descriptor, TRUE, next, FALSE)) return false;
    next->AclSize = static_cast<WORD>(used + offsetof(ACCESS_ALLOWED_ACE, SidStart) + GetLengthSid(container));
    result.attributes.nLength = sizeof(SECURITY_ATTRIBUTES);
    result.attributes.bInheritHandle = FALSE;
    result.attributes.lpSecurityDescriptor = &result.descriptor;
    return true;
}

inline bool make_scoped_descriptor(PSID user, PSID container, ScopedDescriptor& output,
                                   const char** failed_stage = nullptr) {
    if (failed_stage) *failed_stage = "descriptor-identities";
    if (!user || !container || !IsValidSid(user) || !IsValidSid(container) || EqualSid(user, container)) {
        SetLastError(ERROR_INVALID_SID);
        return false;
    }
    ZeroMemory(&output, sizeof(output));
    auto acl = reinterpret_cast<PACL>(output.acl);
    if (failed_stage) *failed_stage = "descriptor-initialize";
    if (!InitializeSecurityDescriptor(&output.descriptor, SECURITY_DESCRIPTOR_REVISION)) return false;
    if (failed_stage) *failed_stage = "descriptor-acl-initialize";
    if (!InitializeAcl(acl, sizeof(output.acl), ACL_REVISION)) return false;
    if (failed_stage) *failed_stage = "descriptor-user-ace";
    if (!AddAccessAllowedAceEx(acl, ACL_REVISION, 0, directory_access, user)) return false;
    if (failed_stage) *failed_stage = "descriptor-container-ace";
    if (!AddAccessAllowedAceEx(acl, ACL_REVISION, 0, directory_access, container)) return false;
    if (failed_stage) *failed_stage = "descriptor-set-dacl";
    if (!SetSecurityDescriptorDacl(&output.descriptor, TRUE, acl, FALSE)) return false;
    if (failed_stage) *failed_stage = "descriptor-protect-dacl";
    if (!SetSecurityDescriptorControl(&output.descriptor, SE_DACL_PROTECTED, SE_DACL_PROTECTED)) return false;
    if (failed_stage) *failed_stage = nullptr;
    return true;
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
