# AgroTrace

Monorepo for AgroTrace — a traceability system with 3 backends and 3 frontends.

## Toolchain

This project uses a Docker-only toolchain. The host only needs **Docker Desktop** and **Git** —
no Node, pnpm, Python, PHP, or make are required locally.

All tooling runs inside the `tools` Compose service (working directory `/repo`, mounted from the
repo root) via the `at` wrapper script.

### Usage

On Linux/macOS/Git Bash:

```bash
./at install         # pnpm install (creates .env from .env.example on first run)
./at sh               # open a shell inside the tools container
./at pnpm <args>       # run an arbitrary pnpm command
./at test              # run tests across the workspace
./at lint              # lint the workspace
./at fmt               # format the workspace with prettier
```

On Windows (PowerShell):

```powershell
./at.ps1 install
```

`at.ps1` simply forwards to `at.sh` via `bash`, so behavior is identical on both platforms.

### Environment

`.env` is created automatically from `.env.example` on first `./at` invocation and is
git-ignored. Edit `.env` locally as needed; do not commit it.

## Workspace layout

Package locations are defined in `pnpm-workspace.yaml`:

- `packages/*`
- `db/seed`
- `mercury-mock`
- `tests/*`

TypeScript packages extend the shared `tsconfig.base.json`.
