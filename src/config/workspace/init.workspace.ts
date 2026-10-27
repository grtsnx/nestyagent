import {
  file,
  gitRepo,
  Manifest,
  ManifestEntries,
  ManifestEnvironment,
} from '@openai/agents/sandbox';

type RepoLink = {
  url: string;
  path?: string;
  ref?: string;
};

type CreateManifestOptions = {
  files?: Record<string, string>;
  entries?: ManifestEntries;
  environment?: ManifestEnvironment;
  repo?: string | RepoLink;
};

// Build the starting contents of a workspace. Call it with no argument for an empty computer.
// files are text files. repo clones a GitHub link. entries and environment are optional.
export function createManifest(options?: CreateManifestOptions) {
  const files = Object.fromEntries(
    Object.entries(options?.files ?? {}).map(([path, content]) => [
      path,
      file({ content }),
    ]),
  );

  return new Manifest({
    entries: {
      ...files,
      ...(options?.repo && repoEntry(options.repo)),
      ...options?.entries,
    },
    ...(options?.environment && { environment: options.environment }),
  });
}

// Turn a GitHub link into a cloned folder. path and ref override the folder name and branch.
function repoEntry(repo: string | RepoLink) {
  const link = typeof repo === 'string' ? { url: repo } : repo;
  const parsed = parseRepoLink(link.url);

  return {
    [link.path ?? parsed.path]: gitRepo({
      repo: parsed.repo,
      ...((link.ref ?? parsed.ref) ? { ref: link.ref ?? parsed.ref } : {}),
    }),
  };
}

//1. Accept an owner/name slug, an https link, or a git@ clone address.
//2. A /tree/<branch> link sets the branch. The folder name comes from the repo name.
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
  const parts = url.pathname.split('/').filter(Boolean);
  const owner = parts[0];
  const name = (parts[1] ?? 'repo').replace(/\.git$/, '');
  const ref = parts[2] === 'tree' ? parts[3] : undefined;

  return {
    repo: `${url.protocol}//${url.host}/${owner}/${name}.git`,
    ref,
    path: name,
  };
}
