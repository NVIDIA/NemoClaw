// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.IO;
using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Nvidia.NemoClaw.Bootstrapper;

// Presentation consumes an embedded build input, never a user-writable path.
// It does not grant native admission or replace the installed runtime seal.
internal sealed class NativeRuntimeAvailability
{
    private const string Resource = "Nvidia.NemoClaw.NativeRuntimeAvailability.json";
    private static readonly string[] Agents = { "openclaw", "hermes", "langchain-deepagents-code", "pi", "nemocua" };
    private readonly IReadOnlyDictionary<string, string>? statuses;
    internal bool PrebuiltLocalModelAvailable { get; private init; }

    private NativeRuntimeAvailability(IReadOnlyDictionary<string, string>? statuses) => this.statuses = statuses;

    internal bool IsSelectedRuntimeBuild => this.statuses is not null;
    internal bool CanSelect(string agent) => Agents.Contains(agent, StringComparer.Ordinal)
        && (this.statuses is null || this.statuses[agent] is "qualified" or "unqualified");
    internal bool IsUnqualified(string agent) => this.statuses is not null && this.statuses.TryGetValue(agent, out var status) && status == "unqualified";
    internal string PreviewText => "Preview: full runtime checks are pending.";
    internal string UnavailableText => "Unavailable in this preview";

    internal static NativeRuntimeAvailability Load()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(Resource);
        if (stream is null) return new(null); // Existing default build keeps its existing selection behavior.
        if (stream.Length is < 1 or > 16384) throw new InvalidDataException("The embedded runtime availability is invalid.");
        using var buffer = new MemoryStream();
        stream.CopyTo(buffer);
        return Parse(buffer.ToArray());
    }

    internal static NativeRuntimeAvailability Parse(byte[] bytes)
    {
        if (bytes.Length is < 1 or > 16384) throw new InvalidDataException("The embedded runtime availability is invalid.");
        using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 5 });
        var root = document.RootElement;
        var hasModelAvailability = root.TryGetProperty("prebuiltLocalModelAvailable", out var modelAvailability);
        if (hasModelAvailability) ExactFields(root, "schemaVersion", "classification", "runtimeId", "manifestSha256", "sourceRevision", "agents", "prebuiltLocalModelAvailable");
        else ExactFields(root, "schemaVersion", "classification", "runtimeId", "manifestSha256", "sourceRevision", "agents");
        if (hasModelAvailability && modelAvailability.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            throw new InvalidDataException("The embedded model availability is invalid.");
        if (root.GetProperty("schemaVersion").GetInt32() != 1
            || root.GetProperty("classification").GetString() != "native-runtime-package-availability"
            || !Hex(root.GetProperty("runtimeId"), 64)
            || !Hex(root.GetProperty("manifestSha256"), 64)
            || !Hex(root.GetProperty("sourceRevision"), 40))
            throw new InvalidDataException("The embedded runtime identity is invalid.");
        var rows = root.GetProperty("agents");
        if (rows.ValueKind != JsonValueKind.Array || rows.GetArrayLength() != Agents.Length)
            throw new InvalidDataException("The embedded agent selection is incomplete.");
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var row in rows.EnumerateArray())
        {
            ExactFields(row, "agent", "status");
            var agent = row.GetProperty("agent").GetString();
            var status = row.GetProperty("status").GetString();
            if (agent is null || !Agents.Contains(agent, StringComparer.Ordinal)
                || status is not ("not-included" or "unqualified" or "qualified")
                || !result.TryAdd(agent, status))
                throw new InvalidDataException("The embedded agent selection is invalid.");
        }
        return new(result) { PrebuiltLocalModelAvailable = hasModelAvailability && modelAvailability.GetBoolean() };
    }

    private static bool Hex(JsonElement value, int length) => value.ValueKind == JsonValueKind.String
        && Regex.IsMatch(value.GetString()!, "\\A[a-f0-9]{" + length + "}\\z", RegexOptions.CultureInvariant);

    private static void ExactFields(JsonElement value, params string[] expected)
    {
        if (value.ValueKind != JsonValueKind.Object) throw new InvalidDataException("The embedded selection record is invalid.");
        var names = value.EnumerateObject().Select(property => property.Name).ToArray();
        if (names.Length != expected.Length || names.Distinct(StringComparer.Ordinal).Count() != expected.Length
            || names.Any(name => !expected.Contains(name, StringComparer.Ordinal)))
            throw new InvalidDataException("The embedded selection fields are invalid.");
    }
}
