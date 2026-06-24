import { releaseUtils } from './release-utils.mjs';

const packageJson = releaseUtils.readJson('package.json');
const packageName = packageJson.name;
const version = packageJson.version;
const tagName = `v${version}`;

if (version.includes('-')) {
  throw new Error(`Stable publish expects a non-prerelease version, received ${version}`);
}

releaseUtils.publishWorkspacePackages();

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
