import chalk from "chalk";

export interface KeyValueOptions {
  labels?: Record<string, string>;
  order?: string[];
}

function getLabelWidth(entries: Array<[string, string]>): number {
  return Math.max(...entries.map(([label]) => label.length), 0);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return chalk.dim("null");
  }
  if (typeof value === "boolean") {
    return value ? chalk.green("true") : chalk.red("false");
  }
  if (typeof value === "number") {
    return chalk.cyan(String(value));
  }
  if (typeof value === "string") {
    if (/^0x[a-fA-F0-9]{40}$/.test(value)) {
      return chalk.yellow(value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return chalk.dim("[]");
    return value.map((item) => formatValue(item)).join(", ");
  }
  return JSON.stringify(value);
}

export function formatKeyValue(
  data: Record<string, unknown>,
  options: KeyValueOptions = {}
): void {
  const { labels = {}, order } = options;
  const keys = order ?? Object.keys(data);
  const entries: Array<[string, string]> = [];

  for (const key of keys) {
    if (!(key in data)) continue;
    const label = labels[key] ?? key;
    entries.push([label, formatValue(data[key])]);
  }

  const width = getLabelWidth(entries);
  console.log();
  for (const [label, value] of entries) {
    console.log(`  ${chalk.bold(label.padEnd(width))}   ${value}`);
  }
  console.log();
}

export interface TableColumn {
  key: string;
  label: string;
  align?: "left" | "right";
  format?: (value: unknown) => string;
}

export function formatTable(rows: Record<string, unknown>[], columns: TableColumn[]): void {
  if (rows.length === 0) {
    console.log(chalk.dim("\n  No results.\n"));
    return;
  }

  const widths = columns.map((col) => {
    const headerWidth = col.label.length;
    const maxDataWidth = Math.max(
      ...rows.map((row) => {
        const formatted = col.format ? col.format(row[col.key]) : formatValue(row[col.key]);
        return stripAnsi(formatted).length;
      }),
      0
    );
    return Math.max(headerWidth, maxDataWidth);
  });

  const header = columns
    .map((col, i) => chalk.bold(col.label.padEnd(widths[i])))
    .join("   ");
  console.log(`\n  ${header}`);

  for (const row of rows) {
    const line = columns
      .map((col, i) => {
        const raw = col.format ? col.format(row[col.key]) : formatValue(row[col.key]);
        const stripped = stripAnsi(raw);
        const padding = widths[i] - stripped.length;
        if (col.align === "right") {
          return " ".repeat(Math.max(padding, 0)) + raw;
        }
        return raw + " ".repeat(Math.max(padding, 0));
      })
      .join("   ");
    console.log(`  ${line}`);
  }
  console.log();
}

export function formatJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function formatError(error: {
  code?: string;
  message: string;
  suggestion?: string;
}): void {
  console.error(chalk.red(`\nError: ${error.message}`));
  if (error.code) {
    console.error(chalk.dim(`Code: ${error.code}`));
  }
  if (error.suggestion) {
    console.error(chalk.yellow(`Suggestion: ${error.suggestion}`));
  }
  console.error();
}

export function disableColors(): void {
  chalk.level = 0;
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, "");
}
