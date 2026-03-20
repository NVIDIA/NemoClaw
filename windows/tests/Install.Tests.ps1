# Pester 5.x test suite for NemoClaw Windows Installer
# Covers all PREREQ-01 through PREREQ-10 requirements with mocked system commands.
# Run: Invoke-Pester ./Install.Tests.ps1 -CI

BeforeAll {
    $env:NEMOCLAW_TESTING = "1"
    . "$PSScriptRoot\..\install.ps1"
}

AfterAll {
    $env:NEMOCLAW_TESTING = $null
}

# ---------------------------------------------------------------------------
# PREREQ-01: .bat launcher bypasses execution policy
# ---------------------------------------------------------------------------

Describe "install.bat Launcher" -Tag "Launcher", "PREREQ-01" {
    It "install.bat file exists" {
        "$PSScriptRoot\..\install.bat" | Should -Exist
    }
    It "contains ExecutionPolicy Bypass" {
        $content = Get-Content "$PSScriptRoot\..\install.bat" -Raw
        $content | Should -Match "-ExecutionPolicy Bypass"
    }
    It "contains -NoProfile flag" {
        $content = Get-Content "$PSScriptRoot\..\install.bat" -Raw
        $content | Should -Match "-NoProfile"
    }
    It "references install.ps1" {
        $content = Get-Content "$PSScriptRoot\..\install.bat" -Raw
        $content | Should -Match "install\.ps1"
    }
    It "pauses on error" {
        $content = Get-Content "$PSScriptRoot\..\install.bat" -Raw
        $content | Should -Match "pause"
    }
}

# ---------------------------------------------------------------------------
# PREREQ-02: UAC self-elevation
# ---------------------------------------------------------------------------

Describe "UAC Self-Elevation" -Tag "Elevation", "PREREQ-02" {
    It "Assert-Administrator function exists" {
        Get-Command Assert-Administrator | Should -Not -BeNullOrEmpty
    }
    It "detects administrator role via WindowsPrincipal" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match "WindowsPrincipal"
        $content | Should -Match "IsInRole"
        $content | Should -Match "Administrator"
    }
    It "re-launches with -Verb RunAs when not admin" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match "-Verb RunAs"
    }
}

# ---------------------------------------------------------------------------
# PREREQ-03: Windows version check (build 19041+)
# ---------------------------------------------------------------------------

Describe "Windows Version Check" -Tag "VersionCheck", "PREREQ-03" {
    It "Assert-WindowsVersion function exists" {
        Get-Command Assert-WindowsVersion | Should -Not -BeNullOrEmpty
    }
    It "checks build number 19041" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match "19041"
    }
    It "distinguishes Windows 10 and 11 by build 22000" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match "22000"
    }
}

# ---------------------------------------------------------------------------
# PREREQ-04: Disk space check
# ---------------------------------------------------------------------------

Describe "Disk Space Check" -Tag "DiskSpace", "PREREQ-04" {
    Context "when sufficient space" {
        It "does not throw with 15GB free" {
            Mock Get-PSDrive { [PSCustomObject]@{ Free = 15GB } }
            { Assert-DiskSpace -RequiredGB 10 } | Should -Not -Throw
        }
    }
    Context "when insufficient space" {
        It "calls exit when space below required threshold" {
            Mock Get-PSDrive { [PSCustomObject]@{ Free = 5GB } }
            Mock exit {}
            Mock Write-Err {}
            Assert-DiskSpace -RequiredGB 10
            Should -Invoke exit -Times 1
        }
    }
    It "defaults to 10GB required" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match 'RequiredGB\s*=\s*10'
    }
}

# ---------------------------------------------------------------------------
# PREREQ-05: Antivirus detection
# ---------------------------------------------------------------------------

