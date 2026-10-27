import { execFileSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dir, gitRepo } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import { serializeManifest } from '@openai/agents-core/sandbox/internal';
import { createManifest, prepareManifest } from '@/config/workspace/index.js';

describe('createManifest', () => {
  it('clones GitHub, GitLab, and Bitbucket, and attaches Google Drive', () => {
    const manifest = createManifest({
      mounts: {
        app: {
          provider: 'github',
          url: 'https://github.com/owner/starter/tree/main',
        },
        lab: {
          provider: 'gitlab',
          url: 'https://gitlab.com/group/api/-/tree/main',
        },
        bucket: {
          provider: 'bitbucket',
          url: 'https://bitbucket.org/owner/web/src/develop',
        },
        drive: { provider: 'google-drive', remote: 'gdrive:notes' },
      },
    });

    expect(manifest.entries.app).toMatchObject({
      type: 'git_repo',
      repo: 'https://github.com/owner/starter.git',
      ref: 'main',
    });
    expect(manifest.entries.lab).toMatchObject({
      type: 'git_repo',
      repo: 'https://gitlab.com/group/api.git',
      ref: 'main',
    });
    expect(manifest.entries.bucket).toMatchObject({
      type: 'git_repo',
      repo: 'https://bitbucket.org/owner/web.git',
      ref: 'develop',
    });
    expect(manifest.entries.drive).toMatchObject({
      type: 'mount',
      ephemeral: true,
      readOnly: true,
      mountStrategy: {
        type: 'in_container',
        pattern: { type: 'rclone', remote: 'gdrive:notes' },
      },
    });
  });

  it('attaches cloud storage inside the container and keeps it read-only', () => {
    const manifest = createManifest({
      mounts: {
        room: {
          provider: 's3',
          bucket: 'account-files',
          region: 'us-east-1',
        },
      },
    });

    expect(manifest.entries.room).toMatchObject({
      type: 's3_mount',
      bucket: 'account-files',
      region: 'us-east-1',
      ephemeral: true,
      readOnly: true,
      mountStrategy: { type: 'in_container' },
    });
  });

  it('accepts S3 Files, a GCS key, and a Box enterprise user', () => {
    const manifest = createManifest({
      mounts: {
        files: {
          provider: 's3-files',
          fileSystemId: 'fs-123',
          region: 'us-east-1',
        },
        notes: {
          provider: 'gcs',
          bucket: 'notes',
          serviceAccountCredentials: '{"type":"service_account"}',
        },
        room: {
          provider: 's3',
          bucket: 'custom',
          endpointUrl: 'https://s3.example.com',
        },
        contracts: {
          provider: 'box',
          boxSubType: 'enterprise',
          impersonate: 'owner@example.com',
          rootFolderId: '0',
        },
      },
    });

    expect(manifest.entries.files).toMatchObject({
      type: 's3_files_mount',
      fileSystemId: 'fs-123',
    });
    expect(manifest.entries.notes).toMatchObject({
      serviceAccountCredentials: '{"type":"service_account"}',
    });
    expect(manifest.entries.room).toMatchObject({
      endpointUrl: 'https://s3.example.com',
    });
    expect(manifest.entries.contracts).toMatchObject({
      boxSubType: 'enterprise',
      impersonate: 'owner@example.com',
      rootFolderId: '0',
    });
    expect(JSON.stringify(manifest.entries)).not.toContain('token');
  });

  it('never installs manifest credentials in the process environment', () => {
    const before = { ...process.env };
    try {
      for (const token of ['first', 'second']) {
        try {
          createManifest({
            repo: { url: 'https://github.com/owner/secret', token },
          });
        } catch {
          // Token-bearing inputs may require the asynchronous preparation API.
        }
      }
      createManifest({ repo: 'https://github.com/owner/secret' });
      expect(JSON.stringify(process.env) === JSON.stringify(before)).toBe(true);
    } finally {
      process.env = before;
    }
  });

  it('requires explicit preparation for private repositories', () => {
    expect(() =>
      createManifest({ repo: { url: 'owner/private', token: 'secret' } }),
    ).toThrow(/prepareManifest/);
    expect(() =>
      createManifest({
        mounts: {
          repo: { provider: 'gitlab', url: 'group/private', token: 'secret' },
        },
      }),
    ).toThrow(/prepareManifest/);
  });

  it('keeps sandbox users and groups', () => {
    const manifest = createManifest({
      users: ['agent'],
      groups: [{ name: 'editors', users: ['agent'] }],
    });

    expect(manifest.users).toEqual([{ name: 'agent' }]);
    expect(manifest.groups).toEqual([
      { name: 'editors', users: [{ name: 'agent' }] },
    ]);
  });

  it('rejects a workspace path that leaves the computer', () => {
    expect(() => createManifest({ files: { '../secret.md': 'nope' } })).toThrow(
      /inside the workspace/,
    );
  });
});

