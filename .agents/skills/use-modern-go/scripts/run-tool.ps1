$ErrorActionPreference = "Stop"

$cliVersion = (Get-Content -LiteralPath (Join-Path $PSScriptRoot "VERSION") -TotalCount 1).Trim()
$modulePath = "github.com/JetBrains/go-modern-guidelines"
$binaryName = "go-modern-guidelines.exe"

if ($env:LOCALAPPDATA) {
    $cacheRoot = Join-Path $env:LOCALAPPDATA "go-modern-guidelines"
} else {
    Write-Error "go-modern-guidelines: LOCALAPPDATA must be set"
    exit 1
}

# GO_MODERN_GUIDELINES_DEV runs the binary built by dev-install.
if ($env:GO_MODERN_GUIDELINES_DEV) {
    $devBinary = Join-Path (Join-Path $cacheRoot "dev") $binaryName
    if (-not (Test-Path -LiteralPath $devBinary -PathType Leaf)) {
        Write-Error "go-modern-guidelines: GO_MODERN_GUIDELINES_DEV is set but no dev build found; run dev-install"
        exit 1
    }
    & $devBinary @args
    exit $LASTEXITCODE
}

$installDir = Join-Path $cacheRoot $cliVersion
$binaryPath = Join-Path $installDir $binaryName

if (-not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) {
    if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
        Write-Error "go-modern-guidelines: Go toolchain is required to install $modulePath@$cliVersion"
        exit 1
    }

    $tmpDir = "$installDir.tmp.$PID"
    Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

    Write-Host "go-modern-guidelines: installing $modulePath@$cliVersion into $installDir" -ForegroundColor DarkGray

    try {
        $previousGoBin = $env:GOBIN
        $previousGoFlags = $env:GOFLAGS
        $previousGoWork = $env:GOWORK
        $previousCgoEnabled = $env:CGO_ENABLED
        $env:GOBIN = $tmpDir
        $env:GOFLAGS = ""
        $env:GOWORK = "off"
        $env:CGO_ENABLED = "0"
        Push-Location -LiteralPath $tmpDir
        try {
            go install "$modulePath@$cliVersion"
        } finally {
            Pop-Location
            $env:GOBIN = $previousGoBin
            $env:GOFLAGS = $previousGoFlags
            $env:GOWORK = $previousGoWork
            $env:CGO_ENABLED = $previousCgoEnabled
        }

        $tmpBinary = Join-Path $tmpDir $binaryName
        if (-not (Test-Path -LiteralPath $tmpBinary -PathType Leaf)) {
            Write-Error "go-modern-guidelines: go install did not produce $binaryName"
            exit 1
        }

        $actualVersion = ""
        try {
            $actualVersion = (& $tmpBinary --version 2>$null)
        } catch {
            $actualVersion = ""
        }
        if ($actualVersion -ne $cliVersion) {
            if (-not $actualVersion) {
                $actualVersion = "unknown version"
            }
            Write-Error "go-modern-guidelines: installed $actualVersion, want $cliVersion"
            exit 1
        }

        New-Item -ItemType Directory -Path $installDir -Force | Out-Null
        $stagedBinary = "$binaryPath.tmp.$PID"
        Move-Item -LiteralPath $tmpBinary -Destination $stagedBinary -Force
        Move-Item -LiteralPath $stagedBinary -Destination $binaryPath -Force
        Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    } finally {
        Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

& $binaryPath @args
exit $LASTEXITCODE
