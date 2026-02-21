import "dotenv/config";
import fs from "node:fs";
import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { initConfig, config } from "./config";
import { prepareDappExamples, startInfrastructure, runSanityChecks } from "./setup";
import { publishAllDapps } from "./dapp-publish";
import { verifyRegistry } from "./verify";
import { testGovernanceAgent } from "./gov-agent";
import { configureLogger, logger } from "./logger";
import { processes } from "./processes";

describe("E2E Test Suite", () => {
    let cleanupDirs: string[] = [];

    beforeAll(async () => {
        initConfig(process.argv.slice(2));
        const { verbosity, streamToolOutput } = config();
        configureLogger({ verbosity, streamToolOutput });

        logger.info(
            "Starting E2E run (verbosity=%s, toolOutput=%s)",
            verbosity,
            streamToolOutput ? "on" : "off"
        );

        // Start background infrastructure
        await prepareDappExamples();
        await startInfrastructure();
    }, 120000); // 2 minute timeout for infrastructure start

    afterAll(() => {
        // Cleanup generated directories
        for (const dir of cleanupDirs) {
            if (fs.existsSync(dir)) {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        }

        const { anvilPort } = config();
        logger.info("Anvil left running on :%s", anvilPort);
    });

    it("should pass sanity checks", async () => {
        await runSanityChecks();
    });

    let studioDappId: bigint;

    it("should publish all dapps", async () => {
        const result = await publishAllDapps();
        studioDappId = result.studioDappId;
        cleanupDirs = result.cleanupDirs;

        expect(studioDappId).toBeDefined();
        expect(cleanupDirs).toBeInstanceOf(Array);
    });

    it("should verify the registry", async () => {
        await verifyRegistry(5, studioDappId);
    });

    it("should test the governance agent", async () => {
        const { useGovAgent } = config();
        if (useGovAgent) {
            await testGovernanceAgent();
        } else {
            logger.info("Skipping governance agent test (useGovAgent is false)");
        }
    });
});
