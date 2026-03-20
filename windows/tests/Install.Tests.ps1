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
