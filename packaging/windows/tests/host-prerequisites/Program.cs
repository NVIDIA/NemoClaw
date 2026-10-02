// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using Nvidia.NemoClaw.HostPrerequisiteControls;

if (args is ["--control-policy-tests"])
{
    Console.WriteLine(JsonSerializer.Serialize(new { classification = "control-policy-only", passed = AclControlPolicyTests.Run(), windowsApiExecuted = false }));
    return;
}
if (!OperatingSystem.IsWindows() || RuntimeInformation.OSArchitecture != Architecture.Arm64 || Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true")
    throw new InvalidOperationException("This proof requires the disposable GitHub Windows ARM64 runner.");
var largeTree = args is ["--measure-large-tree", _];
if (args.Length != 1 && !largeTree) throw new ArgumentException("One fresh evidence directory is required.");
var temporary = Path.GetFullPath(Environment.GetEnvironmentVariable("RUNNER_TEMP") ?? throw new InvalidOperationException("Runner temporary root missing")).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
var evidence = Path.GetFullPath(args[largeTree ? 1 : 0]);
if (!evidence.StartsWith(temporary, StringComparison.OrdinalIgnoreCase) || Directory.Exists(evidence) || File.Exists(evidence))
    throw new InvalidOperationException("The proof may create only a fresh runner-owned evidence directory.");
Directory.CreateDirectory(evidence);
if (largeTree) { LargeTreeMeasurement.Run(evidence); return; }
var fixtures = Path.Combine(evidence, "fixtures");
Directory.CreateDirectory(fixtures);
var results = new List<object>();
var observations = new List<object>();
var caseErrors = new List<object>();
var controlPolicyPassed = 0;
Exception? primary = null;
var cleaned = false;
var cleanupErrors = new List<string>();
string Tree(string name)
{
    var root = Path.Combine(fixtures, name);
    Directory.CreateDirectory(Path.Combine(root, "child", "grandchild"));
    File.WriteAllText(Path.Combine(root, "child", "fixture.txt"), "owned ACL proof\n");
    return root;
}
Dictionary<string, string> Children(string root)
{
    var records = new Dictionary<string, string>(StringComparer.Ordinal);
    var details = new Dictionary<string, object>(StringComparer.Ordinal);
    foreach (var item in Directory.EnumerateFileSystemEntries(root, "*", SearchOption.AllDirectories))
    {
        using var file = DirectoryAcl.Open(item, DirectoryAcl.OrdinaryAclAccess, requireDirectory:false);
        var snapshot = file.Read();
        var relative = Path.GetRelativePath(root, item);
        records.Add(relative, snapshot.Sha256);
        details.Add(relative, snapshot.Details());
    }
    observations.Add(new { phase = "descendant-descriptor-readback", root = Path.GetFileName(root), entries = details });
    return records;
}
void EqualChildren(Dictionary<string, string> before, Dictionary<string, string> after)
{
    if (before.Count != after.Count || before.Any(row => !after.TryGetValue(row.Key, out var value) || value != row.Value))
        throw new InvalidOperationException("The proposed metadata update changed a descendant descriptor.");
}
void RunCase(string name, Action action)
{
    try { action(); }
    catch (Exception error)
    {
        primary ??= error;
        caseErrors.Add(new { name, error = error.ToString() });
    }
}
try
{
    controlPolicyPassed = AclControlPolicyTests.Run();
    foreach (var protect in new[] { false, true })
    {
        RunCase(protect ? "protected-cold-and-warm" : "ordinary-cold-and-warm", () =>
        {
            var root = Tree(protect ? "protected" : "ordinary");
            if (protect)
            {
                var directory = new DirectoryInfo(root);
                var security = directory.GetAccessControl(AccessControlSections.Access);
                security.SetAccessRuleProtection(true, true);
                directory.SetAccessControl(security);
            }
            var children = Children(root);
            using var owner = DirectoryAcl.Open(root, DirectoryAcl.MaximumAllowed);
            var before = owner.Read();
            DirectoryAcl.Result? cold = null;
            Exception? coldError = null;
            try { cold = owner.Prepare(); }
            catch (Exception error) { coldError = error; }
            finally { observations.Add(new { phase = protect ? "protected-cold" : "ordinary-cold", attempt = owner.LastAttempt }); }
            // Retain descendant evidence even if the target's post-write validation
            // failed. Preserve that primary failure if the readback also fails.
            try
            {
                var childReadback = Children(root);
                observations.Add(new { phase = protect ? "protected-children" : "ordinary-children", before = children, after = childReadback });
                EqualChildren(children, childReadback);
            }
            catch (Exception error)
            {
                observations.Add(new { phase = protect ? "protected-children-error" : "ordinary-children-error", error = error.ToString() });
                coldError ??= error;
            }
            if (coldError is not null) throw coldError;
            if (cold is null || !cold.WroteDacl || owner.SetCalls != 1) throw new InvalidOperationException("Cold metadata preparation did not make exactly one DACL update.");
            var warm = owner.Prepare();
            if (warm.WroteDacl || owner.SetCalls != 1 || warm.BeforeSha256 != cold.AfterSha256 || warm.BeforeSha256 != warm.AfterSha256 || owner.Read().Sha256 != cold.AfterSha256)
                throw new InvalidOperationException("Exact prepared state did not make a zero-write no-op.");
            EqualChildren(children, Children(root));
            results.Add(new { name = protect ? "protected-cold-and-warm" : "ordinary-cold-and-warm", beforeOwner = before.Owner, beforeGroup = before.Group, beforeControl = before.Control, cold, warm, childDescriptors = children, childDescriptorsUnchanged = true });
        });
    }
    RunCase("conflict-no-partial-write", () =>
    {
        var root = Tree("conflict");
        using var owner = DirectoryAcl.Open(root, DirectoryAcl.MaximumAllowed);
        var prior = owner.Read();
        var bad = new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, DirectoryAcl.MetadataMask | 1, new SecurityIdentifier(DirectoryAcl.RequiredSids[1]), false, null);
        owner.Write(DirectoryAcl.InsertExplicit(prior.Descriptor.DiscretionaryAcl!, [bad]));
        var seeded = owner.Read(); var setCalls = owner.SetCalls; var refused = false;
        try { owner.Prepare(); } catch (IOException error) when (error.Message.Contains("conflicts", StringComparison.Ordinal)) { refused = true; }
        if (!refused || owner.SetCalls != setCalls || owner.Read().Sha256 != seeded.Sha256)
            throw new InvalidOperationException("A conflicting second trustee was not refused before any partial update.");
        results.Add(new { name = "conflict-no-partial-write", refused, descriptorUnchanged = true, extraWriteCalls = owner.SetCalls - setCalls });
    });
    {
        // Deliberately inheritable metadata-only ACEs are limited to disposable
        // control trees. They distinguish the API's propagation behavior; the
        // proposed preparation path above always emits AceFlags.None.
        const string syntheticSid = "S-1-5-21-194302675-115028934-934720151-424242";
        foreach (var maximum in new[] { false, true })
        {
            RunCase(maximum ? "maximum-handle-no-propagation" : "ordinary-handle-propagation", () =>
            {
                var root = Tree(maximum ? "maximum-handle-control" : "ordinary-handle-control");
                var children = Children(root);
                using var owner = DirectoryAcl.Open(root, maximum ? DirectoryAcl.MaximumAllowed : DirectoryAcl.OrdinaryAclAccess);
                var prior = owner.Read();
                var inheritable = new CommonAce(AceFlags.ContainerInherit | AceFlags.ObjectInherit, AceQualifier.AccessAllowed, 0x80, new SecurityIdentifier(syntheticSid), false, null);
                owner.Write(DirectoryAcl.InsertExplicit(prior.Descriptor.DiscretionaryAcl!, [inheritable]));
                var after = Children(root);
                var changed = children.Any(row => after[row.Key] != row.Value);
                var inheritedTestAces = new Dictionary<string, bool>(StringComparer.Ordinal);
                foreach (var relative in children.Keys)
                {
                    using var child = DirectoryAcl.Open(Path.Combine(root, relative), DirectoryAcl.OrdinaryAclAccess, requireDirectory:false);
                    var found = false;
                    foreach (GenericAce ace in child.Read().Descriptor.DiscretionaryAcl!)
                    {
                        if (ace is KnownAce known && known.SecurityIdentifier.Value == syntheticSid && known.AccessMask == 0x80 &&
                            ace.AceType == AceType.AccessAllowed && (ace.AceFlags & AceFlags.Inherited) != 0)
                            found = true;
                    }
                    inheritedTestAces.Add(relative, found);
                }
                observations.Add(new { phase = maximum ? "maximum-propagation-control" : "ordinary-propagation-control", before = children, after, inheritedTestAces });
                if (maximum && changed) throw new InvalidOperationException("MAXIMUM_ALLOWED did not suppress inheritance propagation as documented.");
                if (maximum && inheritedTestAces.Values.Any(value => value)) throw new InvalidOperationException("The non-propagating handle unexpectedly inherited the test ACE to a child.");
                if (!maximum && (!changed || inheritedTestAces.Values.Any(value => !value))) throw new InvalidOperationException("The positive propagation control did not inherit its exact test ACE to every descendant.");
                results.Add(new { name = maximum ? "maximum-handle-no-propagation" : "ordinary-handle-propagation", childDescriptorsChanged = changed, syntheticTrustee = syntheticSid, testOnlyInheritableMask = "0x00000080" });
            });
        }
    }
}
catch (Exception error) { primary ??= error; }
finally
{
    try { Directory.Delete(fixtures, true); cleaned = !Directory.Exists(fixtures); }
    catch (Exception error) { cleanupErrors.Add(error.Message); primary ??= error; }
    var receipt = new { schemaVersion = 1, classification = "isolated-directory-handle-acl-proof", controllerSource = Environment.GetEnvironmentVariable("GITHUB_SHA"), status = primary is null ? "pass" : "failed", os = RuntimeInformation.OSDescription, processArchitecture = RuntimeInformation.ProcessArchitecture.ToString(), passed = results.Count, results, observations, caseErrors, controlPolicyPassed, fixturesRemoved = cleaned, cleanupErrors, error = primary?.ToString(), productionActivated = false, systemDriveTouched = false, saclWriteRequested = false, descriptorObservationScope = "owner, group, DACL and returned control fields; SACL contents not requested", allowedControlTransition = "only one-way SE_DACL_AUTO_INHERITED addition after an actual DACL write; all other bits exact", endToEndInstallUnder30SecondsProven = false };
    try { File.WriteAllText(Path.Combine(evidence, "handle-acl-proof.json"), JsonSerializer.Serialize(receipt, new JsonSerializerOptions { WriteIndented = true }) + "\n"); }
    catch (Exception error) { primary ??= error; }
}
if (primary is not null) throw primary;
Console.WriteLine("Five real Windows ACL cases passed on isolated directories; no system-drive or install-time claim.");
