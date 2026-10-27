import {
  azureBlobMount,
  boxMount,
  dir,
  file,
  gcsMount,
  gitRepo,
  inContainerMountStrategy,
  localDir,
  localFile,
  Manifest,
  ManifestEntries,
  ManifestEnvironment,
  mount,
  r2Mount,
  s3FilesMount,
  s3Mount,
  SandboxGroupInit,
  SandboxUserInit,
  type GitRepo,
  normalizeRelativePath,
} from '@openai/agents/sandbox';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

type GitHost = 'github' | 'gitlab' | 'bitbucket';
type GitCredentials = { token?: string; username?: string; host?: GitHost };

type RepoLink = {
  url: string;
  path?: string;
  ref?: string;
  token?: string;
  username?: string;
};

type MountSpec =
  | {
      provider: 's3';
      bucket: string;
      region?: string;
      prefix?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      sessionToken?: string;
      endpointUrl?: string;
      s3Provider?: string;
      readOnly?: boolean;
    }
  | {
      provider: 's3-files';
      fileSystemId: string;
      subpath?: string;
      mountTargetIp?: string;
      accessPoint?: string;
      region?: string;
      readOnly?: boolean;
    }
  | {
      provider: 'gcs';
      bucket: string;
      prefix?: string;
      region?: string;
      endpointUrl?: string;
      accessId?: string;
      secretAccessKey?: string;
      serviceAccountFile?: string;
      serviceAccountCredentials?: string;
      accessToken?: string;
      readOnly?: boolean;
    }
  | {
      provider: 'r2';
      bucket: string;
      accountId: string;
      prefix?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      readOnly?: boolean;
    }
  | {
      provider: 'azure';
      container: string;
      accountName?: string;
      accountKey?: string;
      prefix?: string;
      readOnly?: boolean;
    }
  | {
      provider: 'box';
      clientId?: string;
      clientSecret?: string;
      accessToken?: string;
      token?: string;
      boxConfigFile?: string;
      configCredentials?: string;
      boxSubType?: 'user' | 'enterprise';
      rootFolderId?: string;
      impersonate?: string;
      ownedBy?: string;
      path?: string;
      readOnly?: boolean;
    }
  | {
      provider: 'github' | 'gitlab' | 'bitbucket';
      url: string;
      ref?: string;
      token?: string;
      username?: string;
    }
  | {
      provider: 'google-drive';
      remote?: string;
      configFile?: string;
      readOnly?: boolean;
    };

type CreateManifestOptions = {
  files?: Record<string, string>;
  localFiles?: Record<string, string>;
  localDirs?: Record<string, string>;
  outputDirs?: string[];
  mounts?: Record<string, MountSpec>;
  entries?: ManifestEntries;
  environment?: ManifestEnvironment;
  repo?: string | RepoLink;
  users?: SandboxUserInit[];
  groups?: SandboxGroupInit[];
};

// Build the starting contents of a workspace. Call it with no argument for an empty computer.
// files are text. localFiles and localDirs are copied from this Mac. repo clones a GitHub link.
// outputDirs are empty folders. mounts attach storage, including a Git host or Google Drive.
// entries and environment are optional. users and groups are sandbox accounts.
export function createManifest(options?: CreateManifestOptions) {
  return buildManifest(options);
}

function buildManifest(
  options?: CreateManifestOptions,
  credentials?: Map<string, GitCredentials>,
) {
  const files = Object.fromEntries(
    Object.entries(options?.files ?? {}).map(([path, content]) => [
      workspacePath(path),
      file({ content }),
    ]),
  );
  const copiedFiles = Object.fromEntries(
    Object.entries(options?.localFiles ?? {}).map(([path, src]) => [
      workspacePath(path),
      localFile({ src }),
    ]),
  );
  const copiedDirs = Object.fromEntries(
    Object.entries(options?.localDirs ?? {}).map(([path, src]) => [
      workspacePath(path),
      localDir({ src }),
    ]),
  );
  const outputDirs = Object.fromEntries(
    (options?.outputDirs ?? []).map((path) => [workspacePath(path), dir()]),
  );
  const mounts = Object.fromEntries(
    Object.entries(options?.mounts ?? {}).map(([path, spec]) => [
      workspacePath(path),
      mountEntry(spec, normalizeRelativePath(workspacePath(path)), credentials),
    ]),
  );
  const repo = options?.repo && repoEntry(options.repo, credentials);
  // Explicit entries override the repo/mount shortcuts, including their auth.
  for (const path of Object.keys(options?.entries ?? {})) {
    credentials?.delete(normalizeRelativePath(path));
  }

  return new Manifest({
    entries: {
      ...files,
      ...copiedFiles,
      ...copiedDirs,
      ...outputDirs,
      ...mounts,
      ...repo,
      ...options?.entries,
    },
    ...(options?.environment && { environment: options.environment }),
    ...(options?.users && { users: options.users }),
    ...(options?.groups && { groups: options.groups }),
  });
}

