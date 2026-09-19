// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.Text;
using System.Text.Json;
using Nvidia.NemoClaw.Bootstrapper;

static byte[] Record(string firstStatus = "qualified") => JsonSerializer.SerializeToUtf8Bytes(new
{
    schemaVersion = 1,
    classification = "native-runtime-package-availability",
    runtimeId = new string('a', 64),
    manifestSha256 = new string('b', 64),
    sourceRevision = new string('c', 40),
    agents = new[] { "openclaw", "hermes", "langchain-deepagents-code", "pi", "nemocua" }
        .Select((agent, index) => new { agent, status = index == 0 ? firstStatus : index == 1 ? "unqualified" : "not-included" }).ToArray(),
});
static void Require(bool value) { if (!value) throw new Exception("Availability control failed."); }
static void Reject(byte[] bytes)
{
    try { NativeRuntimeAvailability.Parse(bytes); }
    catch (Exception error) when (error is System.IO.InvalidDataException or JsonException or InvalidOperationException) { return; }
    throw new Exception("Invalid availability was admitted.");
}
var selected = NativeRuntimeAvailability.Parse(Record());
Require(selected.IsSelectedRuntimeBuild && selected.CanSelect("openclaw") && selected.CanSelect("hermes") && !selected.CanSelect("pi"));
Require(NativeRuntimeAvailability.Parse(Record("unqualified")).CanSelect("openclaw") && NativeRuntimeAvailability.Parse(Record("unqualified")).IsUnqualified("openclaw"));
Require(!selected.CanSelect("../foreign") && selected.UnavailableText == "Unavailable in this preview");
Reject(Record("built"));
Reject(Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(Record()).Replace("\"agent\":\"pi\"", "\"agent\":\"hermes\"", StringComparison.Ordinal)));
Reject(Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(Record()).Replace("\"schemaVersion\":1", "\"schemaVersion\":1,\"path\":\"foreign\"", StringComparison.Ordinal)));
Reject(new byte[16385]);
Require(!NativeRuntimeAvailability.Load().IsSelectedRuntimeBuild && NativeRuntimeAvailability.Load().CanSelect("hermes"));
Require(!selected.PrebuiltLocalModelAvailable);
var withModel = Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(Record()).Replace("\"schemaVersion\":1", "\"schemaVersion\":1,\"prebuiltLocalModelAvailable\":true", StringComparison.Ordinal));
Require(NativeRuntimeAvailability.Parse(withModel).PrebuiltLocalModelAvailable);
Console.WriteLine("10 availability controls passed; unqualified included previews remain selectable, no Windows UI or qualification claim.");
