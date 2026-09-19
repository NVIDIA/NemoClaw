// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.Security;
using System.Text.RegularExpressions;

namespace Nvidia.NemoClaw.Bootstrapper;

internal sealed class NativeSetupOptions
{
    internal string? SearchProvider { get; init; }
    internal Dictionary<string, string[]> Messaging { get; init; } = new();

    internal void Validate(string agent)
    {
        if (this.SearchProvider is not null && !((agent == "openclaw" && this.SearchProvider is "brave" or "tavily") || (agent == "hermes" && this.SearchProvider == "tavily")))
            throw new InvalidOperationException("This agent does not support the selected search provider.");
        if (this.Messaging.Count > 0 && agent is not ("openclaw" or "hermes"))
            throw new InvalidOperationException("Messaging is unavailable for this agent.");
        foreach (var (channel, users) in this.Messaging)
        {
            if (channel is not ("telegram" or "discord" or "slack") || users.Length > 50)
                throw new InvalidOperationException("Select a supported channel and at most 50 users.");
            var pattern = channel == "slack" ? "^[UW][A-Z0-9]{6,31}$" : "^[0-9]{1,24}$";
            if (users.Any(user => !Regex.IsMatch(user, pattern, RegexOptions.CultureInvariant)))
                throw new InvalidOperationException("Enter account IDs for allowed users. Names and wildcards are not accepted.");
        }
    }

    internal string[] RequiredServices()
    {
        var services = new List<string>();
        if (this.SearchProvider is not null) services.Add(this.SearchProvider);
        foreach (var channel in this.Messaging.Keys)
            services.AddRange(channel == "slack" ? new[] { "slack-bot", "slack-app" } : new[] { channel });
        return services.ToArray();
    }

    internal Dictionary<string, object> ToWireValue()
    {
        var result = new Dictionary<string, object>();
        if (this.SearchProvider is not null) result["search"] = new { provider = this.SearchProvider, credentialStored = true };
        if (this.Messaging.Count > 0)
        {
            var channels = new Dictionary<string, object>();
            foreach (var (channel, users) in this.Messaging)
            {
                var value = new Dictionary<string, object> { ["credentialStored"] = true, ["allowedUsers"] = users };
                if (channel == "slack") value["appCredentialStored"] = true;
                channels[channel] = value;
            }
            result["messaging"] = channels;
        }
        return result;
    }
}

internal sealed class NativeServiceCredentials : Dictionary<string, SecureString>, IDisposable
{
    public void Dispose()
    {
        foreach (var secret in this.Values) secret.Dispose();
        this.Clear();
    }
}
