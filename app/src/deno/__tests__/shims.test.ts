import { describe, expect, it, vi } from 'vitest';
import { S3BucketShim } from '../shims.ts';

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
