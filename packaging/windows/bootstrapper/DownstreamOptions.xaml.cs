// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;

namespace Nvidia.NemoClaw.Bootstrapper;

public partial class DownstreamOptions : UserControl
{
    private string agent = string.Empty;
    public DownstreamOptions() => this.InitializeComponent();

    internal void SetAgent(string value)
    {
        if (this.agent == value) return;
        this.agent = value;
        this.ClearSecrets();
        foreach (var checkbox in new[] { this.SearchEnabled, this.TelegramEnabled, this.DiscordEnabled, this.SlackEnabled }) checkbox.IsChecked = false;
        this.DiscordEnabled.IsEnabled = value == "hermes";
        this.DiscordEnabled.Content = value == "openclaw" ? "Discord (unavailable in this preview)" : "Discord";
        this.SearchProvider.Items.Clear();
        if (value == "openclaw") this.SearchProvider.Items.Add(new ComboBoxItem { Content = "Brave Search", Tag = "brave" });
        if (value is "openclaw" or "hermes") this.SearchProvider.Items.Add(new ComboBoxItem { Content = "Tavily", Tag = "tavily" });
        this.SearchProvider.SelectedIndex = this.SearchProvider.Items.Count > 0 ? 0 : -1;
        this.Visibility = value is "openclaw" or "hermes" ? Visibility.Visible : Visibility.Collapsed;
    }

    internal NativeSetupOptions ReadOptions()
    {
        if (this.SearchEnabled.IsChecked == true && this.SearchProvider.SelectedItem is not ComboBoxItem)
            throw new InvalidOperationException("Choose a supported search provider.");
        var channels = new Dictionary<string, string[]>();
        if (this.TelegramEnabled.IsChecked == true) channels["telegram"] = UserIds(this.TelegramUsers.Text);
        if (this.DiscordEnabled.IsChecked == true) channels["discord"] = UserIds(this.DiscordUsers.Text);
        if (this.SlackEnabled.IsChecked == true) channels["slack"] = UserIds(this.SlackUsers.Text);
        var result = new NativeSetupOptions
        {
            SearchProvider = this.SearchEnabled.IsChecked == true ? (this.SearchProvider.SelectedItem as ComboBoxItem)?.Tag as string : null,
            Messaging = channels,
        };
        result.Validate(this.agent);
        return result;
    }

    internal void SetOptions(NativeSetupOptions options)
    {
        options.Validate(this.agent);
        var search = this.SearchProvider.Items.OfType<ComboBoxItem>().FirstOrDefault(item => item.Tag as string == options.SearchProvider);
        if (options.SearchProvider is not null && search is null)
            throw new InvalidOperationException("The saved search provider is unavailable for this agent.");
        this.ClearSecrets();
        if (search is not null) this.SearchProvider.SelectedItem = search;
        this.SearchEnabled.IsChecked = options.SearchProvider is not null;
        this.TelegramEnabled.IsChecked = options.Messaging.ContainsKey("telegram");
        this.DiscordEnabled.IsChecked = options.Messaging.ContainsKey("discord");
        this.SlackEnabled.IsChecked = options.Messaging.ContainsKey("slack");
        this.TelegramUsers.Text = string.Join(", ", options.Messaging.GetValueOrDefault("telegram") ?? Array.Empty<string>());
        this.DiscordUsers.Text = string.Join(", ", options.Messaging.GetValueOrDefault("discord") ?? Array.Empty<string>());
        this.SlackUsers.Text = string.Join(", ", options.Messaging.GetValueOrDefault("slack") ?? Array.Empty<string>());
    }

    internal NativeServiceCredentials CopyCredentials()
    {
        this.ReadOptions();
        var result = new NativeServiceCredentials();
        try
        {
            if (this.SearchEnabled.IsChecked == true && this.SearchProvider.SelectedItem is ComboBoxItem { Tag: string service }) result[service] = this.SearchKey.SecurePassword;
            if (this.TelegramEnabled.IsChecked == true) result["telegram"] = this.TelegramKey.SecurePassword;
            if (this.DiscordEnabled.IsChecked == true) result["discord"] = this.DiscordKey.SecurePassword;
            if (this.SlackEnabled.IsChecked == true) { result["slack-bot"] = this.SlackBotKey.SecurePassword; result["slack-app"] = this.SlackAppKey.SecurePassword; }
            if (result.Values.Any(secret => secret.Length == 0)) throw new InvalidOperationException("Enter the required keys for each enabled integration.");
            return result;
        }
        catch { result.Dispose(); throw; }
    }

    internal void ClearSecrets()
    {
        foreach (var box in new[] { this.SearchKey, this.TelegramKey, this.DiscordKey, this.SlackBotKey, this.SlackAppKey }) box.Clear();
    }

    private static string[] UserIds(string text) => text.Split(new[] { ',', ' ', '\t', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Distinct(StringComparer.Ordinal).ToArray();

    private void SelectionChanged(object sender, RoutedEventArgs args)
    {
        if (this.SearchFields is null) return;
        this.SearchFields.Visibility = this.SearchEnabled.IsChecked == true ? Visibility.Visible : Visibility.Collapsed;
        this.TelegramFields.Visibility = this.TelegramEnabled.IsChecked == true ? Visibility.Visible : Visibility.Collapsed;
        this.DiscordFields.Visibility = this.DiscordEnabled.IsChecked == true ? Visibility.Visible : Visibility.Collapsed;
        this.SlackFields.Visibility = this.SlackEnabled.IsChecked == true ? Visibility.Visible : Visibility.Collapsed;
    }

    private void SearchProviderChanged(object sender, SelectionChangedEventArgs args)
    {
        if (this.SearchKey is null) return;
        this.SearchKey.Clear();
        this.SearchHelp.NavigateUri = new Uri((this.SearchProvider.SelectedItem as ComboBoxItem)?.Tag as string == "brave" ? "https://api-dashboard.search.brave.com/" : "https://app.tavily.com/home");
    }

    private void OpenHelp(object sender, RoutedEventArgs args)
    {
        if (sender is not Hyperlink { NavigateUri: Uri uri } || uri.Scheme != "https") return;
        try { Process.Start(new ProcessStartInfo { FileName = uri.AbsoluteUri, UseShellExecute = true })?.Dispose(); }
        catch (Exception) { this.HelpError.Text = $"Open this official page in your browser: {uri.AbsoluteUri}"; this.HelpError.Visibility = Visibility.Visible; }
    }
}
