# Local Postgres for the integration tests.
#
# Uses the binary-only PostgreSQL zip: no installer, no Windows service, no
# admin rights. The whole database lives in one folder you can delete.
#
#   .\scripts\pg-dev.ps1 init     create the data directory (once)
#   .\scripts\pg-dev.ps1 start    start on PGPORT (default 5433)
#   .\scripts\pg-dev.ps1 status
#   .\scripts\pg-dev.ps1 stop
#   .\scripts\pg-dev.ps1 url      print DATABASE_URL for this instance
#
# Port 5433 on purpose: it keeps this out of the way of any real Postgres on
# 5432. Authentication is trust and it listens on localhost only — fine for a
# throwaway test database, never for anything else.

param(
  [Parameter(Position = 0)]
  [ValidateSet('init', 'start', 'stop', 'status', 'url', 'reset')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'

$PgRoot = if ($env:PGROOT) { $env:PGROOT } else { Join-Path $HOME 'pgsql' }
$PgBin = Join-Path $PgRoot 'bin'
$PgData = if ($env:PGDATA) { $env:PGDATA } else { Join-Path $PgRoot 'data-bolsync' }
$PgPort = if ($env:PGPORT) { $env:PGPORT } else { '5433' }
$PgLog = Join-Path $PgRoot 'bolsync.log'
$DbUrl = "postgres://postgres@localhost:$PgPort/postgres"

function Assert-Binaries {
  if (-not (Test-Path (Join-Path $PgBin 'pg_ctl.exe'))) {
    throw "PostgreSQL binaries not found in $PgBin. Set PGROOT, or unzip the " +
          "binary-only package from get.enterprisedb.com there."
  }
}

switch ($Action) {
  'init' {
    Assert-Binaries
    if (Test-Path $PgData) { Write-Host "already initialised: $PgData"; break }
    & (Join-Path $PgBin 'initdb.exe') -D $PgData -U postgres -E UTF8 --locale=C -A trust | Out-Null
    Write-Host "initialised: $PgData"
  }

  'start' {
    Assert-Binaries
    if (-not (Test-Path $PgData)) { throw "not initialised. Run: .\scripts\pg-dev.ps1 init" }
    & (Join-Path $PgBin 'pg_ctl.exe') -D $PgData -l $PgLog `
      -o "-p $PgPort -c listen_addresses=localhost" -w start
    Write-Host "DATABASE_URL=$DbUrl"
  }

  'stop' {
    Assert-Binaries
    & (Join-Path $PgBin 'pg_ctl.exe') -D $PgData -m fast -w stop
  }

  'status' {
    Assert-Binaries
    & (Join-Path $PgBin 'pg_ctl.exe') -D $PgData status
  }

  'url' { Write-Output $DbUrl }

  'reset' {
    # Drop every table the schema owns, then re-apply it. Faster than re-initdb
    # and it proves the schema is still idempotent.
    Assert-Binaries
    & (Join-Path $PgBin 'psql.exe') -h localhost -p $PgPort -U postgres -d postgres `
      -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' | Out-Null
    $env:DATABASE_URL = $DbUrl
    node (Join-Path $PSScriptRoot '..\scripts\migrate.js')
    Write-Host 'schema re-applied'
  }
}
