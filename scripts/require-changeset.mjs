import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const baseRef = process.argv.slice(2).find((arg) => arg !== '--') ?? 'origin/main';

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readJsonFromGit(ref, path) {
  return JSON.parse(
    execFileSync('git', ['show', `${ref}:${path}`], {
      encoding: 'utf8',
    }),
  );
}

function isPackageManifest(path) {
  return path === 'package.json' || /^packages\/[^/]+\/package\.json$/.test(path);
}

function listVersionBumpedManifests(files) {
  return files.filter(isPackageManifest).filter((file) => {
    const previousManifest = readJsonFromGit(baseRef, file);
    const currentManifest = readJsonFile(file);

    return previousManifest.version !== currentManifest.version;
  });
}

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

  const versionBumpedManifests = listVersionBumpedManifests(changedFiles);
  if (versionBumpedManifests.length > 0) {
    console.log(
      `Detected direct package version bump(s): ${versionBumpedManifests.join(', ')}`,
    );
    process.exit(0);
  }

  throw new Error(`Expected at least one changeset file in .changeset/ relative to ${baseRef}.`);
}

console.log(`Detected changeset file(s): ${changesetFiles.join(', ')}`);