Describe "Antivirus Detection" -Tag "Antivirus", "PREREQ-05" {
    It "Test-AntivirusInterference function exists" {
        Get-Command Test-AntivirusInterference | Should -Not -BeNullOrEmpty
    }
    It "warns when known AV process is running" {
        Mock Get-Process {
            if ($Name -eq "avastui") {
                [PSCustomObject]@{ Name = "avastui" }
            } else {
                $null
            }
        }
        Mock Write-Warn {}
        { Test-AntivirusInterference } | Should -Not -Throw
    }
    It "does not throw when no AV processes are running" {
        Mock Get-Process { $null }
        Mock Write-Info {}
        { Test-AntivirusInterference } | Should -Not -Throw
    }
    It "checks for known AV processes including avastui" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match "avastui"
    }
    It "checks for known AV processes including avgui" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match "avgui"
    }
    It "does not list msmpeng (Windows Defender) as problematic" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Not -Match "msmpeng"
    }
}

# ---------------------------------------------------------------------------
# PREREQ-06: WSL2 enablement
# ---------------------------------------------------------------------------

Describe "WSL2 Enablement" -Tag "WSL", "PREREQ-06" {
    It "Enable-WSL2 function exists" {
        Get-Command Enable-WSL2 | Should -Not -BeNullOrEmpty
    }
    It "returns false when WSL2 is already enabled" {
        Mock wsl { $global:LASTEXITCODE = 0 } -ParameterFilter { $args -contains "--status" }
        Mock Write-Info {}
        $result = Enable-WSL2
        $result | Should -Be $false
    }
    It "calls wsl --install --no-distribution when WSL not present" {
        Mock wsl {
            if ($args -contains "--status") {
                $global:LASTEXITCODE = 1
            } elseif ($args -contains "--install") {
                $global:LASTEXITCODE = 0
            }
        }
        Mock dism.exe {}
        Mock Write-Info {}
        Mock Out-Null {}
        $result = Enable-WSL2
        $result | Should -Be $true
    }
    It "uses --no-distribution flag to avoid installing Ubuntu" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match "--no-distribution"
    }
    It "falls back to DISM when wsl --install fails" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match "dism\.exe"
        $content | Should -Match "Microsoft-Windows-Subsystem-Linux"
        $content | Should -Match "VirtualMachinePlatform"
    }
}

# ---------------------------------------------------------------------------
# PREREQ-07: Registry state machine for reboot resume
# ---------------------------------------------------------------------------

Describe "Registry State Machine" -Tag "StateMachine", "PREREQ-07" {
    It "Get-InstallStage returns null when no key exists" {
        Mock Get-ItemProperty { throw "not found" }
        $result = Get-InstallStage
        $result | Should -BeNullOrEmpty
    }
    It "Set-InstallStage creates registry path if missing" {
        Mock Test-Path { $false }
        Mock New-Item {}
        Mock Set-ItemProperty {}
        Mock Out-Null {}
        Set-InstallStage -Stage "VERSION_OK"
        Should -Invoke New-Item -Times 1
        Should -Invoke Set-ItemProperty -Times 1
    }
    It "Set-InstallStage skips path creation when it already exists" {
        Mock Test-Path { $true }
        Mock Set-ItemProperty {}
        Set-InstallStage -Stage "WSL_ENABLED"
        Should -Invoke Set-ItemProperty -Times 1
    }
    It "Remove-InstallStage calls Remove-Item on the registry path" {
        Mock Remove-Item {}
        Remove-InstallStage
        Should -Invoke Remove-Item -Times 1
    }
    It "uses HKCU:\Software\NemoClaw registry path" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match 'HKCU:\\Software\\NemoClaw'
    }
    It "defines correct stage progression sequence" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match "VERSION_OK"
        $content | Should -Match "WSL_ENABLED"
        $content | Should -Match "DOCKER_INSTALLED"
        $content | Should -Match "DOCKER_CONFIGURED"
        $content | Should -Match "DOCKER_READY"
    }
}

# ---------------------------------------------------------------------------
# PREREQ-08: Docker Desktop installation (winget + EXE fallback)
# ---------------------------------------------------------------------------

