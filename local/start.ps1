# CongLive local LAN host for Windows (Docker Desktop required).
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw '需要 Docker Desktop（含 docker compose）' }
docker compose version | Out-Null

$lanIp = $env:LOCAL_IP
if (-not $lanIp) {
  $lanIp = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
    Select-Object -ExpandProperty IPAddress -First 1)
}
if (-not $lanIp) { $lanIp = '127.0.0.1' }
$envFile = 'local/.env.local'
function New-Secret { -join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) }) }
if (-not (Test-Path $envFile)) {
  @"
PUBLIC_HOST=$lanIp
CANDIDATE=$lanIp
PUBLIC_API_SCHEME=http
PUBLIC_API_PORT=8081
API_BIND=127.0.0.1
WEB_BIND=0.0.0.0
RTC_BIND=0.0.0.0
WEB_PORT=8081
SRS_HTTP_BIND=127.0.0.1
JWT_SECRET=$(New-Secret)
MYSQL_ROOT_PASSWORD=$(New-Secret)
MYSQL_PASSWORD=$(New-Secret)
SRS_HOOK_SECRET=$(New-Secret)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=$(New-Secret)
TURN_SECRET=
"@ | Set-Content -Encoding ASCII $envFile
} else {
  (Get-Content $envFile) -replace '^PUBLIC_HOST=.*', "PUBLIC_HOST=$lanIp" -replace '^CANDIDATE=.*', "CANDIDATE=$lanIp" | Set-Content -Encoding ASCII $envFile
}
$cfg = Get-Content $envFile | ForEach-Object { if ($_ -match '^([^=]+)=(.*)$') { Set-Variable -Name $matches[1] -Value $matches[2] -Scope Script } }
New-Item -ItemType Directory -Force -Path 'server/covers','server/recordings','server/plugin-data' | Out-Null
(Get-Content 'server/srs.conf') -replace '\$CANDIDATE', $CANDIDATE -replace '\$SRS_HOOK_SECRET', $SRS_HOOK_SECRET | Set-Content -Encoding ASCII 'server/srs.runtime.conf'
docker compose -p conglive-local --env-file $envFile -f server/docker-compose.yml up -d --build mysql srs backend web
Write-Host "`nCongLive 本地主机已启动"
Write-Host "  电脑/手机访问：http://${lanIp}:8081"
Write-Host "  管理员：$ADMIN_USERNAME / $ADMIN_PASSWORD"
Write-Host "  防火墙需放行 8081/tcp 和 8000/tcp+udp"
Write-Host "  停止：docker compose -p conglive-local --env-file $envFile -f server/docker-compose.yml down"
