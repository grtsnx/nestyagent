import { describe, expect, it } from 'vitest';
import {
  awsRunArgs,
  awsTerminateArgs,
  databricksExecutorScript,
  digitalOceanManifest,
} from '@/lib/sandbox/sandbox.service.js';

describe('remote machine commands', () => {
  it('builds the AWS MicroVM run and terminate commands', () => {
    expect(
      awsRunArgs({
        image: 'arn:aws:lambda:us-east-1:123:microvm-image:codex',
        payload: '{"environmentId":"env_1"}',
        region: 'us-east-1',
        executionRole: 'arn:aws:iam::123:role/microvm',
      }),
    ).toEqual([
      'lambda-microvms',
      'run-microvm',
      '--image-identifier',
      'arn:aws:lambda:us-east-1:123:microvm-image:codex',
      '--run-hook-payload',
      '{"environmentId":"env_1"}',
      '--output',
      'json',
      '--execution-role-arn',
      'arn:aws:iam::123:role/microvm',
      '--region',
      'us-east-1',
    ]);

    expect(awsTerminateArgs('mvm-1', 'us-east-1')).toEqual([
      'lambda-microvms',
      'terminate-microvm',
      '--microvm-identifier',
      'mvm-1',
      '--region',
      'us-east-1',
    ]);
  });

  it('keeps the executor key out of the Databricks shell script', () => {
    const script = databricksExecutorScript({
      sessionId: 'sess_1',
      environmentId: 'env_1',
      remoteUrl: 'https://api.openai.com/v1/agents/api',
      executorKey: 'executor-secret',
    });

    expect(script).toContain('codex exec-server');
    expect(script).not.toContain('executor-secret');
  });

  it('puts the Codex connection values in the DigitalOcean manifest', () => {
    const manifest = digitalOceanManifest({
      sessionId: 'sess_1',
      environmentId: 'env_1',
      remoteUrl: 'https://api.openai.com/v1/agents/api',
      executorKey: 'executor-secret',
    });

    expect(manifest).toContain('agent: codex-agentapi');
    expect(manifest).toContain('CODEX_ENVIRONMENT_ID: env_1');
    expect(manifest).toContain('CODEX_API_KEY: executor-secret');
  });
});
