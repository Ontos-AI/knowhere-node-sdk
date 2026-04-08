import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function runCommand(command, args, options = {}) {
  execFileSync(command, args, {
    stdio: 'inherit',
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

export const releaseUtils = {
  createNotesFile,
  doesGitHubReleaseExist,
  hasPublishedVersion,
  readChangelogNotes,
  readJson,
  runCommand,
};
