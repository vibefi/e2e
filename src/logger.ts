import createDebug from "debug";
import type { E2eVerbosity } from "./config";

const NAMESPACE = "vibefi:e2e";

const debugLogger = createDebug(`${NAMESPACE}:debug`);
const infoLogger = createDebug(`${NAMESPACE}:info`);
const warnLogger = createDebug(`${NAMESPACE}:warn`);
const errorLogger = createDebug(`${NAMESPACE}:error`);

let streamToolOutput = false;

function getEnabledNamespaces(verbosity: E2eVerbosity): string {
  if (verbosity === "quiet") {
    return `${NAMESPACE}:warn,${NAMESPACE}:error`;
  }
  if (verbosity === "verbose") {
    return `${NAMESPACE}:*`;
  }
  return `${NAMESPACE}:info,${NAMESPACE}:warn,${NAMESPACE}:error`;
}

createDebug.enable(getEnabledNamespaces("normal"));

export function configureLogger(options: {
  verbosity: E2eVerbosity;
  streamToolOutput: boolean;
}) {
  createDebug.enable(getEnabledNamespaces(options.verbosity));
  streamToolOutput = options.streamToolOutput;
}

export function isToolOutputEnabled(): boolean {
  return streamToolOutput;
}

export const logger = {
  debug(message: string, ...args: unknown[]) {
    debugLogger(message, ...args);
  },
  info(message: string, ...args: unknown[]) {
    infoLogger(message, ...args);
  },
  warn(message: string, ...args: unknown[]) {
    warnLogger(message, ...args);
  },
  error(message: string, ...args: unknown[]) {
    errorLogger(message, ...args);
  },
};
