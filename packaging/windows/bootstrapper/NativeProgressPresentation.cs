// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text.Json;

namespace Nvidia.NemoClaw.Bootstrapper;

internal static class NativePreviewPresentation
{
    // Preview builds explain their work by default. A later product option can
    // change this single presentation seam without changing the wire protocol.
    internal static bool DiagnosticsEnabled => true;
}

internal sealed record NativeProgressMeasurement(long Completed, long Total, string Unit)
{
    internal const long MaximumCount = 9_007_199_254_740_991;
    internal static NativeProgressMeasurement? Create(long completed, long total, string unit) =>
        completed >= 0 && total > 0 && completed <= total && total <= MaximumCount &&
        unit is "bytes" or "files" or "items" or "percent"
            ? new(completed, total, unit) : null;

    internal double Percentage => 100d * this.Completed / this.Total;
    internal string Label => this.Unit switch
    {
        "percent" => $"{Math.Floor(this.Percentage):0}%",
        "bytes" when this.Total >= 1_000_000_000 => $"{this.Completed / 1_000_000_000d:0.00} / {this.Total / 1_000_000_000d:0.00} GB",
        "bytes" when this.Total >= 1_000_000 => $"{this.Completed / 1_000_000d:0.0} / {this.Total / 1_000_000d:0.0} MB",
        "bytes" => $"{this.Completed:N0} / {this.Total:N0} bytes",
        _ => $"{this.Completed:N0} / {this.Total:N0} {this.Unit}",
    };
}

internal sealed record NativeSessionProgress(string Stage, NativeProgressMeasurement? Measurement)
{
    internal static NativeSessionProgress Parse(JsonElement record)
    {
        if (record.ValueKind != JsonValueKind.Object || record.GetProperty("kind").GetString() != "progress")
            throw new InvalidDataException("The session progress message is invalid.");
        var stage = record.GetProperty("stage").GetString();
        if (stage is not ("inference" or "runtime" or "gateway" or "sandbox" or "bootstrap" or "dashboard" or "browser" or "running" or "cleanup"))
            throw new InvalidDataException("The session progress stage is invalid.");
        var hasCompleted = record.TryGetProperty("completed", out var completed);
        var hasTotal = record.TryGetProperty("total", out var total);
        var hasUnit = record.TryGetProperty("unit", out var unit);
        NativeProgressMeasurement? measurement = null;
        if (hasCompleted || hasTotal || hasUnit)
        {
            if (!hasCompleted || !hasTotal || !hasUnit || completed.ValueKind != JsonValueKind.Number ||
                total.ValueKind != JsonValueKind.Number || !completed.TryGetInt64(out var count) ||
                !total.TryGetInt64(out var size) || unit.ValueKind != JsonValueKind.String ||
                unit.GetString() is not ("bytes" or "files" or "items") ||
                (measurement = NativeProgressMeasurement.Create(count, size, unit.GetString()!)) is null)
                throw new InvalidDataException("The session progress count is invalid.");
        }
        return new(stage, measurement);
    }

    internal bool ShouldPresent(bool interfaceAvailable, bool stopRequested) =>
        this.Stage == "cleanup" || (!interfaceAvailable && !stopRequested);

    internal (string Title, string Detail) Explain() => this.Stage switch
    {
        "inference" => ("Preparing inference", "Checking your selected model connection. An on-device model may need time to download or load."),
        "runtime" => ("Preparing the agent", "Preparing the installed runtime for this private session. Large runtimes can take several minutes."),
        "gateway" => ("Starting session services", "Starting the local services that manage the private agent session."),
        "sandbox" => ("Starting the private session", "Windows is creating the protected environment and starting the selected agent."),
        "bootstrap" => ("Connecting the agent", "Connecting the private session to its approved model and optional services."),
        "dashboard" => ("Waiting for the Web UI", "The agent is starting its interface. The browser will open after the backend makes it available."),
        "browser" => ("Preparing to open the browser", "The interface is becoming available. Opening a browser does not yet mean its page has finished loading."),
        "running" => ("Checking the running session", "Waiting for the session owner to confirm that the Web UI is available."),
        "cleanup" => ("Closing the private session", "Waiting for the agent to stop and for Windows to finish restoring private access."),
        _ => throw new InvalidDataException("The session progress stage is invalid."),
    };
}

