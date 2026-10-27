import { describe, expect, it } from 'vitest';
import { createManifest } from '@/config/workspace/index.js';

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
