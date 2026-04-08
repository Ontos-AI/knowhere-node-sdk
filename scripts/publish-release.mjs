import { releaseUtils } from './release-utils.mjs';

const packageJson = releaseUtils.readJson('package.json');
const packageName = packageJson.name;
const version = packageJson.version;
const tagName = `v${version}`;

if (version.includes('-')) {
  throw new Error(`Stable publish expects a non-prerelease version, received ${version}`);
}

if (!releaseUtils.hasPublishedVersion(packageName, version)) {
  // npm provenance is disabled while this repository is private.
  // Re-enable `--provenance` when the source repository becomes public.
  releaseUtils.runCommand('npm', ['publish', '--access', 'public']);
} else {
  console.log(`${packageName}@${version} is already on npm, skipping npm publish`);
}

if (releaseUtils.doesGitHubReleaseExist(tagName)) {
  console.log(`GitHub release ${tagName} already exists, skipping release creation`);
  process.exit(0);
}

const notesPath = releaseUtils.createNotesFile(
  'stable-release-notes',
  releaseUtils.readChangelogNotes(version),
);

releaseUtils.runCommand('gh', [
  'release',
  'create',
  tagName,
  '--title',
  tagName,
  '--notes-file',
  notesPath,
  '--target',
  process.env.GITHUB_SHA ?? 'HEAD',
  '--latest',
]);
