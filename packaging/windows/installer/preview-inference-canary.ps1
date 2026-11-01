# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# This endpoint records connections without reading credentials or serving a model.
function Start-PreviewInferenceCanary {
    param([Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{32}$')][string]$Nonce)
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $cancellation = [Threading.CancellationTokenSource]::new()
    try {
        $listener.ExclusiveAddressUse = $true
        $listener.Start(1)
        $accept = $listener.AcceptTcpClientAsync($cancellation.Token).AsTask()
        return [pscustomobject]@{
            listener = $listener; cancellation = $cancellation; accept = $accept; closed = $false
            endpoint = "http://127.0.0.1:$($listener.LocalEndpoint.Port)/canary-$Nonce/v1"
        }
    } catch {
        $listener.Stop()
        $cancellation.Dispose()
        throw
    }
}

function Stop-PreviewInferenceCanary {
    param([Parameter(Mandatory)]$Canary)
    if ($Canary.closed) { throw 'The inference canary was already closed.' }
    try {
        # Call only after the owned setup/session closes. Cancellation also settles
        # the pending accept; a connection that already completed remains visible.
        $Canary.cancellation.Cancel()
        if ([Threading.Tasks.Task]::WaitAny([Threading.Tasks.Task[]]@($Canary.accept), 5000) -lt 0) {
            throw 'The inference canary accept did not settle.'
        }
        $connected = -not $Canary.accept.IsCanceled
        if ($connected) {
            $client = $Canary.accept.GetAwaiter().GetResult()
            $client.Dispose()
        }
        if ($connected -or $Canary.listener.Pending()) {
            throw 'The migration fixture attempted an inference connection.'
        }
        return [pscustomobject]@{ classification = 'owned-loopback-inference-canary'; connectionsObserved = 0; closed = $true }
    } finally {
        $Canary.listener.Stop()
        $Canary.cancellation.Dispose()
        $Canary.closed = $true
    }
}
