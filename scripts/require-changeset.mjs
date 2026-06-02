import { execFileSync } from 'node:child_process';

const baseRef = process.argv[2] ?? 'origin/main';

const changedFilesOutput = execFileSync('git', [
  'diff',
  '--name-only',
  '--diff-filter=ACMR',
  `${baseRef}...HEAD`,
], {
  encoding: 'utf8',
});

const changedFiles = changedFilesOutput
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

const changesetFiles = changedFiles
  .filter((file) => file.startsWith('.changeset/'))
  .filter((file) => file.endsWith('.md'))
  .filter((file) => !file.endsWith('README.md'));

if (changesetFiles.length === 0) {
  const changedPackageFiles = changedFiles
    .filter((file) => !file.startsWith('.changeset/'))
    .filter((file) => !file.startsWith('.github/'))
    .filter((file) => !file.startsWith('scripts/'));

  if (changedPackageFiles.length === 0) {
    console.log('No package-facing files changed; skipping changeset requirement.');
    process.exit(0);
  }

  throw new Error(`Expected at least one changeset file in .changeset/ relative to ${baseRef}.`);
}

console.log(`Detected changeset file(s): ${changesetFiles.join(', ')}`);
