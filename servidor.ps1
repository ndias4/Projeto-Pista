# PISTA - servidor local de testes (nao precisa instalar nada)
# Serve a pasta "site" em http://127.0.0.1:8888/
# O Spotify exige exatamente este endereco como Redirect URI: http://127.0.0.1:8888/callback

param([int]$Port = 8888, [switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = [System.IO.Path]::GetFullPath((Join-Path $base 'site'))
if (-not $root.EndsWith([System.IO.Path]::DirectorySeparatorChar)) { $root = $root + [System.IO.Path]::DirectorySeparatorChar }

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.ico'  = 'image/x-icon'
  '.webmanifest' = 'application/manifest+json'
  '.txt'  = 'text/plain; charset=utf-8'
}

$global:partyStateJson = '{"partyName":"Festa","current":null,"phase":"warmup","tracks":[]}'
$global:guestRequests = New-Object System.Collections.ArrayList

# IP local na rede Wi-Fi / Ethernet para os convidados conectarem pelo celular
$localIp = '127.0.0.1'
try {
  $netIp = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias 'Ethernet*', 'Wi-Fi*', 'Local Area Connection*' -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '169.254*' -and $_.IPAddress -ne '127.0.0.1' } | Select-Object -First 1).IPAddress
  if ($netIp) {
    $localIp = $netIp
  } else {
    $ips = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) | Where-Object {
      $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and
      $_.ToString() -ne '127.0.0.1' -and
      $_.ToString() -notlike '169.254*'
    }
    if ($ips.Count -gt 0) { $localIp = $ips[0].ToString() }
  }
} catch { }

try {
  $listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Any), $Port
  $listener.Start()
} catch {
  Write-Host ''
  Write-Host "ERRO: a porta $Port ja esta em uso." -ForegroundColor Red
  Write-Host 'Provavelmente o PISTA ja esta aberto em outra janela. Feche-a e tente de novo.'
  Write-Host ''
  Read-Host 'Pressione Enter para sair'
  exit 1
}

$url = "http://127.0.0.1:$Port/"
$guestUrl = "http://${localIp}:$Port/guest"
Write-Host ''
Write-Host '  =======================================================' -ForegroundColor DarkYellow
Write-Host '   PISTA (versao de teste) esta rodando' -ForegroundColor Yellow
Write-Host "   Painel do Anfitriao: $url" -ForegroundColor Yellow
Write-Host "   Link para Convidados: $guestUrl" -ForegroundColor Cyan
Write-Host '   Para desligar: feche esta janela.' -ForegroundColor Yellow
Write-Host '  =======================================================' -ForegroundColor DarkYellow
Write-Host ''
if (-not $NoBrowser) { Start-Process $url }

function Send-Response($stream, [int]$code, [string]$status, [string]$type, [byte[]]$body) {
  $head = "HTTP/1.1 $code $status`r`nContent-Type: $type`r`nContent-Length: $($body.Length)`r`nAccess-Control-Allow-Origin: *`r`nAccess-Control-Allow-Methods: GET, POST, OPTIONS`r`nAccess-Control-Allow-Headers: Content-Type`r`nCache-Control: no-store`r`nX-Content-Type-Options: nosniff`r`nConnection: close`r`n`r`n"
  $hb = [System.Text.Encoding]::ASCII.GetBytes($head)
  $stream.Write($hb, 0, $hb.Length)
  if ($body.Length -gt 0) { $stream.Write($body, 0, $body.Length) }
  $stream.Flush()
}

