import { spawnSync } from "node:child_process";

const rawArgs = process.argv.slice(2);

const e2eFlagArgs: string[] = [];
const bunTestArgs: string[] = [];

for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--") continue;

    if (
        arg === "--sepolia" ||
        arg === "--gov-agent" ||
        arg === "--client" ||
        arg === "--quiet" ||
        arg === "-q" ||
        arg === "--verbose" ||
        arg === "-v" ||
        arg === "--tool-output" ||
        arg === "--show-tool-output"
    ) {
        e2eFlagArgs.push(arg);
        continue;
    }

    if (arg === "--verbosity") {
        e2eFlagArgs.push(arg);
        if (i + 1 < rawArgs.length) {
            e2eFlagArgs.push(rawArgs[i + 1]);
            i += 1;
        }
        continue;
    }

    if (arg.startsWith("--verbosity=")) {
        e2eFlagArgs.push(arg);
        continue;
    }

    bunTestArgs.push(arg);
}

const hasExplicitTimeout = bunTestArgs.some(
    (arg) =>
        arg === "--timeout" ||
        arg.startsWith("--timeout=")
);

const env = { ...process.env, E2E_ARGS: JSON.stringify(e2eFlagArgs) };

const testCommandArgs = ["test", "src/e2e.test.ts"];
if (!hasExplicitTimeout) {
    testCommandArgs.push("--timeout", "300000");
}
testCommandArgs.push(...bunTestArgs);

const result = spawnSync("bun", testCommandArgs, {
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
