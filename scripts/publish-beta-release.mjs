import { releaseUtils } from './release-utils.mjs';

const distTag = process.env.BETA_DIST_TAG ?? 'beta';

try {
  releaseUtils.runCommand('pnpm', ['exec', 'changeset', 'status']);
} catch {
  throw new Error(
    'Beta publish requires at least one pending changeset on the selected ref before a snapshot can be generated',
  );
}

releaseUtils.runCommand('pnpm', [
  'exec',
  'changeset',
  'version',
  '--snapshot',
  distTag,
  '--snapshot-prerelease-template',
  '{tag}.{datetime}',
]);

const packageJson = releaseUtils.readJson('package.json');
const packageName = packageJson.name;
const version = packageJson.version;
const tagName = `v${version}`;

if (!version.includes(`-${distTag}.`)) {
  throw new Error(`Beta publish expected ${version} to include prerelease tag ${distTag}`);
}

// npm provenance is disabled while this repository is private.
// Re-enable `--provenance` when the source repository becomes public.
releaseUtils.publishWorkspacePackages({ tag: distTag });

if (releaseUtils.doesGitHubReleaseExist(tagName)) {
  console.log(`GitHub prerelease ${tagName} already exists, skipping release creation`);
  process.exit(0);
}

const releaseNotes = [
  `Beta snapshot publish for \`${packageName}@${version}\`.`,
  '',
  `- npm dist-tag: \`${distTag}\``,
  `- git ref: \`${process.env.GITHUB_REF_NAME ?? 'local'}\``,
  `- commit: \`${process.env.GITHUB_SHA ?? 'local'}\``,
  '',
  'This prerelease was generated from pending changesets in CI without committing prerelease state back to the source branch.',
].join('\n');

const notesPath = releaseUtils.createNotesFile('beta-release-notes', releaseNotes);

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
  '--prerelease',
]);
