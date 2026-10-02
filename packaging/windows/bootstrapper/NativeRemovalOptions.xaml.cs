// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Automation;

namespace Nvidia.NemoClaw.Bootstrapper;

public partial class NativeRemovalOptions : UserControl
{
    public NativeRemovalOptions()
    {
        this.InitializeComponent();
        foreach (var agent in NativeDesktopIntegration.Agents)
        {
            var checkbox = new CheckBox { Content = NativeDesktopIntegration.AgentName(agent), Tag = agent,
                Foreground = Brushes.White, Margin = new Thickness(0, 0, 14, 8) };
            AutomationProperties.SetAutomationId(checkbox, "RemoveAgent-" + agent);
            this.Agents.Children.Add(checkbox);
        }
    }

    public string[] SelectedAgents => this.RemoveData.IsChecked == true
        ? this.Agents.Children.OfType<CheckBox>().Where(value => value.IsChecked == true).Select(value => (string)value.Tag).ToArray()
        : Array.Empty<string>();

    public bool RequiresSelection => this.RemoveData.IsChecked == true && this.SelectedAgents.Length == 0;

    public void SetAvailable(bool available)
    {
        if (!available) this.RemoveData.IsChecked = false;
        this.RemoveData.IsEnabled = available;
        this.UnavailableDetail.Visibility = available ? Visibility.Collapsed : Visibility.Visible;
    }

    private void SelectionChanged(object sender, RoutedEventArgs args)
    {
        if (this.Selections is not null) this.Selections.Visibility = this.RemoveData.IsChecked == true ? Visibility.Visible : Visibility.Collapsed;
    }
}
