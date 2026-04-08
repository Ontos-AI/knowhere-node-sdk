import { execFileSync } from 'node:child_process';

const baseRef = process.argv[2] ?? 'origin/main';

const output = execFileSync(
  'git',
  ['diff', '--name-only', '--diff-filter=ACMR', `${baseRef}...HEAD`, '--', '.changeset'],
  {
    encoding: 'utf8',
  },
);

const changesetFiles = output
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .filter((file) => file.startsWith('.changeset/'))
  .filter((file) => file.endsWith('.md'))
  .filter((file) => !file.endsWith('README.md'));

if (changesetFiles.length === 0) {
  throw new Error(`Expected at least one changeset file in .changeset/ relative to ${baseRef}.`);
}

console.log(`Detected changeset file(s): ${changesetFiles.join(', ')}`);
