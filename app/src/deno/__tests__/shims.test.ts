import { describe, expect, it, vi } from 'vitest';
import { S3BucketShim, KVNamespaceShim, KV_NEVER_MIRROR_PREFIXES } from '../shims.ts';

describe('KVNamespaceShim', () => {
  it('defines KV_NEVER_MIRROR_PREFIXES with expected sensitive prefixes', () => {
    expect(KV_NEVER_MIRROR_PREFIXES).toEqual(['sess:', 'magic:', 'infisical_secrets_cache:']);
  });

  it('excludes sess:, magic:, and infisical_secrets_cache: from mirroring into SQLite DB', async () => {
    const fakeKv = {
      get: vi.fn(async () => ({ value: 'secret-in-deno-kv' })),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    };
    const dbRun = vi.fn(async () => ({ success: true, meta: { changes: 1 } }));
    const dbShim = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({ run: dbRun, first: vi.fn(async () => null) })),
      })),
    };
    const shim = new KVNamespaceShim(fakeKv as never, 'config', () => dbShim as never);

    await shim.put('sess:token123', '{"userId":"u1"}');
    expect(fakeKv.set).toHaveBeenCalledWith(['config', 'sess:token123'], '{"userId":"u1"}', undefined);
    expect(dbShim.prepare).not.toHaveBeenCalled();

    await shim.get('sess:token123');
    expect(fakeKv.get).toHaveBeenCalledWith(['config', 'sess:token123']);

    await shim.put('cache:public_feed', '{"items":[]}');
    expect(dbShim.prepare).toHaveBeenCalled();
  });

  it('performs atomic take via Deno KV versionstamp CAS', async () => {
    const fakeAtomic = {
      check: vi.fn(() => fakeAtomic),
      delete: vi.fn(() => fakeAtomic),
      commit: vi.fn(async () => ({ ok: true })),
    };
    const fakeKv = {
      get: vi.fn(async () => ({ value: 'user@example.com', versionstamp: 'v1' })),
      atomic: vi.fn(() => fakeAtomic),
    };
    const shim = new KVNamespaceShim(fakeKv as never, 'config');

    const result = await shim.take('magic:hash123');
    expect(result).toBe('user@example.com');
    expect(fakeAtomic.check).toHaveBeenCalledWith({ key: ['config', 'magic:hash123'], versionstamp: 'v1' });
    expect(fakeAtomic.delete).toHaveBeenCalledWith(['config', 'magic:hash123']);
  });
});

describe('S3BucketShim.get', () => {
  it('preserves object content type for classifier consumers', async () => {
    const body = {
      transformToByteArray: vi.fn(async () => new Uint8Array([1, 2, 3])),
      transformToString: vi.fn(async () => 'payload'),
    };
    const send = vi.fn(async () => ({ Body: body, ContentType: 'application/pdf' }));
    const bucket = new S3BucketShim({ send } as never, 'raw');

    await expect(bucket.get('filing.pdf')).resolves.toMatchObject({
      httpMetadata: { contentType: 'application/pdf' },
    });
  });

  it('returns null only for a genuine missing object', async () => {
    const missing = Object.assign(new Error('missing'), {
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 },
    });
    const send = vi.fn(async () => {
      throw missing;
    });
    const bucket = new S3BucketShim({ send } as never, 'raw');

    await expect(bucket.get('missing.pdf')).resolves.toBeNull();
  });

  it.each(['AccessDenied', 'NotEntitled', 'InvalidAccessKeyId', 'SignatureDoesNotMatch'])(
    'rejects %s so durable processing can retry',
    async (name) => {
      const providerFailure = Object.assign(new Error(name), {
        name,
        $metadata: { httpStatusCode: 403 },
      });
      const send = vi.fn(async () => {
        throw providerFailure;
      });
      const bucket = new S3BucketShim({ send } as never, 'raw');

      await expect(bucket.get('filing.pdf')).rejects.toBe(providerFailure);
    },
  );
});

describe('S3BucketShim multipart uploads', () => {
  it('maps create/upload/complete/abort to S3 commands', async () => {
    const send = vi.fn(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'CreateMultipartUploadCommand') {
        return { UploadId: 'upload-1' };
      }
      if (command.constructor.name === 'UploadPartCommand') {
        return { ETag: 'etag-1' };
      }
      return {};
    });
    const bucket = new S3BucketShim({ send } as never, 'raw');
    const upload = await bucket.createMultipartUpload('snapshot.ndjson', {
      httpMetadata: { contentType: 'application/x-ndjson' },
    });
    const part = await upload.uploadPart(1, new Uint8Array([1, 2, 3]));
    expect(part).toEqual({ partNumber: 1, etag: 'etag-1' });
    await upload.complete([part]);
    await upload.abort();

    expect(send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
      'CreateMultipartUploadCommand',
      'UploadPartCommand',
      'CompleteMultipartUploadCommand',
      'AbortMultipartUploadCommand',
    ]);
  });
});