describe('prepareManifest', () => {
  let fixture: string;
  let originalEnvironment: NodeJS.ProcessEnv;
  const prepared: Array<Awaited<ReturnType<typeof prepareManifest>>> = [];

  beforeEach(async () => {
    originalEnvironment = { ...process.env };
    fixture = await realpath(
      await mkdtemp(join(tmpdir(), 'workspace-git-test-')),
    );
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const source = join(fixture, 'source');
    const bin = join(fixture, 'bin');
    await mkdir(bin);
    execFileSync(realGit, ['init', '--initial-branch=main', source], {
      stdio: 'ignore',
    });
    await writeFile(join(source, 'README.md'), 'fixture repository\n');
    execFileSync(realGit, ['-C', source, 'add', 'README.md']);
    execFileSync(
      realGit,
      [
        '-C',
        source,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '-m',
        'fixture',
      ],
      { stdio: 'ignore' },
    );
    // Replace HTTPS transport with a real local Git repository. The production
    // process still supplies the actual argv/environment; no network is used.
    await writeFile(
      join(bin, 'git'),
      `#!${process.execPath}\n
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const records = ${JSON.stringify(join(fixture, 'calls.ndjson'))};
fs.appendFileSync(records, JSON.stringify({ args, env: process.env }) + '\\n');
if (args.some(arg => arg.endsWith('/failure.git'))) { process.stderr.write('private-token ' + Object.values(process.env).join(' ')); process.exit(1); }
const urls = ['https://github.com/owner/secret.git', 'https://gitlab.com/group/api.git'];
if (args.some(arg => arg.startsWith('https://') && !urls.includes(arg))) process.exit(2);
const config = urls.flatMap(url => ['-c', 'url.' + ${JSON.stringify(`file://${source}`)} + '.insteadOf=' + url]);
setTimeout(() => {
  const result = spawnSync(${JSON.stringify(realGit)}, [...config, ...args], { env: process.env, encoding: 'utf8' });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
}, args[0] === 'clone' ? 50 : 0);
`,
    );
    await chmod(join(bin, 'git'), 0o700);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'http.extraHeader');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'Authorization: ambient');
    vi.stubEnv('GIT_CONFIG_PARAMETERS', "'credential.helper=ambient'");
    vi.stubEnv('GIT_ASKPASS', '/ambient/askpass');
    vi.stubEnv('GIT_TRACE', '1');
    vi.stubEnv('SSH_AUTH_SOCK', '/ambient/agent');
    vi.stubEnv('GH_TOKEN', 'ambient-token');
  });

  afterEach(async () => {
    await Promise.all(prepared.splice(0).map((item) => item.dispose()));
    vi.unstubAllEnvs();
    process.env = originalEnvironment;
    await rm(fixture, { recursive: true, force: true });
  });

  it('isolates overlapping clones and later anonymous clones without persisting credentials', async () => {
    const before = JSON.stringify(process.env);
    const results = await Promise.all(
      ['first', 'second'].map((token) =>
        prepareManifest({
          repo: { url: 'https://github.com/owner/secret', token, ref: 'main' },
        }),
      ),
    );
    prepared.push(...results);
    const anonymous = await prepareManifest({
      repo: 'https://github.com/owner/secret',
    });
    results.push(anonymous);
    prepared.push(anonymous);
    expect(JSON.stringify(process.env) === before).toBe(true);

    const calls = (await readFile(join(fixture, 'calls.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as { args: string[]; env: NodeJS.ProcessEnv },
      );
    const clones = calls.filter((call) => call.args[0] === 'clone');
    expect(clones).toHaveLength(3);
    const headers = clones.map((call) =>
      Object.entries(call.env)
        .filter(([key]) => key.startsWith('GIT_CONFIG_VALUE_'))
        .map(([, value]) => value)
        .find((value) => value?.startsWith('Authorization:')),
    );
    expect(headers).toEqual(
      expect.arrayContaining([
        `Authorization: Basic ${Buffer.from('x-access-token:first').toString('base64')}`,
        `Authorization: Basic ${Buffer.from('x-access-token:second').toString('base64')}`,
        undefined,
      ]),
    );
    for (const call of clones) {
      expect(call.env).not.toHaveProperty('GIT_CONFIG_PARAMETERS');
      expect(call.env).not.toHaveProperty('SSH_AUTH_SOCK');
      expect(call.env).not.toHaveProperty('GH_TOKEN');
      expect(call.env).not.toHaveProperty('GIT_TRACE');
      expect(call.env.GIT_CONFIG_NOSYSTEM).toBe('1');
      expect(call.env.GIT_CONFIG_GLOBAL).not.toBe(
        originalEnvironment.GIT_CONFIG_GLOBAL,
      );
      expect(call.env.HOME).not.toBe(originalEnvironment.HOME);
      expect(call.env.GIT_ASKPASS).not.toBe('/ambient/askpass');
      expect(call.args.join(' ')).not.toContain('Authorization');
    }
    for (const { manifest } of results) {
      const entry = manifest.entries.secret;
      expect(entry.type).toBe('local_dir');
      expect(manifest.extraPathGrants).toEqual([]);
      if (entry.type !== 'local_dir')
        throw new Error('Expected prepared directory');
      expect(await readFile(join(entry.src, 'README.md'), 'utf8')).toBe(
        'fixture repository\n',
      );
      const persisted = JSON.stringify(serializeManifest(manifest));
      const gitConfig = await readFile(join(entry.src, '.git/config'), 'utf8');
      expect(gitConfig).toContain('https://github.com/owner/secret.git');
      for (const value of [
        'first',
        'second',
        'ambient-token',
        'Authorization',
        Buffer.from('x-access-token:first').toString('base64'),
      ]) {
        expect(persisted).not.toContain(value);
        expect(gitConfig).not.toContain(value);
      }
    }
    const sourcePaths = results.map(
      ({ manifest }) => (manifest.entries.secret as { src: string }).src,
    );
    await Promise.all(results.map((result) => result.dispose()));
    for (const sourcePath of sourcePaths)
      await expect(readdir(sourcePath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
  });

  it('prepares Git mounts and nested custom Git entries', async () => {
    const result = await prepareManifest({
      mounts: {
        lab: {
          provider: 'gitlab',
          url: 'https://gitlab.com/group/api',
          token: 'lab-token',
        },
      },
      entries: {
        nested: dir({
          children: { repo: gitRepo({ repo: 'owner/secret', ref: 'main' }) },
        }),
      },
    });
    prepared.push(result);
    expect(result.manifest.entries.lab.type).toBe('local_dir');
    expect(result.manifest.entries.nested).toMatchObject({
      type: 'dir',
      children: { repo: { type: 'local_dir' } },
    });
    expect(JSON.stringify(result.manifest)).not.toContain('lab-token');
    const calls = await readFile(join(fixture, 'calls.ndjson'), 'utf8');
    expect(calls).toContain(Buffer.from('oauth2:lab-token').toString('base64'));
  });

  it('drops shortcut credentials when explicit entries override that path', async () => {
    const result = await prepareManifest({
      repo: { url: 'https://github.com/owner/secret', token: 'shortcut-token' },
      entries: { secret: gitRepo({ repo: 'owner/secret' }) },
    });
    prepared.push(result);
    const calls = await readFile(join(fixture, 'calls.ndjson'), 'utf8');
    expect(calls).not.toContain('shortcut-token');
    expect(calls).not.toContain(
      Buffer.from('x-access-token:shortcut-token').toString('base64'),
    );
    expect(calls).not.toContain('Authorization');
  });

  it('lets the SDK copy prepared sources before disposal', async () => {
    const result = await prepareManifest({
      repo: { url: 'https://github.com/owner/secret', token: 'first' },
    });
    prepared.push(result);
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: fixture,
      snapshot: { type: 'local', baseDir: join(fixture, 'snapshots') },
    });
    const session = await client.create(result.manifest);
    try {
      await result.dispose();
      expect(
        await readFile(
          join(session.state.workspaceRootPath, 'secret/README.md'),
          'utf8',
        ),
      ).toBe('fixture repository\n');
      const state = JSON.stringify(
        await client.serializeSessionState(session.state),
      );
      const config = await readFile(
        join(session.state.workspaceRootPath, 'secret/.git/config'),
        'utf8',
      );
      expect(state).not.toContain('x-access-token');
      expect(state).not.toContain(
        Buffer.from('x-access-token:first').toString('base64'),
      );
      expect(config).not.toContain('Authorization');
      expect(config).toContain('https://github.com/owner/secret.git');
      expect(session.state.snapshot?.type).toBe('local');
      if (session.state.snapshot?.type !== 'local')
        throw new Error('Expected local snapshot');
      expect(
        await readFile(
          join(session.state.snapshot.path, 'secret/.git/config'),
          'utf8',
        ),
      ).toBe(config);
    } finally {
      await session.close();
    }
  }, 20_000);

  it('checks out commit refs and preserves subpath entries', async () => {
    const commit = execFileSync(
      'git',
      ['-C', join(fixture, 'source'), 'rev-parse', 'HEAD'],
      { encoding: 'utf8', env: originalEnvironment },
    ).trim();
    const result = await prepareManifest({
      entries: {
        readme: gitRepo({
          repo: 'owner/secret',
          ref: commit,
          subpath: 'README.md',
        }),
      },
    });
    prepared.push(result);
    expect(result.manifest.entries.readme.type).toBe('local_file');
    const entry = result.manifest.entries.readme as { src: string };
    expect(await readFile(entry.src, 'utf8')).toBe('fixture repository\n');
  });

  it('rejects SSH tokens and insecure HTTPS alternatives before cloning', async () => {
    for (const url of [
      'git@github.com:owner/secret.git',
      'http://github.com/owner/secret',
    ]) {
      await expect(
        prepareManifest({ repo: { url, token: 'private-token' } }),
      ).rejects.toThrow(/requires HTTPS/);
    }
    await expect(readFile(join(fixture, 'calls.ndjson'))).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
  });

  it('redacts clone failures and removes temporary sources', async () => {
    await expect(
      prepareManifest({
        repo: {
          url: 'https://github.com/owner/failure',
          token: 'private-token',
        },
      }),
    ).rejects.toThrow(/^Git repository preparation failed\.$/);
    const calls = (await readFile(join(fixture, 'calls.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as { args: string[]; env: NodeJS.ProcessEnv },
      );
    for (const call of calls)
      await expect(readdir(call.env.HOME!)).rejects.toMatchObject({
        code: 'ENOENT',
      });
  });
});
