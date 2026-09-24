$ErrorActionPreference = 'Stop'
# Runs at.sh with Git for Windows' bash (R85). A bare `bash` on PATH is usually C:\Windows\System32\bash.exe,
# the WSL launcher, which runs a different Linux (or nothing) instead of the repo's docker-compose wrapper — so
# bash is resolved from git itself: <git>\cmd\git.exe → <git>\bin\bash.exe (also <git>\mingw64\bin\git.exe →
# <git>\bin\bash.exe), falling back to the default install directory.
function Find-GitBash {
  $candidates = @()
  $git = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $git) {
    $gitDir = Split-Path -Parent $git.Source
    $candidates += Join-Path $gitDir '..\bin\bash.exe'
    $candidates += Join-Path $gitDir '..\..\bin\bash.exe'
  }
  $candidates += Join-Path $env:ProgramFiles 'Git\bin\bash.exe'
  foreach ($c in $candidates) {
    if (Test-Path -LiteralPath $c -PathType Leaf) { return (Resolve-Path -LiteralPath $c).Path }
  }
  throw "Git Bash not found (looked for: $($candidates -join ', ')). Install Git for Windows: https://git-scm.com/download/win"
}

$bash = Find-GitBash
& $bash "$PSScriptRoot/at.sh" @args
exit $LASTEXITCODE
