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

  it('accepts a private git token, S3 Files, a GCS key, and a Box enterprise user', () => {
    const manifest = createManifest({
      repo: {
        url: 'https://github.com/owner/private',
        token: 'github-token',
      },
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
        lab: {
          provider: 'gitlab',
          url: 'https://gitlab.com/group/api',
          token: 'gitlab-token',
        },
      },
    });

    expect(manifest.entries.private).toMatchObject({
      type: 'git_repo',
      repo: 'https://x-access-token:github-token@github.com/owner/private.git',
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
    expect(manifest.entries.lab).toMatchObject({
      repo: 'https://oauth2:gitlab-token@gitlab.com/group/api.git',
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