Describe "Docker Desktop Installation" -Tag "DockerInstall", "PREREQ-08" {
    It "Install-DockerDesktop function exists" {
        Get-Command Install-DockerDesktop | Should -Not -BeNullOrEmpty
    }
    It "Install-DockerDesktopFromExe function exists" {
        Get-Command Install-DockerDesktopFromExe | Should -Not -BeNullOrEmpty
    }
    It "skips installation when Docker Desktop already exists" {
        Mock Test-Path { $true } -ParameterFilter { $Path -like "*Docker Desktop*" }
        Mock winget {}
        Mock Write-Info {}
        Install-DockerDesktop
        Should -Invoke winget -Times 0
    }
    It "tries winget first when available" {
        Mock Test-Path { $false } -ParameterFilter { $Path -like "*Docker Desktop*" }
        Mock Get-Command { $true } -ParameterFilter { $Name -eq "winget" }
        Mock winget { $global:LASTEXITCODE = 0 }
        Mock Write-Info {}
        Install-DockerDesktop
        Should -Invoke winget -Times 1
    }
    It "falls back to EXE download when winget unavailable" {
        Mock Test-Path { $false } -ParameterFilter { $Path -like "*Docker Desktop*" }
        Mock Get-Command { $null } -ParameterFilter { $Name -eq "winget" }
        Mock Install-DockerDesktopFromExe {}
        Mock Write-Info {}
        Install-DockerDesktop
        Should -Invoke Install-DockerDesktopFromExe -Times 1
    }
    It "falls back to EXE download when winget install fails" {
        Mock Test-Path { $false } -ParameterFilter { $Path -like "*Docker Desktop*" }
        Mock Get-Command { $true } -ParameterFilter { $Name -eq "winget" }
        Mock winget { $global:LASTEXITCODE = 1 }
        Mock Install-DockerDesktopFromExe {}
        Mock Write-Info {}
        Mock Write-Warn {}
        Install-DockerDesktop
        Should -Invoke Install-DockerDesktopFromExe -Times 1
    }
    It "uses --backend=wsl-2 for EXE installer" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match "--backend=wsl-2"
    }
    It "uses --quiet and --accept-license flags" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match "--quiet"
        $content | Should -Match "--accept-license"
    }
}

# ---------------------------------------------------------------------------
# PREREQ-09: Docker users group
# ---------------------------------------------------------------------------

Describe "Docker Users Group" -Tag "DockerGroup", "PREREQ-09" {
    It "Add-DockerUsersGroup function exists" {
        Get-Command Add-DockerUsersGroup | Should -Not -BeNullOrEmpty
    }
    It "calls Add-LocalGroupMember with docker-users group" {
        Mock Add-LocalGroupMember {}
        Mock Write-Info {}
        Add-DockerUsersGroup
        Should -Invoke Add-LocalGroupMember -Times 1
    }
    It "handles already-a-member gracefully" {
        Mock Add-LocalGroupMember { throw "already a member" }
        Mock Write-Info {}
        { Add-DockerUsersGroup } | Should -Not -Throw
    }
    It "handles other errors with a warning instead of throwing" {
        Mock Add-LocalGroupMember { throw "some other error" }
        Mock Write-Warn {}
        { Add-DockerUsersGroup } | Should -Not -Throw
    }
}

# ---------------------------------------------------------------------------
# PREREQ-10: Docker daemon readiness polling
# ---------------------------------------------------------------------------

Describe "Docker Daemon Readiness" -Tag "DaemonReady", "PREREQ-10" {
    It "Wait-DockerReady function exists" {
        Get-Command Wait-DockerReady | Should -Not -BeNullOrEmpty
    }
    It "returns true when docker info succeeds immediately" {
        Mock Get-Process { [PSCustomObject]@{ Name = "Docker Desktop" } }
        Mock docker { $global:LASTEXITCODE = 0 }
        Mock Start-Sleep {}
        Mock Write-Info {}
        Mock Write-Ok {}
        Mock Write-Host {}
        Mock Out-Null {}
        $result = Wait-DockerReady -TimeoutSeconds 10 -IntervalSeconds 1
        $result | Should -Be $true
    }
    It "returns false when Docker Desktop exe is not found" {
        Mock Get-Process { $null }
        Mock Test-Path { $false }
        Mock Write-Info {}
        Mock Write-Err {}
        $result = Wait-DockerReady -TimeoutSeconds 5 -IntervalSeconds 1
        $result | Should -Be $false
    }
    It "uses default timeout of 120 seconds" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match 'TimeoutSeconds\s*=\s*120'
    }
    It "uses default interval of 5 seconds" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match 'IntervalSeconds\s*=\s*5'
    }
}

