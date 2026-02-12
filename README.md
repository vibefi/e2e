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
- `MAINNET_RPC_URL` if you want a forked anvil

## Run

```bash
bun run e2e
```

Notes:
- This script starts IPFS via docker compose in the background.
- It starts a devnet via `contracts/script/local-devnet.sh` and leaves Anvil running on the configured port.
