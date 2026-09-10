// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace Nvidia.NemoClaw.HostPrerequisiteControls;

[SupportedOSPlatform("windows")]
internal sealed class DirectoryAcl : IDisposable
{
    internal const uint MaximumAllowed = 0x02000000;
    internal const uint OrdinaryAclAccess = 0x00060080;
    internal const int MetadataMask = 0x00120088;
    internal static readonly string[] RequiredSids = ["S-1-15-2-1", "S-1-15-2-2"];
    private readonly SafeFileHandle handle;
    private readonly uint access;
    internal int SetCalls { get; private set; }
    internal object? LastAttempt { get; private set; }
    private DirectoryAcl(SafeFileHandle handle, uint access) { this.handle = handle; this.access = access; }

    internal static DirectoryAcl Open(string path, uint access, bool requireDirectory = true)
    {
        var handle = CreateFileW(path, access, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        if (handle.IsInvalid) { var error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
        if (!GetFileInformationByHandle(handle, out var information)) { var error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
        if ((requireDirectory && (information.Attributes & 0x10) == 0) || (information.Attributes & 0x400) != 0)
        { handle.Dispose(); throw new IOException("The ACL fixture target is not an ordinary directory."); }
        return new(handle, access);
    }

    internal Snapshot Read()
    {
        var status = GetSecurityInfo(handle, 1, 7, out _, out _, out _, out _, out var pointer);
        if (status != 0) throw new Win32Exception((int)status);
        try
        {
            var size = GetSecurityDescriptorLength(pointer);
            if (size == 0 || size > 256 * 1024) throw new IOException("Security descriptor exceeds its read bound.");
            var bytes = new byte[size]; Marshal.Copy(pointer, bytes, 0, bytes.Length);
            var descriptor = new RawSecurityDescriptor(bytes, 0);
            if (descriptor.DiscretionaryAcl is null) throw new IOException("A null or absent DACL is not an admissible fixture input.");
            return new(descriptor, Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());
        }
        finally { LocalFree(pointer); }
    }

    internal Result Prepare()
    {
        if (access != MaximumAllowed) throw new InvalidOperationException("Metadata preparation requires the documented non-propagating handle mode.");
        var before = Read();
        var acl = before.Descriptor.DiscretionaryAcl!;
        var missing = new List<GenericAce>();
        foreach (var sid in RequiredSids)
        {
            var found = false;
            foreach (GenericAce ace in acl)
            {
                if ((ace.AceFlags & AceFlags.Inherited) != 0) continue;
                if (ace is not KnownAce known) throw new IOException("Unsupported explicit ACE prevents an exact conflict check.");
                if (known.SecurityIdentifier.Value != sid) continue;
                if (ace.AceType != AceType.AccessAllowed || ace.AceFlags != AceFlags.None || known.AccessMask != MetadataMask)
                    throw new IOException("Existing AppContainer ACE conflicts with the exact non-inheriting metadata tuple.");
                found = true;
            }
            if (!found) missing.Add(new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, MetadataMask, new SecurityIdentifier(sid), false, null));
        }
        if (missing.Count == 0) return new(false, 0, before.Sha256, before.Sha256, before.Owner, before.Group, before.Control, before.ControlValue, before.ControlValue, AclControlTransition.Unchanged.ToString());
        var updated = InsertExplicit(acl, missing);
        LastAttempt = new { beforeSha256 = before.Sha256, beforeOwner = before.Owner, beforeGroup = before.Group, beforeControl = before.Control, expectedAces = AceBytes(updated).ToArray() };
        var watch = Stopwatch.StartNew();
        Write(updated);
        var milliseconds = watch.Elapsed.TotalMilliseconds;
        var after = Read();
        var transition = AclControlPolicy.AfterDaclWrite(before.ControlValue, after.ControlValue);
        LastAttempt = new { beforeSha256 = before.Sha256, afterSha256 = after.Sha256, beforeOwner = before.Owner, afterOwner = after.Owner, beforeGroup = before.Group, afterGroup = after.Group, beforeControl = before.Control, afterControl = after.Control, beforeControlValue = before.ControlValue, afterControlValue = after.ControlValue, controlTransition = transition.ToString(), expectedAces = AceBytes(updated).ToArray(), actualAces = AceBytes(after.Descriptor.DiscretionaryAcl!).ToArray(), expectedAclRevision = updated.Revision, actualAclRevision = after.Descriptor.DiscretionaryAcl!.Revision, writeMilliseconds = milliseconds };
        if (before.Owner != after.Owner || before.Group != after.Group || transition == AclControlTransition.Forbidden)
            throw new IOException("The ACL operation changed an owner, group or control bit beyond recording DACL inheritance-model conversion.");
        var expected = AceBytes(updated);
        if (updated.Revision != after.Descriptor.DiscretionaryAcl!.Revision || !expected.SequenceEqual(AceBytes(after.Descriptor.DiscretionaryAcl!)))
            throw new IOException("The resulting DACL differs from the original ACE sequence plus the exact additions.");
        return new(true, milliseconds, before.Sha256, after.Sha256, after.Owner, after.Group, after.Control, before.ControlValue, after.ControlValue, transition.ToString());
    }

    internal void Write(RawAcl acl)
    {
        var bytes = new byte[acl.BinaryLength]; acl.GetBinaryForm(bytes, 0);
        var pointer = Marshal.AllocHGlobal(bytes.Length);
        try
        {
            Marshal.Copy(bytes, 0, pointer, bytes.Length);
            SetCalls++;
            var status = SetSecurityInfo(handle, 1, 4, IntPtr.Zero, IntPtr.Zero, pointer, IntPtr.Zero);
            if (status != 0) throw new Win32Exception((int)status);
        }
        finally { Marshal.FreeHGlobal(pointer); }
    }

    internal static RawAcl InsertExplicit(RawAcl original, IEnumerable<GenericAce> added)
    {
        var entries = added.ToArray();
        var result = new RawAcl(original.Revision, original.Count + entries.Length);
        var inserted = false;
        foreach (GenericAce ace in original)
        {
            if (!inserted && (ace.AceFlags & AceFlags.Inherited) != 0)
            { foreach (var item in entries) result.InsertAce(result.Count, item); inserted = true; }
            result.InsertAce(result.Count, ace);
        }
        if (!inserted) foreach (var item in entries) result.InsertAce(result.Count, item);
        return result;
    }

    private static IEnumerable<string> AceBytes(RawAcl acl)
    {
        foreach (GenericAce ace in acl) { var bytes = new byte[ace.BinaryLength]; ace.GetBinaryForm(bytes, 0); yield return Convert.ToHexString(bytes); }
    }

    internal sealed record Snapshot(RawSecurityDescriptor Descriptor, string Sha256)
    {
        internal string? Owner => Descriptor.Owner?.Value;
        internal string? Group => Descriptor.Group?.Value;
        internal string Control => Descriptor.ControlFlags.ToString();
        internal ushort ControlValue => (ushort)Descriptor.ControlFlags;
    }
    internal sealed record Result(bool WroteDacl, double WriteMilliseconds, string BeforeSha256, string AfterSha256, string? Owner, string? Group, string Control, ushort BeforeControlValue, ushort AfterControlValue, string ControlTransition);
    public void Dispose() => handle.Dispose();

    [StructLayout(LayoutKind.Sequential)] private struct FileInformation
    {
        internal uint Attributes;
        internal System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        internal uint VolumeSerial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation information);
    [DllImport("advapi32.dll")] private static extern uint GetSecurityInfo(SafeFileHandle handle, int type, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")] private static extern uint SetSecurityInfo(SafeFileHandle handle, int type, uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("advapi32.dll")] private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr pointer);
}