# ---------------------------------------------------------------------------
# Utility Functions
# ---------------------------------------------------------------------------

Describe "Output Helper Functions" -Tag "Utilities" {
    It "Write-Info function exists" {
        Get-Command Write-Info | Should -Not -BeNullOrEmpty
    }
    It "Write-Warn function exists" {
        Get-Command Write-Warn | Should -Not -BeNullOrEmpty
    }
    It "Write-Err function exists" {
        Get-Command Write-Err | Should -Not -BeNullOrEmpty
    }
    It "Write-Ok function exists" {
        Get-Command Write-Ok | Should -Not -BeNullOrEmpty
    }
    It "Write-Step function exists" {
        Get-Command Write-Step | Should -Not -BeNullOrEmpty
    }
}

Describe "Retry Wrapper" -Tag "Utilities" {
    It "Invoke-WithRetry function exists" {
        Get-Command Invoke-WithRetry | Should -Not -BeNullOrEmpty
    }
    It "executes action successfully on first attempt" {
        Mock Write-Warn {}
        $executed = $false
        Invoke-WithRetry -Action { $script:executed = $true } -StepName "test"
        $script:executed | Should -Be $true
    }
}

Describe "Install-Prerequisites Orchestrator" -Tag "Orchestrator" {
    It "Install-Prerequisites function exists" {
        Get-Command Install-Prerequisites | Should -Not -BeNullOrEmpty
    }
}

Describe "Disable-DockerAutoStart" -Tag "DockerConfig" {
    It "Disable-DockerAutoStart function exists" {
        Get-Command Disable-DockerAutoStart | Should -Not -BeNullOrEmpty
    }
    It "removes Docker Desktop auto-start registry entry" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match 'CurrentVersion\\Run'
        $content | Should -Match 'Docker Desktop'
    }
}

Describe "Test Guard for Testing" -Tag "TestInfra" {
    It "install.ps1 has NEMOCLAW_TESTING guard for entry point" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match 'NEMOCLAW_TESTING'
    }
}

# ---------------------------------------------------------------------------
# SETUP-01: Named Ubuntu 22.04 container with port 18789 forwarded
# ---------------------------------------------------------------------------

Describe "Container Creation" -Tag "Container", "SETUP-01" {
    It "Remove-ExistingContainer function exists" {
        Get-Command Remove-ExistingContainer | Should -Not -BeNullOrEmpty
    }
    It "Start-NemoClawContainer function exists" {
        Get-Command Start-NemoClawContainer | Should -Not -BeNullOrEmpty
    }
    It "removes existing container before rebuild" {
        Mock docker {
            if ($args -contains "ps") { "nemoclaw" }
            elseif ($args -contains "stop") { $global:LASTEXITCODE = 0 }
            elseif ($args -contains "rm") { $global:LASTEXITCODE = 0 }
        }
        Mock Write-Info {}
        Mock Write-Ok {}
        Mock Out-Null {}
        Remove-ExistingContainer
        Should -Invoke docker -Times 3
    }
    It "skips removal when no existing container" {
        Mock docker {
            if ($args -contains "ps") { "" }
        }
        Remove-ExistingContainer
        # Only the ps check, no stop/rm
        Should -Invoke docker -Times 1
    }
    It "starts container with correct name and port" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match "--name nemoclaw"
        $content | Should -Match "-p 18789:18789"
    }
    It "runs container in detached mode" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match "docker run -d"
    }
    It "uses exact name filter with anchors for container check" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match 'name=\^nemoclaw\$'
    }
}

# ---------------------------------------------------------------------------
# SETUP-02: Desktop/NemoClaw folder creation and mount
# ---------------------------------------------------------------------------

