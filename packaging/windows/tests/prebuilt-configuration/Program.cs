// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Nvidia.NemoClaw.Bootstrapper;

// Only this test executable understands the fixture mode; no installed launcher
// or model server is invoked by the progress/cancellation controls below.
if (args.SequenceEqual(new[] { "--hold-inherited-output" }))
{
    Thread.Sleep(TimeSpan.FromSeconds(4));
    return;
}
if (args.Length == 4 && args[0] == "--native-inference" && args[1] is "install" or "install-ready" or "ensure-ready" && args[2] == "--model")
{
    var scenario = Environment.GetEnvironmentVariable("NEMOCLAW_TEST_DOWNLOAD_HELPER");
    if (scenario == "oversized") Console.WriteLine(new string('x', 4097));
    else if (scenario == "incomplete") Console.Write("{");
    else if (scenario == "wrong-model") Console.WriteLine(JsonSerializer.Serialize(new { schemaVersion = 1, @event = args[1] == "install" ? "downloaded" : "ready", localModel = "foreign" }));
    else if (scenario == "bad-phase") Console.WriteLine("{\"schemaVersion\":1,\"event\":\"progress\",\"phase\":\"ready\",\"message\":\"not a download\"}");
    else if (scenario == "exit-failure") Environment.ExitCode = 1;
    else
    {
        Console.WriteLine(JsonSerializer.Serialize(new { schemaVersion = 1, @event = "progress", phase = args[1] == "install" ? "downloading" : "probing", message = "Fixture only", completedBytes = 1, totalBytes = 2 }));
        if (scenario == "cancel") _ = await Console.In.ReadLineAsync();
        else
        {
            Console.WriteLine(JsonSerializer.Serialize(new { schemaVersion = 1, @event = args[1] == "install" ? "downloaded" : "ready", localModel = args[3] }));
            if (scenario == "inherited-output")
            {
                var descendant = Process.Start(new ProcessStartInfo { FileName = Environment.ProcessPath!, UseShellExecute = false, Arguments = "--hold-inherited-output" });
                descendant?.Dispose();
            }
        }
    }
    return;
}

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
Pass("model chooser copy identifies the recommendation, size, reuse, and credential-free setup", () =>
{
    var recommended = NativeDownloadedModelSetup.Description(NativeDownloadedModelSetup.DefaultModel);
    var alternative = NativeDownloadedModelSetup.Description("qwen3.6-35b-a3b");
    Require(recommended.StartsWith("Recommended for this PC.", StringComparison.Ordinal));
    Require(recommended.Contains("16.5 GB", StringComparison.Ordinal) && recommended.Contains("No endpoint, model ID, or API key", StringComparison.Ordinal));
    Require(alternative.StartsWith("Larger alternative.", StringComparison.Ordinal) && alternative.Contains("22.7 GB", StringComparison.Ordinal));
});
Pass("an incomplete cache cannot bypass first-time model storage admission", () =>
{
    var root = Path.Combine(Path.GetTempPath(), "nemoclaw-model-admission-" + Guid.NewGuid().ToString("N"));
    var model = NativeDownloadedModelSetup.Model(NativeDownloadedModelSetup.DefaultModel);
    var directory = Path.Combine(root, $"model-{NativeDownloadedModelSetup.DefaultModel}-{model.GetProperty("revision").GetString()}");
    Directory.CreateDirectory(directory);
    try
    {
        File.WriteAllText(Path.Combine(directory, model.GetProperty("weights").GetProperty("name").GetString()!), "incomplete");
        Require(!NativeDownloadedModelSetup.HasReusableCacheCandidate(NativeDownloadedModelSetup.DefaultModel, root));
    }
    finally { Directory.Delete(root, true); }
});
foreach (var model in NativeDownloadedModelSetup.Models)
{
    var id = model.GetProperty("id").GetString()!;
    JsonObject DownloadPreparation()
    {
        var p = Preparation();
        var local = p["localModel"]!;
        local["id"] = id; local["model"] = id;
        local["modelRevision"] = model.GetProperty("revision").GetString();
        local["weightsSha256"] = model.GetProperty("weights").GetProperty("sha256").GetString();
        local["weightsBytes"] = model.GetProperty("weights").GetProperty("bytes").GetInt64();
        local["availability"] = "download-on-setup";
        return p;
    }
    Pass($"{id} accepts exact bundled metadata without an inference key", () =>
    {
        var bindings = NativeSetupOperations.ReadBindings(DownloadPreparation().ToJsonString(), new[] { "tavily" }, id);
        Require(bindings.Inference is null);
        var config = new NativeSetupConfiguration("openclaw", "local", null, id, false) { LocalModel = id };
        Require(config.LaunchAfterSetup);
        foreach (var agent in new[] { "hermes", "pi", "langchain-deepagents-code", "nemocua" })
            Require(!(config with { Agent = agent }).LaunchAfterSetup);
        Require(!(config with { Endpoint = "http://127.0.0.1:8000/v1" }).LaunchAfterSetup);
        Require(!(config with { CredentialStored = true }).LaunchAfterSetup);
        Require(!(config with { Inference = "nvidia" }).LaunchAfterSetup);
        Require(!(config with { Model = "foreign" }).LaunchAfterSetup);
        using var value = JsonDocument.Parse(config.Serialize());
        Require(value.RootElement.GetProperty("localModel").GetString() == id && !value.RootElement.TryGetProperty("endpoint", out _));
    });
    foreach (var field in new[] { "id", "model", "modelRevision", "weightsSha256", "availability", "runtimeId" })
        Pass($"{id} refuses changed {field}", () =>
        {
            var p = DownloadPreparation(); p["localModel"]![field] = "foreign";
            Rejected(() => NativeSetupOperations.ReadBindings(p.ToJsonString(), new[] { "tavily" }, id));
        });
    Pass($"{id} refuses model substitution", () =>
    {
        var config = new NativeSetupConfiguration("openclaw", "local", null, "other-model", false) { LocalModel = id };
        Rejected(() => config.Serialize());
    });
}
var previousScenario = Environment.GetEnvironmentVariable("NEMOCLAW_TEST_DOWNLOAD_HELPER");
Pass("hosted and manual-server setup never starts an agent automatically", () =>
{
    Require(!new NativeSetupConfiguration("openclaw", "nvidia", "https://integrate.api.nvidia.com/v1", "model", true).LaunchAfterSetup);
    Require(!new NativeSetupConfiguration("openclaw", "local", "http://127.0.0.1:8000/v1", "model", false).LaunchAfterSetup);
});
try
{
    foreach (var scenario in new[] { "success", "wrong-model", "bad-phase", "oversized", "incomplete", "exit-failure", "cancel" })
    {
        Environment.SetEnvironmentVariable("NEMOCLAW_TEST_DOWNLOAD_HELPER", scenario);
        using var cancel = new CancellationTokenSource();
        var progress = 0;
        Exception? failure = null;
        try
        {
            await NativeDownloadedModelSetup.DownloadAsync(Environment.ProcessPath!, NativeDownloadedModelSetup.DefaultModel, value =>
            {
                progress++; Require(value.Phase == "downloading");
                if (scenario == "cancel") cancel.Cancel();
            }, cancel.Token);
        }
        catch (Exception error) { failure = error; }
        Require(scenario == "success" ? failure is null && progress == 1 : failure is not null);
        if (scenario == "cancel") Require(failure is OperationCanceledException);
        controls.Add($"download helper {scenario} is bounded and cleaned up");
    }
    Environment.SetEnvironmentVariable("NEMOCLAW_TEST_DOWNLOAD_HELPER", "success");
    var readinessProgress = new List<string>();
    await NativeDownloadedModelSetup.EnsureReadyAsync(Environment.ProcessPath!, NativeDownloadedModelSetup.DefaultModel,
        value => readinessProgress.Add(value.Phase), CancellationToken.None);
    Require(readinessProgress.SequenceEqual(new[] { "probing" }));
    controls.Add("GPU readiness helper requires its real terminal proof after progress");
    Environment.SetEnvironmentVariable("NEMOCLAW_TEST_DOWNLOAD_HELPER", "inherited-output");
    var bounded = Stopwatch.StartNew();
    await NativeDownloadedModelSetup.EnsureReadyAsync(Environment.ProcessPath!, NativeDownloadedModelSetup.DefaultModel, null, CancellationToken.None);
    bounded.Stop();
    Require(bounded.Elapsed < TimeSpan.FromSeconds(2));
    controls.Add("GPU readiness ignores inherited descendant output handles after terminal proof");
}
finally { Environment.SetEnvironmentVariable("NEMOCLAW_TEST_DOWNLOAD_HELPER", previousScenario); }
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
