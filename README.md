# vibefi-e2e

Dedicated end-to-end test runner for VibeFi.

## Requirements

- `bun`
- `docker` + `docker compose`
- `forge`/`anvil`/`cast` (Foundry)
- Monorepo checked out locally

## Setup

```bash
bun install
cp .env.example .env
```

Edit `.env` and set:

- `MONOREPO_DIR` (absolute path to monorepo)
- `MAINNET_RPC_URL` if you want a mainnet forked anvil
- `SEPOLIA_RPC_URL` if you want to run `--sepolia`

## Run

```bash
bun run e2e
```

Run against Sepolia fork:

```bash
bun run e2e --sepolia
```

Control log verbosity:

```bash
bun run e2e --quiet
bun run e2e --verbose
bun run e2e --verbosity=normal
```

Show subprocess/tool output (hidden by default):

```bash
bun run e2e --tool-output
```

Notes:
- This script starts IPFS via docker compose in the background.
- It starts a devnet via `contracts/script/local-devnet.sh` and leaves Anvil running on the configured port.
- It initializes nested submodules inside `dapp-examples/` (including `zfi/`).
- It installs dependencies for dapps that include a `package.json` before packaging.
- It packages/proposes/executes/fetches `studio`, `uniswap-v2`, `aave-v3`, `safe-admin`, and `zfi`.
