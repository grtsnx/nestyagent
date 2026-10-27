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
  mount,
  ManifestEntries,
  ManifestEnvironment,
  r2Mount,
  s3Mount,
} from '@openai/agents/sandbox';

type RepoLink = {
  url: string;
  path?: string;
  ref?: string;
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
    }
  | {
      provider: 'gcs';
      bucket: string;
      prefix?: string;
      accessId?: string;
      secretAccessKey?: string;
      serviceAccountFile?: string;
    }
  | {
      provider: 'r2';
      bucket: string;
      accountId: string;
      prefix?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
    }
  | {
      provider: 'azure';
      container: string;
      accountName?: string;
      accountKey?: string;
      prefix?: string;
    }
  | {
      provider: 'box';
      clientId?: string;
      clientSecret?: string;
      accessToken?: string;
    }
  | {
      provider: 'github' | 'gitlab' | 'bitbucket';
      url: string;
      ref?: string;
    }
  | {
      provider: 'google-drive';
      remote?: string;
      configFile?: string;
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
};

// Build the starting contents of a workspace. Call it with no argument for an empty computer.
// files are text. localFiles and localDirs are copied from this Mac. repo clones a GitHub link.
// outputDirs are empty folders. mounts attach storage, including a Git host or Google Drive.
// entries and environment are optional.
export function createManifest(options?: CreateManifestOptions) {
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
      mountEntry(spec),
    ]),
  );

  return new Manifest({
    entries: {
      ...files,
      ...copiedFiles,
      ...copiedDirs,
      ...outputDirs,
      ...mounts,
      ...(options?.repo && repoEntry(options.repo)),
      ...options?.entries,
    },
    ...(options?.environment && { environment: options.environment }),
  });
}

// A mount is ephemeral, so a snapshot keeps the workspace files and skips the remote storage.
function mountEntry(spec: MountSpec) {
  const ephemeral = true;

  switch (spec.provider) {
    case 's3':
      return s3Mount({
        ephemeral,
        bucket: spec.bucket,
        ...(spec.region && { region: spec.region }),
        ...(spec.prefix && { prefix: spec.prefix }),
        ...(spec.accessKeyId && { accessKeyId: spec.accessKeyId }),
        ...(spec.secretAccessKey && { secretAccessKey: spec.secretAccessKey }),
        ...(spec.sessionToken && { sessionToken: spec.sessionToken }),
      });
    case 'gcs':
      return gcsMount({
        ephemeral,
        bucket: spec.bucket,
        ...(spec.prefix && { prefix: spec.prefix }),
        ...(spec.accessId && { accessId: spec.accessId }),
        ...(spec.secretAccessKey && { secretAccessKey: spec.secretAccessKey }),
        ...(spec.serviceAccountFile && {
          serviceAccountFile: spec.serviceAccountFile,
        }),
      });
    case 'r2':
      return r2Mount({
        ephemeral,
        bucket: spec.bucket,
        accountId: spec.accountId,
        ...(spec.prefix && { prefix: spec.prefix }),
        ...(spec.accessKeyId && { accessKeyId: spec.accessKeyId }),
        ...(spec.secretAccessKey && { secretAccessKey: spec.secretAccessKey }),
      });
    case 'azure':
      return azureBlobMount({
        ephemeral,
        container: spec.container,
        ...(spec.accountName && { accountName: spec.accountName }),
        ...(spec.accountKey && { accountKey: spec.accountKey }),
        ...(spec.prefix && { prefix: spec.prefix }),
      });
    case 'box':
      return boxMount({
        ephemeral,
        ...(spec.clientId && { clientId: spec.clientId }),
        ...(spec.clientSecret && { clientSecret: spec.clientSecret }),
        ...(spec.accessToken && { accessToken: spec.accessToken }),
      });
    case 'github':
    case 'gitlab':
    case 'bitbucket': {
      const parsed = parseRepoLink(spec.url);
      return gitRepo({
        repo: parsed.repo,
        ...((spec.ref ?? parsed.ref) ? { ref: spec.ref ?? parsed.ref } : {}),
      });
    }
    case 'google-drive':
      return mount({
        ephemeral,
        readOnly: true,
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

// Turn a Git host link into a cloned folder. path and ref override the folder name and branch.
function repoEntry(repo: string | RepoLink) {
  const link = typeof repo === 'string' ? { url: repo } : repo;
  const parsed = parseRepoLink(link.url);

  return {
    [link.path ? workspacePath(link.path) : parsed.path]: gitRepo({
      repo: parsed.repo,
      ...((link.ref ?? parsed.ref) ? { ref: link.ref ?? parsed.ref } : {}),
    }),
  };
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
