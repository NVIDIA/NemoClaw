// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Nvidia.NemoClaw.Bootstrapper;

using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Nvidia.NemoClaw.NativeInferenceManifest.json")!;
var catalog = JsonNode.Parse(stream)!;
JsonObject Preparation() => new()
{
    ["schemaVersion"] = 1,
    ["inference"] = null,
    ["services"] = new JsonObject { ["tavily"] = new string('a', 64) },
    ["localModel"] = new JsonObject
    {
        ["schemaVersion"] = 1,
        ["id"] = catalog["id"]!.DeepClone(),
        ["model"] = catalog["model"]!.DeepClone(),
        ["modelRevision"] = catalog["modelRevision"]!.DeepClone(),
        ["weightsSha256"] = catalog["weights"]!["sha256"]!.DeepClone(),
        ["weightsBytes"] = catalog["weights"]!["bytes"]!.DeepClone(),
        ["packSha256"] = new string('b', 64),
        ["runtimeId"] = new string('c', 64),
        ["runtimeManifestSha256"] = new string('d', 64),
        ["sourceRevision"] = new string('e', 40),
        ["availability"] = "prebuilt",
        ["modelBytesRead"] = 0,
    },
};
var controls = new List<string>();
void Pass(string name, Action run) { run(); controls.Add(name); }
void Require(bool condition) { if (!condition) throw new InvalidOperationException("Control assertion failed."); }
void Rejected(Action run)
{
    try { run(); }
    catch (InvalidOperationException) { return; }
    throw new InvalidOperationException("Invalid configuration was accepted.");
}
void Read(JsonObject preparation) => NativeSetupOperations.ReadBindings(preparation.ToJsonString(), new[] { "tavily" }, NativeExpressSetup.Id);

Pass("logical local model preserves service binding without external inference binding", () =>
{
    var bindings = NativeSetupOperations.ReadBindings(Preparation().ToJsonString(), new[] { "tavily" }, NativeExpressSetup.Id);
    Require(bindings.Inference is null && bindings.Services["tavily"] == new string('a', 64));
});
Pass("hosted inference binding remains exact", () =>
{
    var bindings = NativeSetupOperations.ReadBindings("{\"schemaVersion\":1,\"inference\":\"" + new string('f', 64) + "\",\"services\":{}}", Array.Empty<string>());
    Require(bindings.Inference == new string('f', 64) && bindings.Services.Count == 0);
});
Pass("local selection refuses placeholder credential binding", () =>
{
    var p = Preparation(); p["inference"] = new string('f', 64); Rejected(() => Read(p));
});
Pass("missing prebuilt proof is refused", () =>
{
    var p = Preparation(); p.Remove("localModel"); Rejected(() => Read(p));
});
Pass("different model bytes cannot satisfy installed availability", () =>
{
    var p = Preparation(); p["localModel"]!["weightsBytes"] = 1; Rejected(() => Read(p));
});
Pass("different runtime identity shape is refused", () =>
{
    var p = Preparation(); p["localModel"]!["runtimeManifestSha256"] = "invalid"; Rejected(() => Read(p));
});
Pass("metadata cannot claim model reads during Save", () =>
{
    var p = Preparation(); p["localModel"]!["modelBytesRead"] = 1; Rejected(() => Read(p));
});
Pass("unexpected service binding is refused", () =>
{
    var p = Preparation(); p["services"]!["brave"] = new string('f', 64); Rejected(() => Read(p));
});
Pass("local configuration serializes a logical choice with no endpoint", () =>
{
    var configuration = new NativeSetupConfiguration("openclaw", "local", null, NativeExpressSetup.Model, false) { LocalModel = NativeExpressSetup.Id };
    using var value = JsonDocument.Parse(configuration.Serialize());
    Require(!value.RootElement.TryGetProperty("endpoint", out _) && value.RootElement.GetProperty("localModel").GetString() == NativeExpressSetup.Id);
});
Pass("local configuration refuses a placeholder endpoint", () =>
{
    var configuration = new NativeSetupConfiguration("openclaw", "local", "http://127.0.0.1:8000/v1", NativeExpressSetup.Model, false) { LocalModel = NativeExpressSetup.Id };
    Rejected(() => configuration.Serialize());
});
Console.WriteLine(JsonSerializer.Serialize(new { schemaVersion = 1, passed = controls.Count, failed = 0, controls, installedModelAuthorityTested = false, windowsExecutionRequired = OperatingSystem.IsWindows() }));

namespace Nvidia.NemoClaw.Bootstrapper
{
    // Only the actual parser/serializer runs here. Unexpected maintenance or desktop
    // calls fail instead of touching the test host; production definitions are not linked.
    internal static class NativeMaintenance
    {
        internal static bool SupportsDataRemoval() => throw new InvalidOperationException("Unexpected maintenance invocation.");
    }
    internal static class NativeDesktopIntegration
    {
        internal static void Ensure(string agent, string launcher) => throw new InvalidOperationException("Unexpected desktop invocation.");
    }
}