// Keep these temporary sources until the SDK has materialized the workspace.
// dispose() is idempotent; prepare again before creating another fresh workspace.
export async function prepareManifest(options?: CreateManifestOptions) {
  const credentials = new Map<string, GitCredentials>();
  const manifest = buildManifest(options, credentials);
  const gitEntries = [...manifest.iterEntries()].filter(
    (item): item is typeof item & { entry: GitRepo } =>
      item.entry.type === 'git_repo',
  );
  if (gitEntries.length === 0) return { manifest, dispose: async () => {} };

  // SDK local sources must be within cwd. A dedicated writable directory also
  // supports non-root containers whose application directory is read-only.
  const preparationRoot = join(await realpath(process.cwd()), '.msagents');
  await mkdir(preparationRoot, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(preparationRoot, 'git-'));
  const dispose = () => rm(temporary, { recursive: true, force: true });
  const home = join(temporary, 'home');
  try {
    await mkdir(home);
    for (const [index, { logicalPath, entry }] of gitEntries.entries()) {
      const auth = credentials.get(logicalPath);
      const repository = entry.repo.includes('://')
        ? entry.repo
        : `https://${entry.host ?? defaultGitHost(auth?.host ?? 'github')}/${entry.repo.replace(/\.git$/, '')}.git`;
      if (
        entry.repo.startsWith('git@') ||
        new URL(repository).protocol !== 'https:'
      ) {
        throw new Error('prepareManifest requires HTTPS Git repository URLs.');
      }
      const url = new URL(repository);
      if (url.username || url.password || url.search || url.hash) {
        throw new Error(
          'Use the token option instead of credentials in a Git URL.',
        );
      }
      const destination = join(temporary, `repo-${index}`);
      const environment = gitEnvironment(home, url.toString(), auth);
      await cloneRepository(
        url.toString(),
        destination,
        entry.ref,
        environment,
        home,
      );
      let source = destination;
      if (entry.subpath) {
        source = await realpath(resolve(destination, entry.subpath));
        const subpath = relative(destination, source);
        if (
          isAbsolute(subpath) ||
          subpath === '..' ||
          subpath.startsWith(`..${sep}`)
        ) {
          throw new Error(
            'Git repository subpath must stay inside the repository.',
          );
        }
      }
      const sourceInfo = await stat(source);
      const {
        type: _type,
        repo: _repo,
        host: _host,
        ref: _ref,
        subpath: _subpath,
        ...metadata
      } = entry;
      const prepared = sourceInfo.isDirectory()
        ? localDir({ ...metadata, src: source })
        : localFile({ ...metadata, src: source });
      // Replace the normalized entry in place, including entries nested in dirs.
      Object.keys(entry).forEach(
        (key) => delete (entry as Record<string, unknown>)[key],
      );
      Object.assign(entry, prepared);
    }
    return { manifest, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

function gitEnvironment(
  home: string,
  repository: string,
  auth?: GitCredentials,
) {
  const settings: Array<[string, string]> = [
    ['credential.helper', ''],
    ['http.followRedirects', 'false'],
    ['core.hooksPath', join(home, 'disabled-hooks')],
  ];
  if (auth?.token) {
    const basic = Buffer.from(
      `${gitUsername(auth.host ?? gitHost(repository), auth.username)}:${auth.token}`,
    ).toString('base64');
    settings.push([
      `http.${repository}.extraHeader`,
      `Authorization: Basic ${basic}`,
    ]);
  }
  // An allowlist excludes ambient credentials, Git config, tracing, askpass,
  // SSH agents, proxies, and inherited home-directory credential files.
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    ...(process.env.SystemRoot && { SystemRoot: process.env.SystemRoot }),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(settings.length),
  };
  settings.forEach(([key, value], index) => {
    environment[`GIT_CONFIG_KEY_${index}`] = key;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return environment;
}

async function cloneRepository(
  repository: string,
  destination: string,
  ref: string | undefined,
  env: NodeJS.ProcessEnv,
  cwd: string,
) {
  if (ref && /^[0-9a-fA-F]{7,40}$/.test(ref)) {
    try {
      await runGit(['init', destination], env, cwd);
      await runGit(
        ['-C', destination, 'remote', 'add', 'origin', repository],
        env,
        cwd,
      );
      await runGit(
        [
          '-C',
          destination,
          'fetch',
          '--depth',
          '1',
          '--no-tags',
          '--',
          'origin',
          ref,
        ],
        env,
        cwd,
      );
      await runGit(
        ['-C', destination, 'checkout', '--detach', 'FETCH_HEAD'],
        env,
        cwd,
      );
      return;
    } catch {
      // A branch can also have a hexadecimal name, matching the SDK fallback.
      await rm(destination, { recursive: true, force: true });
    }
  }
  await runGit(
    [
      'clone',
      '--depth',
      '1',
      '--no-tags',
      ...(ref ? ['--branch', ref] : []),
      '--',
      repository,
      destination,
    ],
    env,
    cwd,
  );
}

function runGit(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  return new Promise<void>((resolve, reject) => {
    const failure = () =>
      reject(new Error('Git repository preparation failed.'));
    const child = spawn('git', args, {
      env,
      cwd,
      stdio: 'ignore',
      timeout: 300_000,
      killSignal: 'SIGKILL',
    });
    // Do not attach stderr, argv, or the original error: they may contain secrets.
    child.once('error', failure);
    child.once('close', (code) => (code === 0 ? resolve() : failure()));
  });
}

// A mount is ephemeral, so a snapshot keeps the workspace files and skips the remote storage.
function mountEntry(
  spec: MountSpec,
  path: string,
  credentials?: Map<string, GitCredentials>,
) {
  switch (spec.provider) {
    case 's3':
      return attached(
        s3Mount({
          bucket: spec.bucket,
          ...(spec.region && { region: spec.region }),
          ...(spec.prefix && { prefix: spec.prefix }),
          ...(spec.accessKeyId && { accessKeyId: spec.accessKeyId }),
          ...(spec.secretAccessKey && {
            secretAccessKey: spec.secretAccessKey,
          }),
          ...(spec.sessionToken && { sessionToken: spec.sessionToken }),
          ...(spec.endpointUrl && { endpointUrl: spec.endpointUrl }),
          ...(spec.s3Provider && { s3Provider: spec.s3Provider }),
        }),
        spec.readOnly,
      );
    case 's3-files':
      return attached(
        s3FilesMount({
          fileSystemId: spec.fileSystemId,
          ...(spec.subpath && { subpath: spec.subpath }),
          ...(spec.mountTargetIp && { mountTargetIp: spec.mountTargetIp }),
          ...(spec.accessPoint && { accessPoint: spec.accessPoint }),
          ...(spec.region && { region: spec.region }),
        }),
        spec.readOnly,
      );
    case 'gcs':
      return attached(
        gcsMount({
          bucket: spec.bucket,
          ...(spec.prefix && { prefix: spec.prefix }),
          ...(spec.accessId && { accessId: spec.accessId }),
          ...(spec.secretAccessKey && {
            secretAccessKey: spec.secretAccessKey,
          }),
          ...(spec.region && { region: spec.region }),
          ...(spec.endpointUrl && { endpointUrl: spec.endpointUrl }),
          ...(spec.serviceAccountFile && {
            serviceAccountFile: spec.serviceAccountFile,
          }),
          ...(spec.serviceAccountCredentials && {
            serviceAccountCredentials: spec.serviceAccountCredentials,
          }),
          ...(spec.accessToken && { accessToken: spec.accessToken }),
        }),
        spec.readOnly,
      );
    case 'r2':
      return attached(
        r2Mount({
          bucket: spec.bucket,
          accountId: spec.accountId,
          ...(spec.prefix && { prefix: spec.prefix }),
          ...(spec.accessKeyId && { accessKeyId: spec.accessKeyId }),
          ...(spec.secretAccessKey && {
            secretAccessKey: spec.secretAccessKey,
          }),
        }),
        spec.readOnly,
      );
    case 'azure':
      return attached(
        azureBlobMount({
          container: spec.container,
          ...(spec.accountName && { accountName: spec.accountName }),
          ...(spec.accountKey && { accountKey: spec.accountKey }),
          ...(spec.prefix && { prefix: spec.prefix }),
        }),
        spec.readOnly,
      );
    case 'box':
      return attached(
        boxMount({
          ...(spec.clientId && { clientId: spec.clientId }),
          ...(spec.clientSecret && { clientSecret: spec.clientSecret }),
          ...(spec.accessToken && { accessToken: spec.accessToken }),
          ...(spec.token && { token: spec.token }),
          ...(spec.boxConfigFile && { boxConfigFile: spec.boxConfigFile }),
          ...(spec.configCredentials && {
            configCredentials: spec.configCredentials,
          }),
          ...(spec.boxSubType && { boxSubType: spec.boxSubType }),
          ...(spec.rootFolderId && { rootFolderId: spec.rootFolderId }),
          ...(spec.impersonate && { impersonate: spec.impersonate }),
          ...(spec.ownedBy && { ownedBy: spec.ownedBy }),
          ...(spec.path && { path: spec.path }),
        }),
        spec.readOnly,
      );
    case 'github':
    case 'gitlab':
    case 'bitbucket': {
      const parsed = parseRepoLink(spec.url);
      return gitRepo({
        repo: withGitCredentials(
          parsed.repo,
          spec,
          path,
          credentials,
          spec.provider,
        ),
        host: defaultGitHost(spec.provider),
        ...((spec.ref ?? parsed.ref) ? { ref: spec.ref ?? parsed.ref } : {}),
      });
    }
    case 'google-drive':
      return mount({
        ephemeral: true,
        readOnly: spec.readOnly ?? true,
        mountStrategy: inContainerMountStrategy({
          pattern: {
            type: 'rclone',
            remote: spec.remote ?? 'gdrive:',
            ...(spec.configFile && { configFilePath: spec.configFile }),
          },
        }),
      });
  }
}

// Docker attaches cloud storage only with an in-container strategy. Leave readOnly on unless the agent should write back.
function attached<T extends object>(entry: T, readOnly?: boolean) {
  return {
    ...entry,
    ephemeral: true,
    readOnly: readOnly ?? true,
    mountStrategy: inContainerMountStrategy(),
  };
}

// Turn a Git host link into a cloned folder. path and ref override the folder name and branch.
function repoEntry(
  repo: string | RepoLink,
  credentials?: Map<string, GitCredentials>,
) {
  const link = typeof repo === 'string' ? { url: repo } : repo;
  const parsed = parseRepoLink(link.url);
  const path = link.path ? workspacePath(link.path) : parsed.path;

  return {
    [path]: gitRepo({
      repo: withGitCredentials(
        parsed.repo,
        link,
        normalizeRelativePath(path),
        credentials,
      ),
      ...((link.ref ?? parsed.ref) ? { ref: link.ref ?? parsed.ref } : {}),
    }),
  };
}

// Tokens stay in the preparation call's memory, never in a Manifest or process.env.
function withGitCredentials(
  repo: string,
  auth: { token?: string; username?: string },
  path: string,
  credentials?: Map<string, GitCredentials>,
  host?: GitHost,
) {
  credentials?.delete(path);
  if (!auth.token) return repo;
  if (!credentials) {
    throw new Error(
      'Private Git tokens require await prepareManifest(options).',
    );
  }
  credentials.set(path, { ...auth, host });
  return repo;
}

function gitHost(repo: string): GitHost {
  if (!repo.includes('://')) return 'github';
  const host = new URL(repo).hostname;
  if (
    host === 'gitlab.com' ||
    host.endsWith('.gitlab.com') ||
    host.includes('gitlab')
  ) {
    return 'gitlab';
  }
  if (host === 'bitbucket.org' || host.endsWith('.bitbucket.org'))
    return 'bitbucket';
  return 'github';
}

function defaultGitHost(host: GitHost) {
  if (host === 'gitlab') return 'gitlab.com';
  if (host === 'bitbucket') return 'bitbucket.org';
  return 'github.com';
}

function gitUsername(host: GitHost, username?: string) {
  if (username) return username;
  if (host === 'gitlab') return 'oauth2';
  if (host === 'bitbucket') return 'x-token-auth';
  return 'x-access-token';
}

//1. Accept an owner/name slug, an https link, or a git@ clone address.
//2. GitHub and GitBucket use /tree/<branch>. GitLab uses /-/tree/<branch>. Bitbucket uses /src/<branch>.
function parseRepoLink(link: string) {
  const trimmed = link.trim();
  if (!trimmed) throw new Error('Repo link must not be empty.');

  if (!trimmed.includes('://') && !trimmed.startsWith('git@')) {
    const [repo, ref] = trimmed.split('@');
    return { repo, ref, path: repo.split('/').pop() || 'repo' };
  }

  if (trimmed.startsWith('git@')) {
    const repoPath =
      trimmed
        .split(':')
        .pop()
        ?.replace(/\.git$/, '') ?? 'repo';
    return { repo: trimmed, path: repoPath.split('/').pop() || 'repo' };
  }

  const url = new URL(trimmed);
  const parts = url.pathname
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean);
  const marker = parts.findIndex((part, index) => {
    if (part === '-' && parts[index + 1] === 'tree') return true;
    if (part === 'tree' || part === 'src') return true;
    return false;
  });
  const repoParts = marker === -1 ? parts : parts.slice(0, marker);
  const ref =
    marker === -1
      ? undefined
      : parts[marker] === '-'
        ? parts[marker + 2]
        : parts[marker + 1];
  const name = repoParts.at(-1) || 'repo';

  return {
    repo: `${url.protocol}//${url.host}/${repoParts.join('/')}.git`,
    ref,
    path: name,
  };
}

// Manifest paths stay inside the workspace. Absolute paths and parent segments are rejected.
function workspacePath(path: string) {
  const normalized = path.trim().replace(/^\.\//, '');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.split('/').includes('..')
  ) {
    throw new Error(`Workspace path must stay inside the workspace: ${path}`);
  }
  return normalized;
}
