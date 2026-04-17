/**
 * Test runner — test harness with structured test reporting.
 */

import chalk from "chalk";

export interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
  txHash?: string;
  details?: Record<string, unknown>;
}

export type TestFn = () => Promise<void>;

interface RegisteredTest {
  name: string;
  fn: TestFn;
  skip?: boolean;
}

const tests: RegisteredTest[] = [];

export function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

export function skip(name: string, fn: TestFn) {
  tests.push({ name, fn, skip: true });
}

let currentTxHash: string | undefined = undefined;
let currentDetails: Record<string, unknown> | undefined = undefined;

/** Call inside a test to attach the tx hash to the result */
export function setTxHash(hash: string) {
  currentTxHash = hash;
}

/** Call inside a test to attach extra details to the result */
export function setDetails(d: Record<string, unknown>) {
  currentDetails = d;
}

export async function runAllTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const total = tests.length;

  console.log(chalk.bold.cyan("\n=== Mantle Signing Test Suite ==="));
  console.log(chalk.gray(`Tests:   ${total}\n`));

  for (let i = 0; i < tests.length; i++) {
    const t = tests[i];
    const label = `[${i + 1}/${total}]`;

    if (t.skip) {
      console.log(chalk.yellow(`${label} SKIP  ${t.name}`));
      results.push({ name: t.name, passed: true, duration: 0, details: { skipped: true } });
      continue;
    }

    process.stdout.write(chalk.gray(`${label} RUN   ${t.name} ...`));
    currentTxHash = undefined;
    currentDetails = undefined;

    const start = performance.now();
    try {
      await t.fn();
      const dur = performance.now() - start;
      console.log(
        chalk.green(` PASS`) + chalk.gray(` (${(dur / 1000).toFixed(1)}s)`) +
        (currentTxHash != null ? chalk.gray(` tx: ${(currentTxHash as string).slice(0, 10)}...`) : "")
      );
      results.push({
        name: t.name,
        passed: true,
        duration: dur,
        txHash: currentTxHash,
        details: currentDetails,
      });
    } catch (err: any) {
      const dur = performance.now() - start;
      console.log(chalk.red(` FAIL`) + chalk.gray(` (${(dur / 1000).toFixed(1)}s)`));
      console.log(chalk.red(`      ${err.message?.split("\n")[0]}`));
      results.push({
        name: t.name,
        passed: false,
        duration: dur,
        error: err.message,
        txHash: currentTxHash,
        details: currentDetails,
      });
    }
  }

  // Summary
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const skipped = results.filter(r => r.details?.skipped).length;

  console.log(chalk.bold.cyan("\n=== Results ==="));
  console.log(
    chalk.green(`  Passed:  ${passed - skipped}`) +
    (skipped > 0 ? chalk.yellow(`  Skipped: ${skipped}`) : "") +
    (failed > 0 ? chalk.red(`  Failed:  ${failed}`) : "")
  );

  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);
  console.log(chalk.gray(`  Total time: ${(totalDuration / 1000).toFixed(1)}s\n`));

  if (failed > 0) {
    console.log(chalk.bold.red("Failed tests:"));
    for (const r of results.filter(r => !r.passed)) {
      console.log(chalk.red(`  - ${r.name}`));
      if (r.error) {
        // Print the full error (multi-line) indented — swallowing everything
        // after the first newline hides CLI stderr/stdout when a subprocess fails.
        for (const line of r.error.split("\n")) {
          console.log(chalk.gray(`    ${line}`));
        }
      }
    }
    console.log();
  }

  return results;
}
