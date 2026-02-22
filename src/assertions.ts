export interface CommandResultLike {
  code: number;
  stdout?: string;
  stderr?: string;
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export function assertDefined<T>(
  value: T | null | undefined,
  message: string
): asserts value is T {
  if (value === undefined || value === null) {
    throw new Error(message);
  }
}

export function assertCommandSuccess(result: CommandResultLike, context: string): void {
  if (result.code === 0) return;
  const stdout = result.stdout?.trim();
  const stderr = result.stderr?.trim();
  if (stdout) {
    process.stderr.write(`\n[${context}] stdout:\n${stdout}\n`);
  }
  if (stderr) {
    process.stderr.write(`\n[${context}] stderr:\n${stderr}\n`);
  }
  if (!stderr) {
    throw new Error(`${context} failed (exit=${result.code})`);
  }
  const firstLine = stderr.split("\n")[0];
  throw new Error(`${context} failed (exit=${result.code}): ${firstLine}`);
}
