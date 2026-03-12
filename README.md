# vibefi-e2e

Dedicated end-to-end test runner for VibeFi.

## Requirements

- `bun`
- `docker` + `docker compose`
- `forge`/`anvil`/`cast` (Foundry)
- `cargo` + Rust toolchain (required for `--gov-agent`)
- Monorepo checked out locally

## Setup

```bash
bun install
cp .env.example .env
```

Edit `.env` and set:

- `MONOREPO_DIR` (absolute path to monorepo)
- optional `ANVIL_PORT`, `IPFS_API`, `IPFS_GATEWAY`

Optional fork RPCs are read by `contracts/script/local-devnet.sh` from
`contracts/.env`:
- `MAINNET_RPC_URL` for default mainnet-fork mode
- `SEPOLIA_RPC_URL` for `--sepolia`

## Run

To execute the test suite (via the built-in `bun:test` runner):

```bash
bun run e2e
```

Run against Sepolia fork:
```bash
bun run e2e -- --sepolia
```

Run client UI automation tests (spawns desktop client):
```bash
bun run e2e -- --client
```

Run governance-agent E2E (requires OpenAI key):
```bash
OPENAI_API_KEY=... bun run e2e -- --gov-agent
```

Quickly publish a security test bundle proposal (for gov-agent pickup checks):
```bash
bun run publish:test-bundle red_team_vapp
bun run publish:test-bundle malicious_uniswapv2
```

Run both optional paths:
```bash
OPENAI_API_KEY=... bun run e2e -- --client --gov-agent
```

Control log verbosity:
```bash
bun run e2e -- --quiet
bun run e2e -- --verbose
bun run e2e -- --verbosity=normal
```

Show subprocess/tool output (hidden by default):
```bash
bun run e2e -- --tool-output
```

Notes:
- This script starts IPFS via docker compose in the background.
- It starts a devnet via `contracts/script/local-devnet.sh` and leaves Anvil running on the configured port.
- It expects `dapp-examples/` (including `zfi/`) to already be initialized in your checkout.
- It packages/proposes/executes/fetches `studio`, `uniswap-v2`, `aave-v3`, `safe-admin`, and `zfi`.
- `--client` runs client automation checks against the built desktop app.
- `--gov-agent` requires `OPENAI_API_KEY` in the environment and runs `cargo run` in `gov-agent/`.
