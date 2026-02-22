import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const env = { ...process.env, E2E_ARGS: JSON.stringify(args) };

const result = spawnSync("bun", ["test", "src/e2e.test.ts", "--timeout", "300000"], {
    stdio: "inherit",
    env,
});

if (result.error) {
    console.error(result.error);
    process.exit(1);
}

if (typeof result.status === "number") {
    process.exit(result.status);
}

if (result.signal) {
    console.error(`E2E tests were terminated by signal: ${result.signal}`);
    process.exit(1);
}

process.exit(1);
