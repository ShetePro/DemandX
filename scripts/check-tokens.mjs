/**
 * Guard against hard-coded colors in source files.
 *
 * Every color must come from a semantic design token declared in
 * `src/app/globals.css` (e.g. `bg-surface`, `text-fg`, `border-border`).
 * Inline CSS variables are fine: `style={{ '--w': `${pct}%` }}`.
 *
 * Scans .ts / .tsx / .css files under src/; `src/app/globals.css` is the token
 * source and is skipped entirely. `data:` URLs are blanked out before scanning
 * and comment-only lines are ignored.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');
const TOKEN_FILE = path.resolve(SRC, 'app/globals.css');
const EXTENSIONS = new Set(['.ts', '.tsx', '.css']);

const FORBIDDEN = [
  { label: 'hex color', pattern: /#[0-9a-fA-F]{3,8}\b/g },
  { label: 'rgb()/rgba()', pattern: /\brgba?\(/g },
  { label: 'hsl()/hsla()', pattern: /\bhsla?\(/g },
];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(absolute, files);
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      files.push(absolute);
    }
  }
  return files;
}

const violations = [];
let scanned = 0;

for (const file of walk(SRC).sort()) {
  if (path.resolve(file) === TOKEN_FILE) continue;
  scanned += 1;

  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (
      trimmed.startsWith('//') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('*') ||
      trimmed.endsWith('*/')
    ) {
      return;
    }

    // Blank out `data:` URLs (preserving column offsets) so their payload can
    // never hide a real color literal further along the same line.
    const masked = line.replace(/data:[^"'\s)\],]+/g, (match) => ' '.repeat(match.length));

    for (const { pattern } of FORBIDDEN) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(masked)) !== null) {
        violations.push({
          file: path.relative(ROOT, file),
          line: index + 1,
          column: match.index + 1,
          snippet: line.trim(),
        });
      }
    }
  });
}

if (violations.length > 0) {
  for (const { file, line, column, snippet } of violations) {
    console.error(`${file}:${line}:${column}  ${snippet}`);
  }
  console.error(
    `\ntokens: ${violations.length} violation(s) in ${scanned} file(s). ` +
      'Use semantic tokens (bg-surface / text-fg / border-border …) instead of hard-coded colors.',
  );
  process.exit(1);
}

console.log(`tokens: ok (${scanned} files)`);
