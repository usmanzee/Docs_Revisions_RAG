/** Console formatting helpers shared by the CLI scripts. */

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return 'n/a';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** Two-column key/value block, aligned on the colon. */
export function printKeyValues(entries: readonly [string, string | number][], indent = '  '): void {
  const width = Math.max(...entries.map(([key]) => key.length));
  for (const [key, value] of entries) {
    console.log(`${indent}${key.padEnd(width)}  ${value}`);
  }
}

export function heading(text: string): void {
  console.log(`\n${text}`);
  console.log('─'.repeat(Math.max(12, text.length)));
}

/** Fixed-width table with a header rule. */
export function printTable(header: readonly string[], rows: readonly (readonly string[])[]): void {
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => (row[index] ?? '').length)),
  );
  const render = (cells: readonly string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ');

  console.log(`  ${render(header)}`);
  console.log(`  ${widths.map((width) => '─'.repeat(width)).join('  ')}`);
  for (const row of rows) console.log(`  ${render(row)}`);
}
