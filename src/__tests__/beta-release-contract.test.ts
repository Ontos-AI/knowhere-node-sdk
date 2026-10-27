import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expect, it } from 'vitest';

it('tags the checked-out beta source when workflow metadata identifies another ref', async (): Promise<void> => {
  const directory: string = await mkdtemp(join(tmpdir(), 'knowhere-beta-contract-'));
  const bin: string = join(directory, 'bin');
  const scripts: string = join(directory, 'scripts');
  const actualCommit: string = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  try {
    await Promise.all([mkdir(bin), mkdir(scripts)]);
    await Promise.all(
      ['publish-beta-release.mjs', 'release-utils.mjs'].map((name: string) =>
        copyFile(join(process.cwd(), 'scripts', name), join(scripts, name)),
      ),
    );
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ name: '@ontos-ai/knowhere-sdk', version: '2.6.0' }),
    );
    const commandBody: string = `
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (COMMAND === 'git' && args.join(' ') === 'rev-parse HEAD') {
  console.log('${actualCommit}');
} else if (COMMAND === 'pnpm' && args[0] === 'exec' && args[1] === 'changeset') {
  if (args[2] === 'version') {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
    manifest.version = '2.6.1-beta.20990101000000';
    writeFileSync('package.json', JSON.stringify(manifest));
  }
} else if (COMMAND === 'pnpm' && args[0] === 'list') {
  console.log(JSON.stringify([{ path: process.cwd() }]));
} else if (COMMAND === 'npm' && args[0] === 'view') {
  process.exit(0);
} else if (COMMAND === 'gh' && args[0] === 'release' && args[1] === 'view') {
  process.exit(1);
} else if (COMMAND === 'gh' && args[0] === 'release' && args[1] === 'create') {
  writeFileSync(process.env.RELEASE_CAPTURE_PATH, JSON.stringify({
    target: args[args.indexOf('--target') + 1],
    notes: readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8')
  }));
} else {
  throw new Error('Unexpected release boundary command: ' + COMMAND + ' ' + args.join(' '));
}
`;
    await Promise.all(
      ['git', 'pnpm', 'npm', 'gh'].map((name: string) =>
        writeFile(
          join(bin, name),
          `#!/usr/bin/env node\nconst COMMAND = '${name}';\n${commandBody}`,
          { mode: 0o755 },
        ),
      ),
    );
    const capturePath: string = join(directory, 'release.json');
    const result = spawnSync(process.execPath, [join(scripts, 'publish-beta-release.mjs')], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        GITHUB_SHA: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        GITHUB_REF_NAME: 'main',
        RELEASE_CAPTURE_PATH: capturePath,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const captured: unknown = JSON.parse(await readFile(capturePath, 'utf8'));
    expect(captured).toMatchObject({ target: actualCommit });
    const notes: unknown =
      typeof captured === 'object' && captured !== null && 'notes' in captured
        ? captured.notes
        : undefined;
    expect(notes).toContain(actualCommit);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
