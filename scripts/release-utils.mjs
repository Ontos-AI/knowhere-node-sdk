import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function runCommand(command, args, options = {}) {
  execFileSync(command, args, {
    stdio: 'inherit',
    ...options,
  });
}

function readCommand(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
}

function doesCommandSucceed(command, args, options = {}) {
  try {
    execFileSync(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    return true;
  } catch {
    return false;
  }
}

function hasPublishedVersion(packageName, version) {
  return doesCommandSucceed('npm', ['view', `${packageName}@${version}`, 'version']);
}

function doesGitHubReleaseExist(tagName) {
  return doesCommandSucceed('gh', ['release', 'view', tagName]);
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readChangelogNotes(version) {
  if (!existsSync('CHANGELOG.md')) {
    return `Release ${version}`;
  }

  const changelog = readFileSync('CHANGELOG.md', 'utf8');
  const versionPattern = escapeRegularExpression(version);
  const headingPattern = new RegExp(`^##\\s+\\[?${versionPattern}\\]?(?:\\s+-\\s+.+)?$`, 'm');
  const headingMatch = headingPattern.exec(changelog);

  if (headingMatch === null || headingMatch.index === undefined) {
    return `Release ${version}`;
  }

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const remaining = changelog.slice(sectionStart).replace(/^\n+/, '');
  const nextHeadingIndex = remaining.search(/^##\s+/m);
  const section = (
    nextHeadingIndex === -1 ? remaining : remaining.slice(0, nextHeadingIndex)
  ).trim();

  if (section.length === 0) {
    return `Release ${version}`;
  }

  return section;
}

function createNotesFile(prefix, content) {
  const notesDirectory = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const notesPath = join(notesDirectory, 'notes.md');
  const normalizedContent = content.endsWith('\n') ? content : `${content}\n`;

  writeFileSync(notesPath, normalizedContent);

  return notesPath;
}

function listWorkspacePackages() {
  const workspaceOutput = readCommand('pnpm', ['list', '--recursive', '--depth', '-1', '--json']);
  const workspacePackages = JSON.parse(workspaceOutput);

  return workspacePackages
    .map((workspacePackage) => ({
      directory: workspacePackage.path,
      manifest: readJson(join(workspacePackage.path, 'package.json')),
    }))
    .filter((workspacePackage) => workspacePackage.manifest.private !== true);
}

function packWorkspacePackage(workspacePackage) {
  const packDirectory = mkdtempSync(join(tmpdir(), 'knowhere-package-'));
  const beforeFiles = new Set(readdirSync(packDirectory));

  runCommand('pnpm', ['pack', '--pack-destination', packDirectory], {
    cwd: workspacePackage.directory,
  });

  const tarballs = readdirSync(packDirectory)
    .filter((fileName) => fileName.endsWith('.tgz'))
    .filter((fileName) => !beforeFiles.has(fileName));

  if (tarballs.length !== 1) {
    throw new Error(
      `Expected one package tarball for ${workspacePackage.manifest.name}, found ${tarballs.length}`,
    );
  }

  return join(packDirectory, tarballs[0]);
}

function publishWorkspacePackages(options = {}) {
  const packages = listWorkspacePackages();

  for (const workspacePackage of packages) {
    const packageName = workspacePackage.manifest.name;
    const version = workspacePackage.manifest.version;

    if (hasPublishedVersion(packageName, version)) {
      console.log(`${packageName}@${version} is already on npm, skipping npm publish`);
      continue;
    }

    const tarballPath = packWorkspacePackage(workspacePackage);
    const publishArgs = ['publish', tarballPath, '--access', 'public'];

    if (options.tag) {
      publishArgs.push('--tag', options.tag);
    }

    console.log(
      `Publishing ${packageName}@${version} from ${relative(process.cwd(), tarballPath)}`,
    );
    runCommand('npm', publishArgs);
  }
}

export const releaseUtils = {
  createNotesFile,
  doesGitHubReleaseExist,
  hasPublishedVersion,
  listWorkspacePackages,
  publishWorkspacePackages,
  readChangelogNotes,
  readJson,
  readCommand,
  runCommand,
};