function Handle-Client($client) {
  $stream = $client.GetStream()
  $buf = New-Object byte[] 32768
  $sb = New-Object System.Text.StringBuilder
  $deadline = [DateTime]::UtcNow.AddSeconds(3)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($client.Available -gt 0) {
      $n = $stream.Read($buf, 0, $buf.Length)
      if ($n -le 0) { break }
      [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buf, 0, $n))
      if ($sb.ToString().Contains("`r`n`r`n")) { break }
    } else { Start-Sleep -Milliseconds 5 }
  }
  $req = $sb.ToString()
  if (-not $req) { return }
  $first = $req.Split("`n")[0].Trim()
  $parts = $first.Split(' ')
  if ($parts.Length -lt 2) { return }
  $method = $parts[0]
  $path = $parts[1].Split('?')[0]
  try { $path = [Uri]::UnescapeDataString($path) } catch { }

  if ($method -eq 'OPTIONS') {
    Send-Response $stream 204 'No Content' 'text/plain' (New-Object byte[] 0)
    return
  }

  # Extrai corpo POST se houver
  $bodyStr = ''
  $splitIdx = $req.IndexOf("`r`n`r`n")
  if ($splitIdx -ge 0) {
    $bodyStr = $req.Substring($splitIdx + 4)
  }

  # --- Informacoes de rede para o painel do anfitriao ---
  if ($path -eq '/api/network-info' -and $method -eq 'GET') {
    $netJson = @{
      localIp = $localIp
      port = $Port
      guestUrl = "http://${localIp}:$Port/guest"
    } | ConvertTo-Json -Compress
    Send-Response $stream 200 'OK' 'application/json' ([System.Text.Encoding]::UTF8.GetBytes($netJson))
    return
  }

  # --- APIs para Convidados (RF-21) ---
  if ($path -eq '/api/party/sync' -and $method -eq 'POST') {
    if ($bodyStr) { $global:partyStateJson = $bodyStr }
    Send-Response $stream 200 'OK' 'application/json' ([System.Text.Encoding]::UTF8.GetBytes('{"ok":true}'))
    return
  }
  if ($path -eq '/api/party/catalog' -and $method -eq 'GET') {
    Send-Response $stream 200 'OK' 'application/json' ([System.Text.Encoding]::UTF8.GetBytes($global:partyStateJson))
    return
  }
  if ($path -eq '/api/guest/suggest' -and $method -eq 'POST') {
    try {
      $item = $bodyStr | ConvertFrom-Json
      $token = $item.guestToken
      # Limite de 3 pedidos pendentes por convidado (RF-21)
      $pendingCount = 0
      foreach ($r in $global:guestRequests) {
        if ($r.guestToken -eq $token -and $r.status -eq 'pending') { $pendingCount++ }
      }
      if ($pendingCount -ge 3) {
        Send-Response $stream 429 'Too Many Requests' 'application/json' ([System.Text.Encoding]::UTF8.GetBytes('{"error":"Limite de 3 pedidos atingido. Aguarde o DJ tocar algum!"}'))
        return
      }
      $reqObj = [pscustomobject]@{
        id = [Guid]::NewGuid().ToString().Substring(0,8)
        trackId = $item.trackId
        title = $item.title
        artist = $item.artist
        guestToken = $token
        status = 'pending'
        time = (Get-Date).ToString('HH:mm')
      }
      [void]$global:guestRequests.Add($reqObj)
      Send-Response $stream 200 'OK' 'application/json' ([System.Text.Encoding]::UTF8.GetBytes('{"ok":true,"message":"Pedido enviado com sucesso!"}'))
    } catch {
      Send-Response $stream 400 'Bad Request' 'application/json' ([System.Text.Encoding]::UTF8.GetBytes('{"error":"Dados invalidos"}'))
    }
    return
  }
  if ($path -eq '/api/host/requests' -and $method -eq 'GET') {
    $json = $global:guestRequests | ConvertTo-Json -Compress
    if (-not $json -or $json -eq 'null') { $json = '[]' }
    Send-Response $stream 200 'OK' 'application/json' ([System.Text.Encoding]::UTF8.GetBytes($json))
    return
  }
  if ($path -eq '/api/host/requests/resolve' -and $method -eq 'POST') {
    try {
      $p = $bodyStr | ConvertFrom-Json
      for ($i = $global:guestRequests.Count - 1; $i -ge 0; $i--) {
        if ($global:guestRequests[$i].id -eq $p.requestId) {
          if ($p.action -eq 'remove' -or $p.action -eq 'decline') {
            $global:guestRequests.RemoveAt($i)
          } else {
            $global:guestRequests[$i].status = $p.action
          }
          break
        }
      }
      Send-Response $stream 200 'OK' 'application/json' ([System.Text.Encoding]::UTF8.GetBytes('{"ok":true}'))
    } catch {
      Send-Response $stream 400 'Bad Request' 'application/json' ([System.Text.Encoding]::UTF8.GetBytes('{"error":"Erro"}'))
    }
    return
  }

  if ($method -ne 'GET' -and $method -ne 'HEAD') {
    Send-Response $stream 405 'Method Not Allowed' 'text/plain' ([System.Text.Encoding]::UTF8.GetBytes('405'))
    return
  }

  if ($path -eq '/' -or $path -eq '/callback' -or $path -eq '/callback/') { $path = '/index.html' }
  if ($path -eq '/guest' -or $path -eq '/pedir' -or $path -eq '/guest/') { $path = '/guest.html' }

  $rel = $path.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)
  $full = [System.IO.Path]::GetFullPath((Join-Path $root $rel))
  if (-not $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
    Send-Response $stream 404 'Not Found' 'text/plain; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes('404 - nao encontrado'))
    Write-Host "  404 $path" -ForegroundColor DarkGray
    return
  }
  $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
  $type = $mime[$ext]
  if (-not $type) { $type = 'application/octet-stream' }
  $bytes = [System.IO.File]::ReadAllBytes($full)
  if ($method -eq 'HEAD') { $bytes = New-Object byte[] 0 }
  Send-Response $stream 200 'OK' $type $bytes
}

# Loop sem bloqueio: o Chrome abre conexoes "de reserva" que nao enviam nada;
# elas ficam numa lista de espera e nao travam as outras.
$pending = New-Object System.Collections.ArrayList
while ($true) {
  while ($listener.Pending()) {
    $c = $listener.AcceptTcpClient()
    [void]$pending.Add([pscustomobject]@{ Client = $c; Since = [DateTime]::UtcNow })
  }
  for ($i = $pending.Count - 1; $i -ge 0; $i--) {
    $p = $pending[$i]
    $drop = $false
    try {
      if ($p.Client.Available -gt 0) {
        Handle-Client $p.Client
        $drop = $true
      } elseif (([DateTime]::UtcNow - $p.Since).TotalSeconds -gt 20 -or -not $p.Client.Connected) {
        $drop = $true
      }
    } catch {
      $drop = $true
    }
    if ($drop) {
      try { $p.Client.Close() } catch { }
      $pending.RemoveAt($i)
    }
  }
  Start-Sleep -Milliseconds 10
}
