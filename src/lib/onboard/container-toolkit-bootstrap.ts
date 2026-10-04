// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type ContainerToolkitPackageManager = "apt" | "dnf" | "yum" | "brew" | "pacman" | "unknown";

export function buildContainerToolkitBootstrapCommands(
  packageManager: ContainerToolkitPackageManager | undefined,
  generateCommands: readonly string[],
): string[] {
  const installGuide =
    "https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html";
  if (packageManager === "apt") {
    return [
      "curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg",
      "curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#' | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list",
      "sudo apt-get update",
      "sudo apt-get install -y nvidia-container-toolkit",
      ...generateCommands,
    ];
  }
  if (packageManager === "dnf" || packageManager === "yum") {
    const pmCommand = packageManager === "dnf" ? "dnf" : "yum";
    return [
      "curl -s -L https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo | sudo tee /etc/yum.repos.d/nvidia-container-toolkit.repo",
      `sudo ${pmCommand} install -y nvidia-container-toolkit`,
      ...generateCommands,
    ];
  }
  return [
    `# Install nvidia-container-toolkit per NVIDIA's install guide: ${installGuide}`,
    ...generateCommands,
  ];
}
