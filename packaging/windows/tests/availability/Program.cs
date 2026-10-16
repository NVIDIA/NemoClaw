// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.Text;
using System.Text.Json;
using Nvidia.NemoClaw.Bootstrapper;

static byte[] Record(string firstStatus = "qualified", string hermesStatus = "unqualified") => JsonSerializer.SerializeToUtf8Bytes(new
{
    schemaVersion = 1,
    classification = "native-runtime-package-availability",
    runtimeId = new string('a', 64),
    manifestSha256 = new string('b', 64),
    sourceRevision = new string('c', 40),
    agents = new[] { "openclaw", "hermes" }
        .Select((agent, index) => new { agent, status = index == 0 ? firstStatus : hermesStatus }).ToArray(),
});
static void Require(bool value) { if (!value) throw new Exception("Availability control failed."); }
static void Reject(byte[] bytes)
{
    try { NativeRuntimeAvailability.Parse(bytes); }
    catch (Exception error) when (error is System.IO.InvalidDataException or JsonException or InvalidOperationException) { return; }
    throw new Exception("Invalid availability was admitted.");
}
var selected = NativeRuntimeAvailability.Parse(Record());
Require(selected.IsSelectedRuntimeBuild && selected.CanSelect("openclaw") && !selected.CanSelect("hermes") && !selected.CanSelect("pi"));
var preview = NativeRuntimeAvailability.Parse(Record("unqualified"));
Require(preview.CanSelect("openclaw") && preview.IsUnqualified("openclaw")
    && preview.SelectionDetail("openclaw") == "Preview: full runtime checks are pending."
    && !preview.CanSelect("hermes") && preview.SelectionDetail("hermes") == "Unavailable: runtime qualification is pending."
    && selected.SelectionDetail("openclaw") == string.Empty);
Require(NativeRuntimeAvailability.Parse(Record("qualified", "qualified")).CanSelect("hermes"));
Require(!NativeRuntimeAvailability.Parse(Record("not-included", "not-included")).CanSelect("openclaw") && !NativeRuntimeAvailability.Parse(Record("not-included", "not-included")).CanSelect("hermes"));
Require(!selected.CanSelect("../foreign") && selected.UnavailableText == "Unavailable in this preview");
Reject(Record("built"));
Reject(Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(Record()).Replace("\"agent\":\"openclaw\"", "\"agent\":\"hermes\"", StringComparison.Ordinal)));
foreach (var removed in new[] { "pi", "langchain-deepagents-code", "nemocua" })
{
    Require(!selected.CanSelect(removed) && !NativeRuntimeAvailability.Load().CanSelect(removed));
    Reject(Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(Record()).Replace("\"agent\":\"hermes\"", $"\"agent\":\"{removed}\"", StringComparison.Ordinal)));
}
Reject(Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(Record()).Replace("\"schemaVersion\":1", "\"schemaVersion\":1,\"path\":\"foreign\"", StringComparison.Ordinal)));
Reject(new byte[16385]);
Require(!NativeRuntimeAvailability.Load().IsSelectedRuntimeBuild && !NativeRuntimeAvailability.Load().CanSelect("hermes") && !NativeRuntimeAvailability.Load().CanSelect("openclaw"));
Require(!selected.PrebuiltLocalModelAvailable);
var withModel = Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(Record()).Replace("\"schemaVersion\":1", "\"schemaVersion\":1,\"prebuiltLocalModelAvailable\":true", StringComparison.Ordinal));
Require(NativeRuntimeAvailability.Parse(withModel).PrebuiltLocalModelAvailable);
Require(!selected.BundledLocalInferenceAvailable);
var withEngine = Encoding.UTF8.GetString(Record()).Replace("\"schemaVersion\":1", "\"schemaVersion\":1,\"prebuiltLocalModelAvailable\":false,\"bundledLocalInferenceAvailable\":true", StringComparison.Ordinal);
var engine = NativeRuntimeAvailability.Parse(Encoding.UTF8.GetBytes(withEngine));
Require(engine.BundledLocalInferenceAvailable && !engine.PrebuiltLocalModelAvailable);
Require(engine.IsUnqualified("hermes") && !engine.CanSelect("hermes") && !engine.CanSelect("pi"));
Reject(Encoding.UTF8.GetBytes(withEngine.Replace("\"bundledLocalInferenceAvailable\":true", "\"bundledLocalInferenceAvailable\":\"true\"", StringComparison.Ordinal)));
Reject(Encoding.UTF8.GetBytes(withEngine.Replace("\"bundledLocalInferenceAvailable\":true", "\"bundledLocalInferenceAvailable\":true,\"bundledLocalInferenceAvailable\":false", StringComparison.Ordinal)));
Console.WriteLine("17 availability controls passed; included OpenClaw previews remain unqualified and selectable.");
