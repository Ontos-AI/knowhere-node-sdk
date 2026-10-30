import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, symlink } from 'node:fs/promises';
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
} else if (COMMAND === 'pnpm' && args[0] === 'run' && args[1] === 'build:all') {
  // The separate package contract exercises actual build and pack bytes.
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

it('publishes CommonJS and ESM bytes with the newly assigned beta package version', async (): Promise<void> => {
  const directory: string = await mkdtemp(join(tmpdir(), 'knowhere-beta-package-contract-'));
  const bin: string = join(directory, 'bin');
  const scripts: string = join(directory, 'scripts');
  const source: string = join(directory, 'src');
  const temporary: string = join(directory, 'temporary');
  const extracted: string = join(directory, 'extracted');
  const capturePath: string = join(directory, 'published-package.json');
  const expectedVersion: string = '2.8.0-beta.20990101000000';
  try {
    await Promise.all(
      [bin, scripts, source, temporary, extracted].map(
        (name: string): Promise<void> => mkdir(name),
      ),
    );
    await Promise.all([
      ...['publish-beta-release.mjs', 'release-utils.mjs'].map(
        (name: string): Promise<void> =>
          copyFile(join(process.cwd(), 'scripts', name), join(scripts, name)),
      ),
      copyFile(join(process.cwd(), 'package.json'), join(directory, 'package.json')),
      copyFile(join(process.cwd(), 'tsconfig.json'), join(directory, 'tsconfig.json')),
      copyFile(join(process.cwd(), 'src', 'version.ts'), join(source, 'version.ts')),
      writeFile(join(source, 'index.ts'), "export { VERSION } from './version.js';\n"),
      symlink(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir'),
    ]);
    // Match the workflow's build before Changesets assigns its snapshot version.
    const initialBuild: SpawnSyncReturns<string> = spawnSync('pnpm', ['run', 'build'], {
      cwd: directory,
      encoding: 'utf8',
    });
    expect(initialBuild.status, initialBuild.stdout + initialBuild.stderr).toBe(0);

    const commandBody: string = `
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const args = process.argv.slice(2);
const originalEnvironment = { ...process.env, PATH: process.env.RELEASE_ORIGINAL_PATH };
if (COMMAND === 'git' && args.join(' ') === 'rev-parse HEAD') {
  console.log('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
} else if (COMMAND === 'pnpm' && args[0] === 'exec' && args[1] === 'changeset') {
  if (args[2] === 'version') {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
    manifest.version = '${expectedVersion}';
    writeFileSync('package.json', JSON.stringify(manifest));
  }
} else if (COMMAND === 'pnpm' && args[0] === 'run' && args[1] === 'build:all') {
  execFileSync('pnpm', ['run', 'build'], { stdio: 'inherit', env: originalEnvironment });
} else if (COMMAND === 'pnpm' && args[0] === 'list') {
  console.log(JSON.stringify([{ path: process.cwd() }]));
} else if (COMMAND === 'pnpm' && args[0] === 'pack') {
  execFileSync('pnpm', args, { stdio: 'inherit', env: originalEnvironment });
} else if (COMMAND === 'npm' && args[0] === 'view') {
  process.exit(1);
} else if (COMMAND === 'npm' && args[0] === 'publish') {
  const extracted = process.env.RELEASE_EXTRACTED_PATH;
  execFileSync('tar', ['-xzf', args[1], '-C', extracted]);
  const packageDirectory = join(extracted, 'package');
  const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
  const loadCommonJs = createRequire(import.meta.url);
  const commonJs = loadCommonJs(join(packageDirectory, 'dist', 'index.js'));
  const module = await import(pathToFileURL(join(packageDirectory, 'dist', 'index.mjs')).href);
  writeFileSync(process.env.RELEASE_CAPTURE_PATH, JSON.stringify({
    packageVersion: manifest.version,
    commonJsVersion: commonJs.VERSION,
    moduleVersion: module.VERSION,
  }));
} else if (COMMAND === 'gh' && args[0] === 'release' && args[1] === 'view') {
  process.exit(0);
} else {
  throw new Error('Unexpected release boundary command: ' + COMMAND + ' ' + args.join(' '));
}
`;
    await Promise.all(
      ['git', 'pnpm', 'npm', 'gh'].map(
        (name: string): Promise<void> =>
          writeFile(
            join(bin, name),
            `#!/usr/bin/env node\nconst COMMAND = '${name}';\n${commandBody}`,
            { mode: 0o755 },
          ),
      ),
    );
    const result: SpawnSyncReturns<string> = spawnSync(
      process.execPath,
      [join(scripts, 'publish-beta-release.mjs')],
      {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
          TMPDIR: temporary,
          BETA_DIST_TAG: 'beta',
          RELEASE_ORIGINAL_PATH: process.env.PATH,
          RELEASE_EXTRACTED_PATH: extracted,
          RELEASE_CAPTURE_PATH: capturePath,
        },
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const captured: unknown = JSON.parse(await readFile(capturePath, 'utf8'));
    expect(captured).toEqual({
      packageVersion: expectedVersion,
      commonJsVersion: expectedVersion,
      moduleVersion: expectedVersion,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
