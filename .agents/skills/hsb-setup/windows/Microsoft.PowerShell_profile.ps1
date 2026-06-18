function hsb {
    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force

    $skillPath = "C:\Users\yosil\.claude\skills\hsb-setup-skill\windows"
    $profileDir = Join-Path $skillPath 'profiles'

    if (!(Test-Path $skillPath)) {
        Write-Host "Skill path not found: $skillPath" -ForegroundColor Red
        return
    }

    if (!(Test-Path $profileDir)) {
        Write-Host "Profiles directory not found: $profileDir" -ForegroundColor Red
        return
    }

    $profiles = Get-ChildItem -Path $profileDir -Filter '*-env.ps1' |
        Where-Object { $_.Name -ne 'example-env.ps1' } |
        Sort-Object Name

    if ($profiles.Count -eq 0) {
        Write-Host "No environment profiles found in $profileDir" -ForegroundColor Red
        Write-Host "Create one by copying profiles\example-env.ps1 to profiles\<name>-env.ps1" -ForegroundColor Yellow
        return
    }

    Write-Host ""
    Write-Host "  HSB Environment Profiles" -ForegroundColor Cyan
    Write-Host "  ========================" -ForegroundColor Cyan
    Write-Host ""

    for ($i = 0; $i -lt $profiles.Count; $i++) {
        $name = $profiles[$i].BaseName -replace '-env$', ''
        $preview = ""
        $content = Get-Content $profiles[$i].FullName -ErrorAction SilentlyContinue
        $target = ($content | Select-String -Pattern '^\$env:SSH_TARGET\s*=\s*''([^'']+)''' | Select-Object -First 1)
        $platform = ($content | Select-String -Pattern '^\$env:HSB_PLATFORM\s*=\s*''([^'']+)''' | Select-Object -First 1)
        if ($target) { $preview += $target.Matches[0].Groups[1].Value }
        if ($platform) { $preview += " ($($platform.Matches[0].Groups[1].Value))" }
        Write-Host "  [$($i + 1)] $name" -ForegroundColor Green -NoNewline
        if ($preview) { Write-Host "  -  $preview" -ForegroundColor DarkGray } else { Write-Host "" }
    }

    Write-Host ""
    $choice = Read-Host "  Select profile [1-$($profiles.Count)]"

    if ($choice -match '^\d+$') {
        $idx = [int]$choice - 1
    } else {
        Write-Host "Invalid selection." -ForegroundColor Red
        return
    }

    if ($idx -lt 0 -or $idx -ge $profiles.Count) {
        Write-Host "Selection out of range." -ForegroundColor Red
        return
    }

    $selected = $profiles[$idx]
    $profileName = $selected.BaseName -replace '-env$', ''

    Set-Location $skillPath
    Write-Host ""
    . .\set-hsb-env.ps1 -Profile $profileName

    if (-not $env:SSH_TARGET) {
        Write-Host "Failed to load environment variables." -ForegroundColor Red
        return
    }

    Write-Host "Launching Claude..." -ForegroundColor Cyan
    claude
}