internal sealed record NativeSessionCapabilities(string Search)
{
    internal static NativeSessionCapabilities Parse(JsonElement record)
    {
        if (record.ValueKind != JsonValueKind.Object || record.GetProperty("kind").GetString() != "capabilities" ||
            record.GetProperty("search").GetString() is not ("available" or "unconfigured" or "unavailable"))
            throw new InvalidDataException("The session capability message is invalid.");
        return new(record.GetProperty("search").GetString()!);
    }

    internal string Description => this.Search switch
    {
        "available" => "Search: configured separately from inference. Live search results are shown in the agent.",
        "unconfigured" => "Search: not configured. An inference key does not enable search; add a search service in agent Setup.",
        "unavailable" => "Search: not available in this session. Inference and search are separate capabilities.",
        _ => throw new InvalidDataException("The session capability message is invalid."),
    };
}

internal sealed class NativeProgressPresentation
{
    private readonly Func<TimeSpan> now;
    private TimeSpan started;
    private TimeSpan phaseStarted;
    private TimeSpan lastAdvance;
    internal string Phase { get; private set; } = string.Empty;
    internal NativeProgressMeasurement? Measurement { get; private set; }

    internal NativeProgressPresentation(Func<TimeSpan>? clock = null)
    {
        var watch = Stopwatch.StartNew();
        this.now = clock ?? (() => watch.Elapsed);
        this.Reset();
    }

    internal void Reset()
    {
        this.started = this.phaseStarted = this.lastAdvance = this.now();
        this.Phase = string.Empty;
        this.Measurement = null;
    }

    internal void Report(string phase, NativeProgressMeasurement? measurement = null)
    {
        var current = this.now();
        if (!string.Equals(phase, this.Phase, StringComparison.Ordinal))
        {
            this.Phase = phase;
            this.phaseStarted = this.lastAdvance = current;
            this.Measurement = null;
        }
        if (measurement is not null && measurement != this.Measurement)
        {
            this.Measurement = measurement;
            this.lastAdvance = current;
        }
    }

    internal TimeSpan SessionElapsed => this.now() - this.started;
    internal TimeSpan PhaseElapsed => this.now() - this.phaseStarted;
    internal TimeSpan SinceAdvance => this.now() - this.lastAdvance;
    internal double ActivityOpacity => 0.45 + 0.45 * (0.5 + 0.5 * Math.Sin(this.SessionElapsed.TotalSeconds * Math.PI));
    internal string ActivityText => this.Measurement is null
        ? $"This step {Duration(this.PhaseElapsed)} · Waiting for a measured progress update"
        : this.SinceAdvance >= TimeSpan.FromSeconds(3)
            ? $"This step {Duration(this.PhaseElapsed)} · No new count for {Duration(this.SinceAdvance)}"
            : $"This step {Duration(this.PhaseElapsed)} · Showing the latest reported count";
    internal static string Duration(TimeSpan duration) =>
        string.Create(CultureInfo.InvariantCulture, $"{Math.Max(0, (long)duration.TotalHours):00}:{Math.Max(0, duration.Minutes):00}:{Math.Max(0, duration.Seconds):00}");
}

// Keep at most one queued render per progress lane. A phase/terminal update can
// discard stale queued counts without delaying its own UI action.
internal sealed class NativePresentationUpdates
{
    private readonly object gate = new();
    private Action? latest;
    private bool queued;

    internal void Post(Action update, Action<Action> schedule)
    {
        lock (this.gate)
        {
            this.latest = update;
            if (this.queued) return;
            this.queued = true;
        }
        schedule(this.Drain);
    }

    internal void Clear()
    {
        lock (this.gate) this.latest = null;
    }

    private void Drain()
    {
        Action? action;
        lock (this.gate)
        {
            action = this.latest;
            this.latest = null;
            this.queued = false;
        }
        action?.Invoke();
    }
}