Describe "Shared Folder" -Tag "SharedFolder", "SETUP-02" {
    It "New-NemoClawFolder function exists" {
        Get-Command New-NemoClawFolder | Should -Not -BeNullOrEmpty
    }
    It "uses GetFolderPath for OneDrive-safe Desktop path" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match '\[Environment\]::GetFolderPath\("Desktop"\)'
    }
    It "creates folder when it does not exist" {
        Mock Test-Path { $false } -ParameterFilter { $Path -like "*NemoClaw" }
        Mock New-Item { [PSCustomObject]@{ FullName = "C:\Users\test\Desktop\NemoClaw" } }
        Mock Write-Ok {}
        Mock Out-Null {}
        $result = New-NemoClawFolder
        Should -Invoke New-Item -Times 1
        $result | Should -Match "NemoClaw"
    }
    It "skips creation when folder already exists" {
        Mock Test-Path { $true } -ParameterFilter { $Path -like "*NemoClaw" }
        Mock Write-Info {}
        $result = New-NemoClawFolder
        $result | Should -Match "NemoClaw"
    }
    It "mounts shared folder into container at /home/nemoclaw/shared" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match "/home/nemoclaw/shared"
    }
    It "does not hardcode Desktop path with USERPROFILE" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        # New-NemoClawFolder should NOT use $env:USERPROFILE\Desktop
        $content | Should -Not -Match 'USERPROFILE.*\\Desktop.*NemoClaw'
    }
}

# ---------------------------------------------------------------------------
# SETUP-03: API key prompt, persist, and pass to container
# ---------------------------------------------------------------------------

Describe "API Key Handling" -Tag "ApiKey", "SETUP-03" {
    It "Save-NvidiaApiKey function exists" {
        Get-Command Save-NvidiaApiKey | Should -Not -BeNullOrEmpty
    }
    It "Get-NvidiaApiKey function exists" {
        Get-Command Get-NvidiaApiKey | Should -Not -BeNullOrEmpty
    }
    It "Request-NvidiaApiKey function exists" {
        Get-Command Request-NvidiaApiKey | Should -Not -BeNullOrEmpty
    }
    It "uses ConvertFrom-SecureString for DPAPI encryption" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match "ConvertFrom-SecureString"
    }
    It "uses SecureStringToBSTR for PS 5.1 compatible decryption" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match "SecureStringToBSTR"
        $content | Should -Match "PtrToStringAuto"
        $content | Should -Match "ZeroFreeBSTR"
    }
    It "does not use -AsPlainText on ConvertFrom-SecureString (PS7+ only)" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Not -Match "ConvertFrom-SecureString.*-AsPlainText"
    }
    It "uses Read-Host -AsSecureString for masked input" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match "Read-Host.*-AsSecureString"
    }
    It "stores API key in registry at NemoClaw path" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match 'Set-ItemProperty.*-Name ApiKey'
    }
    It "passes NVIDIA_API_KEY as env var to docker run" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match '-e.*NVIDIA_API_KEY'
    }
    It "Get-NvidiaApiKey returns null when no key stored" {
        Mock Get-ItemProperty { throw "not found" }
        $result = Get-NvidiaApiKey
        $result | Should -BeNullOrEmpty
    }
    It "Request-NvidiaApiKey skips prompt when key exists in registry" {
        Mock Get-NvidiaApiKey { "nvapi-test-key-123" }
        Mock Read-Host {}
        Mock Write-Info {}
        $result = Request-NvidiaApiKey
        $result | Should -Be "nvapi-test-key-123"
        Should -Invoke Read-Host -Times 0
    }
}

# ---------------------------------------------------------------------------
# SETUP-04: install.sh runs non-interactively inside container
# ---------------------------------------------------------------------------

