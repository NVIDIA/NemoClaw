# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ConvertTo-WslPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WindowsPath
    )

    if ($WindowsPath -notmatch '^(?<drive>[A-Za-z]):(?<rest>[\\/].*)$') {
        throw "Expected a drive-qualified Windows path, got '$WindowsPath'."
    }

    $drive = $Matches.drive.ToLowerInvariant()
    $rest = $Matches.rest.Replace('\', '/')
    return "/mnt/$drive$rest"
}

function ConvertTo-BashLiteral {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Value
    )

    $singleQuote = [string][char]39
    $doubleQuote = [string][char]34
    $escapedQuote = $singleQuote + $doubleQuote + $singleQuote + $doubleQuote + $singleQuote
    return $singleQuote + $Value.Replace($singleQuote, $escapedQuote) + $singleQuote
}

function Write-WslScriptFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Content
    )

    $normalized = $Content.Replace("`r`n", "`n").Replace("`r", "`n")
    [IO.File]::WriteAllText(
        $Path,
        $normalized,
        (New-Object System.Text.UTF8Encoding $false)
    )
}

function New-WslScriptArguments {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Distro,

        [Parameter(Mandatory = $true)]
        [string]$ScriptPath,

        [string]$User,

        [string[]]$ScriptArguments = @()
    )

    $commandArguments = @('-d', $Distro)
    if ($User) {
        $commandArguments += @('--user', $User)
    }
    $commandArguments += @('--', 'bash', '-l', $ScriptPath)
    $commandArguments += $ScriptArguments
    return ,$commandArguments
}

function Invoke-WslNative {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$ArgumentList,

        [switch]$MergeError
    )

    if ($MergeError) {
        & wsl @ArgumentList 2>&1 | Out-Default
    } else {
        & wsl @ArgumentList | Out-Default
    }
    return $LASTEXITCODE
}

function Invoke-WslNativeOutput {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$ArgumentList
    )

    $output = @(& wsl @ArgumentList 2>&1)
    return [pscustomobject]@{
        ExitCode = $LASTEXITCODE
        Output = $output
    }
}

function Invoke-WslScript {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Distro,

        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Script,

        [string]$User,

        [string[]]$ScriptArguments = @(),

        [switch]$CaptureOutput
    )

    if (-not $env:RUNNER_TEMP) {
        throw 'RUNNER_TEMP is required to transfer a script into WSL.'
    }

    $hostPath = Join-Path -Path $env:RUNNER_TEMP -ChildPath 'nemoclaw-wsl-step.sh'
    try {
        Write-WslScriptFile -Path $hostPath -Content $Script
        $wslPath = ConvertTo-WslPath -WindowsPath $hostPath
        $commandArguments = New-WslScriptArguments `
            -Distro $Distro `
            -ScriptPath $wslPath `
            -User $User `
            -ScriptArguments $ScriptArguments

        if ($CaptureOutput) {
            $result = Invoke-WslNativeOutput -ArgumentList $commandArguments
            if ($result.ExitCode -ne 0) {
                throw "WSL script exited with code $($result.ExitCode)."
            }
            return (@($result.Output) -join "`n")
        }

        $exitCode = Invoke-WslNative -ArgumentList $commandArguments
        if ($exitCode -ne 0) {
            throw "WSL script exited with code $exitCode."
        }
    }
    finally {
        Remove-Item -LiteralPath $hostPath -Force -ErrorAction SilentlyContinue
    }
}

function Set-WslWorkflowPaths {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Workspace,

        [Parameter(Mandatory = $true)]
        [string]$WorkdirPrefix,

        [Parameter(Mandatory = $true)]
        [string]$RunId,

        [Parameter(Mandatory = $true)]
        [string]$RunAttempt,

        [Parameter(Mandatory = $true)]
        [string]$EnvironmentFile
    )

    $checkout = ConvertTo-WslPath -WindowsPath $Workspace
    $workdir = "$WorkdirPrefix/$RunId-$RunAttempt"
    "WSL_CHECKOUT_DIR=$checkout" | Out-File -FilePath $EnvironmentFile -Encoding utf8 -Append
    "WSL_WORKDIR=$workdir" | Out-File -FilePath $EnvironmentFile -Encoding utf8 -Append
    Write-Host "WSL_CHECKOUT_DIR=$checkout"
    Write-Host "WSL_WORKDIR=$workdir"

    return [pscustomobject]@{
        Checkout = $checkout
        Workdir = $workdir
    }
}

