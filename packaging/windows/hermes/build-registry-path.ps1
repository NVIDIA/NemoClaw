# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# CI parent owns these handles across the dependency child, including failure
# and timeout cleanup. Read raw values so REG_EXPAND_SZ is restored verbatim.
function Read-BuildRegistryPath {
    param([Parameter(Mandatory)][Microsoft.Win32.RegistryKey]$Key)
    if ($Key.GetValueNames() -notcontains 'Path') {
        return [pscustomobject]@{ exists = $false; kind = $null; value = $null }
    }
    $kind = $Key.GetValueKind('Path')
    if ($kind -ne [Microsoft.Win32.RegistryValueKind]::String -and
        $kind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString) {
        throw 'A build registry PATH has an unsupported value type.'
    }
    return [pscustomobject]@{
        exists = $true; kind = $kind.ToString()
        value = $Key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    }
}

function New-BuildRegistryPathScope {
    param([Parameter(Mandatory)][Microsoft.Win32.RegistryKey]$Key,
        [Parameter(Mandatory)][string]$Name)
    try {
        return [pscustomobject]@{ key = $Key; name = $Name; before = (Read-BuildRegistryPath $Key)
            mutationAttempted = $false; scoped = $null }
    } catch { $Key.Dispose(); throw }
}

function Set-BuildRegistryPathScope {
    param([Parameter(Mandatory)][object]$Scope, [Parameter(Mandatory)][string]$Value)
    $Scope.mutationAttempted = $true
    $Scope.key.SetValue('Path', $Value, [Microsoft.Win32.RegistryValueKind]::String)
    $Scope.scoped = Read-BuildRegistryPath $Scope.key
    if (-not $Scope.scoped.exists -or $Scope.scoped.kind -cne 'String' -or $Scope.scoped.value -cne $Value) {
        throw 'A scoped build registry PATH did not read back exactly.'
    }
}

function Restore-BuildRegistryPathScopes {
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Scopes)
    $rows = [Collections.Generic.List[object]]::new()
    $errors = [Collections.Generic.List[string]]::new()
    foreach ($scope in $Scopes) {
        $after = $null; $restored = $false
        try {
            if ($scope.mutationAttempted) {
                if ($scope.before.exists) {
                    $kind = [Microsoft.Win32.RegistryValueKind]([Enum]::Parse([Microsoft.Win32.RegistryValueKind], $scope.before.kind))
                    $scope.key.SetValue('Path', $scope.before.value, $kind)
                } else { $scope.key.DeleteValue('Path', $false) }
            }
            $after = Read-BuildRegistryPath $scope.key
            $restored = $after.exists -eq $scope.before.exists -and $after.kind -ceq $scope.before.kind -and $after.value -ceq $scope.before.value
            if (-not $restored) { throw 'The original registry PATH value/type was not restored exactly.' }
        } catch { $errors.Add($scope.name + ': ' + $_.Exception.Message) }
        finally {
            try { $scope.key.Dispose() } catch { $errors.Add($scope.name + ' handle: ' + $_.Exception.Message) }
            $rows.Add([pscustomobject]@{ name = $scope.name; before = $scope.before; scoped = $scope.scoped
                after = $after; restored = $restored; mutationAttempted = $scope.mutationAttempted })
        }
    }
    return [pscustomobject]@{ paths = @($rows.ToArray()); errors = @($errors.ToArray()) }
}