Describe "Dockerfile and Image Build" -Tag "DockerBuild", "SETUP-04" {
    It "Build-NemoClawImage function exists" {
        Get-Command Build-NemoClawImage | Should -Not -BeNullOrEmpty
    }
    It "Dockerfile.nemoclaw exists" {
        "$PSScriptRoot\..\Dockerfile.nemoclaw" | Should -Exist
    }
    It "Dockerfile uses ubuntu:22.04 base" {
        $content = Get-Content "$PSScriptRoot\..\Dockerfile.nemoclaw" -Raw
        $content | Should -Match "FROM ubuntu:22.04"
    }
    It "Dockerfile sets DEBIAN_FRONTEND=noninteractive" {
        $content = Get-Content "$PSScriptRoot\..\Dockerfile.nemoclaw" -Raw
        $content | Should -Match "DEBIAN_FRONTEND=noninteractive"
    }
    It "Dockerfile installs curl, ca-certificates, git" {
        $content = Get-Content "$PSScriptRoot\..\Dockerfile.nemoclaw" -Raw
        $content | Should -Match "curl"
        $content | Should -Match "ca-certificates"
        $content | Should -Match "git"
    }
    It "Dockerfile copies and runs install.sh with non-interactive flag" {
        $content = Get-Content "$PSScriptRoot\..\Dockerfile.nemoclaw" -Raw
        $content | Should -Match "COPY install\.sh"
        $content | Should -Match "NEMOCLAW_NON_INTERACTIVE=1.*install\.sh.*--non-interactive"
    }
    It "Dockerfile copies nemoclaw-start.sh as entrypoint" {
        $content = Get-Content "$PSScriptRoot\..\Dockerfile.nemoclaw" -Raw
        $content | Should -Match "COPY scripts/nemoclaw-start\.sh"
        $content | Should -Match "nemoclaw-start"
    }
    It "Dockerfile exposes port 18789" {
        $content = Get-Content "$PSScriptRoot\..\Dockerfile.nemoclaw" -Raw
        $content | Should -Match "EXPOSE 18789"
    }
    It "Dockerfile cleans apt cache in same layer" {
        $content = Get-Content "$PSScriptRoot\..\Dockerfile.nemoclaw" -Raw
        $content | Should -Match "rm -rf /var/lib/apt/lists"
    }
    It "Build-NemoClawImage uses Dockerfile.nemoclaw path" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match "Dockerfile\.nemoclaw"
    }
}

# ---------------------------------------------------------------------------
# SETUP-05: Container health and dashboard reachability
# ---------------------------------------------------------------------------

Describe "Dashboard Health Check" -Tag "HealthCheck", "SETUP-05" {
    It "Test-DashboardReady function exists" {
        Get-Command Test-DashboardReady | Should -Not -BeNullOrEmpty
    }
    It "Show-ContainerBanner function exists" {
        Get-Command Show-ContainerBanner | Should -Not -BeNullOrEmpty
    }
    It "Install-NemoClawContainer function exists" {
        Get-Command Install-NemoClawContainer | Should -Not -BeNullOrEmpty
    }
    It "returns true when dashboard responds with 200" {
        Mock Invoke-WebRequest { [PSCustomObject]@{ StatusCode = 200 } }
        Mock Write-Info {}
        Mock Write-Host {}
        $result = Test-DashboardReady -TimeoutSeconds 10 -IntervalSeconds 1
        $result | Should -Be $true
    }
    It "returns false when dashboard never responds" {
        Mock Invoke-WebRequest { throw "Connection refused" }
        Mock Start-Sleep {}
        Mock Write-Info {}
        Mock Write-Host {}
        $result = Test-DashboardReady -TimeoutSeconds 5 -IntervalSeconds 5
        $result | Should -Be $false
    }
    It "polls http://localhost:18789" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match 'Invoke-WebRequest.*localhost:18789'
    }
    It "uses UseBasicParsing for compatibility" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match '-UseBasicParsing'
    }
    It "defaults to 180 second timeout" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match 'TimeoutSeconds\s*=\s*180'
    }
    It "defaults to 5 second interval" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match 'IntervalSeconds\s*=\s*5'
    }
    It "success banner includes container running, shared folder, dashboard reachable, and URL" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match "Container.*nemoclaw.*running"
        $content | Should -Match "Shared folder"
        $content | Should -Match "Dashboard is reachable"
        $content | Should -Match "http://localhost:18789"
    }
    It "does NOT auto-open browser" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Not -Match "Start-Process.*http"
        $content | Should -Not -Match "explorer.*http"
    }
    It "Phase 2 state machine has correct stage names" {
        $content = Get-Content "$PSScriptRoot\..\install.ps1" -Raw
        $content | Should -Match "API_KEY_STORED"
        $content | Should -Match "IMAGE_BUILT"
        $content | Should -Match "CONTAINER_RUNNING"
        $content | Should -Match "DASHBOARD_READY"
    }
}