function Ensure-WslDistro {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Distro,

        [ValidateRange(1, 10)]
        [int]$MaxAttempts = 3
    )

    $null = Invoke-WslNative -ArgumentList @('--list', '--verbose') -MergeError
    $probeExitCode = Invoke-WslNative `
        -ArgumentList @('-d', $Distro, '--', 'echo', 'ok') `
        -MergeError

    if ($probeExitCode -ne 0) {
        $installed = $false
        for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
            Write-Host "Ubuntu not found - installing via wsl --install (attempt $attempt/$MaxAttempts)"
            $installExitCode = Invoke-WslNative `
                -ArgumentList @('--install', '-d', $Distro, '--no-launch', '--web-download') `
                -MergeError
            if ($installExitCode -eq 0) {
                $launchExitCode = Invoke-WslNative `
                    -ArgumentList @('-d', $Distro, '--', 'bash', '-c', 'echo distro initialised') `
                    -MergeError
                if ($launchExitCode -eq 0) {
                    $installed = $true
                    break
                }
                Write-Warning "distro first-launch failed with exit code $launchExitCode"
            } else {
                Write-Warning "wsl --install failed with exit code $installExitCode"
            }

            # Some WSL installs return a non-zero code after registering a usable distro.
            $probeExitCode = Invoke-WslNative `
                -ArgumentList @('-d', $Distro, '--', 'echo', 'ok') `
                -MergeError
            if ($probeExitCode -eq 0) {
                Write-Host 'Ubuntu became available after the install command returned non-zero'
                $installed = $true
                break
            }

            if ($attempt -lt $MaxAttempts) {
                Write-Host 'Cleaning up any partial WSL registration before retrying'
                $null = Invoke-WslNative `
                    -ArgumentList @('--unregister', $Distro) `
                    -MergeError
                $delaySeconds = [Math]::Min(60, 20 * $attempt)
                Write-Host "Retrying WSL install in $delaySeconds seconds..."
                Start-Sleep -Seconds $delaySeconds
            }
        }

        if (-not $installed) {
            throw "failed to install and initialize $Distro after $MaxAttempts attempts"
        }
    } else {
        Write-Host 'Ubuntu already available'
    }

    $defaultExitCode = Invoke-WslNative -ArgumentList @('--set-default', $Distro)
    if ($defaultExitCode -ne 0) {
        throw "wsl --set-default failed with exit code $defaultExitCode"
    }
}

function Get-WslUbuntuDependenciesScript {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Packages
    )

    foreach ($package in $Packages) {
        if ($package -notmatch '^[a-z0-9][a-z0-9+.-]*$') {
            throw "Invalid Ubuntu package name '$package'."
        }
    }
    $packageList = $Packages -join ' '

    return @"
set -euo pipefail
test_user="`${1:-}"
export DEBIAN_FRONTEND=noninteractive
printf '%s\n' \
  'Acquire::ForceIPv4 "true";' \
  'Acquire::Retries "5";' \
  >/etc/apt/apt.conf.d/99github-actions-network
apt-get update
apt-get install -y $packageList
if [ -n "`$test_user" ] && ! id -u "`$test_user" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "`$test_user"
fi
"@
}

function Install-WslUbuntuDependencies {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Distro,

        [Parameter(Mandatory = $true)]
        [string[]]$Packages,

        [string]$TestUser
    )

    $invokeParameters = @{
        Distro = $Distro
        User = 'root'
        Script = Get-WslUbuntuDependenciesScript -Packages $Packages
    }
    if ($TestUser) {
        $invokeParameters.ScriptArguments = @($TestUser)
    }
    Invoke-WslScript @invokeParameters
}

function Get-WslNodeInstallScript {
    return @'
set -euo pipefail
node_version="22.23.1"
case "$(uname -m)" in
  x86_64)
    node_arch="x64"
    node_sha256="9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578"
    ;;
  aarch64 | arm64)
    node_arch="arm64"
    node_sha256="0294e8b915ab75f92c7513d2fcb830ae06e10684e6c603e99a87dbf8835389c1"
    ;;
  *)
    echo "Unsupported Node.js architecture: $(uname -m)" >&2
    exit 1
    ;;
esac
node_url="https://nodejs.org/dist/v${node_version}/node-v${node_version}-linux-${node_arch}.tar.xz"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
archive="$temp_dir/node.tar.xz"
curl --fail --show-error --silent --location \
  --proto '=https' --tlsv1.2 \
  --connect-timeout 15 --max-time 180 \
  --retry 3 --retry-delay 2 --retry-max-time 240 --retry-all-errors \
  --output "$archive" "$node_url"
printf '%s  %s\n' "$node_sha256" "$archive" | sha256sum --check --status || {
  echo "Node.js archive checksum verification failed" >&2
  exit 1
}
tar --extract --xz --file "$archive" --directory /usr/local --strip-components=1
test "$(node --version)" = "v${node_version}"
node --version
npm --version
'@
}

function Install-WslNode {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Distro
    )

    Invoke-WslScript `
        -Distro $Distro `
        -User root `
        -Script (Get-WslNodeInstallScript)
}

function Get-WslCheckoutSyncScript {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Checkout,

        [Parameter(Mandatory = $true)]
        [string]$Workdir,

        [string]$Owner
    )

    if ($Owner -and $Owner -notmatch '^[a-z_][a-z0-9_-]*$') {
        throw "Invalid WSL owner '$Owner'."
    }

    $normalizedCheckout = $Checkout.TrimEnd('/')
    $normalizedWorkdir = $Workdir.TrimEnd('/')
    $dedicatedWorkdirPattern = '^/tmp/nemoclaw-wsl-(?:workdir|vitest)/[1-9][0-9]*-[1-9][0-9]*$'
    $workdirUsesDedicatedRoot = $normalizedWorkdir -cmatch $dedicatedWorkdirPattern
    $unsafePathSegment = '(^|/)\.{1,2}(/|$)'
    $pathsOverlap = $normalizedCheckout -eq $normalizedWorkdir -or
        $normalizedCheckout.StartsWith(
            "$normalizedWorkdir/",
            [StringComparison]::Ordinal
        ) -or
        $normalizedWorkdir.StartsWith(
            "$normalizedCheckout/",
            [StringComparison]::Ordinal
        )
    if (
        [string]::IsNullOrWhiteSpace($normalizedWorkdir) -or
        -not $normalizedWorkdir.StartsWith('/') -or
        $normalizedWorkdir -eq '/' -or
        -not $workdirUsesDedicatedRoot -or
        $normalizedWorkdir -match $unsafePathSegment -or
        $pathsOverlap
    ) {
        throw "WSL sync workdir must use /tmp/nemoclaw-wsl-workdir or /tmp/nemoclaw-wsl-vitest with one <positive-run-id>-<positive-run-attempt> child. It must not overlap the checkout or contain traversal: '$Workdir'."
    }

    $workdirRoot = $normalizedWorkdir.Substring(0, $normalizedWorkdir.LastIndexOf('/'))
    $checkoutLiteral = ConvertTo-BashLiteral -Value $Checkout
    $checkoutGitLiteral = ConvertTo-BashLiteral -Value "$Checkout/.git"
    $workdirLiteral = ConvertTo-BashLiteral -Value $Workdir
    $workdirRootLiteral = ConvertTo-BashLiteral -Value $workdirRoot
    $ownerCommand = if ($Owner) {
        $ownerGroupLiteral = ConvertTo-BashLiteral -Value "${Owner}:${Owner}"
        "chown -R $ownerGroupLiteral $workdirLiteral"
    } else {
        ''
    }

    return @(
        'set -euo pipefail'
        "echo 'Syncing checkout into WSL ext4 workspace'"
        "if [ ! -d $checkoutGitLiteral ]; then"
        "  echo 'Expected a Git checkout at the resolved WSL path' >&2"
        '  exit 1'
        'fi'
        "# Keep npm and test I/O on WSL's ext4 VHD instead of DrvFS."
        "mkdir -p $workdirRootLiteral"
        "if [ -L $workdirRootLiteral ]; then"
        "  echo 'Refusing a symlinked WSL CI workdir root' >&2"
        '  exit 1'
        'fi'
        "rm -rf $workdirLiteral"
        'rsync -a --no-owner --no-group --delete \'
        "  --exclude '/node_modules/' \"
        "  --exclude '/nemoclaw/node_modules/' \"
        "  --exclude '/nemoclaw-blueprint/.venv/' \"
        "  $checkoutLiteral/ $workdirLiteral/"
        "git config --global --add safe.directory $workdirLiteral"
        "git -C $workdirLiteral reset --hard HEAD"
        "git -C $workdirLiteral clean -ffdx"
        $ownerCommand
        "git -C $workdirLiteral status --short"
        "echo 'WSL ext4 workspace is ready'"
    ) -join "`n"
}

function Sync-WslCheckout {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Distro,

        [Parameter(Mandatory = $true)]
        [string]$Checkout,

        [Parameter(Mandatory = $true)]
        [string]$Workdir,

        [string]$Owner
    )

    $script = Get-WslCheckoutSyncScript `
        -Checkout $Checkout `
        -Workdir $Workdir `
        -Owner $Owner
    Invoke-WslScript -Distro $Distro -User root -Script $script
}
