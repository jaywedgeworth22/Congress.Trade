import type { Client, InStatement } from "npm:@libsql/client/web";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";

// --- D1Database Shim ---

export class D1PreparedStatementShim {
  private client: Client;
  private query: string;
  private params: any[];

  constructor(client: Client, query: string, params: any[] = []) {
    this.client = client;
    this.query = query;
    this.params = params;
  }

  bind(...values: any[]): D1PreparedStatementShim {
    return new D1PreparedStatementShim(this.client, this.query, values);
  }

  async all<T = any>(): Promise<
    { success: boolean; results: T[]; error?: string; meta: any }
  > {
    try {
      const res = await this.client.execute({
        sql: this.query,
        args: this.params,
      });
      return {
        success: true,
        results: res.rows as unknown as T[],
        meta: d1Meta(res),
      };
    } catch (e: any) {
      // Cloudflare D1 rejects failed statements. Propagating here is critical
      // for durable producers: a failed INSERT must never look like an accepted
      // queue message to its caller.
      throw new Error(`D1 statement error: ${e.message}`, { cause: e });
    }
  }

  async first<T = any>(colName?: string): Promise<T | null> {
    const res = await this.client.execute({
      sql: this.query,
      args: this.params,
    });
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    if (colName) {
      return (row[colName] ?? null) as T;
    }
    return row as unknown as T;
  }

  async run<T = any>(): Promise<
    { success: boolean; results: T[]; error?: string; meta: any }
  > {
    return this.all<T>();
  }

  get statement(): InStatement {
    return { sql: this.query, args: this.params };
  }
}

export class D1DatabaseShim {
  private client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  prepare(query: string): D1PreparedStatementShim {
    return new D1PreparedStatementShim(this.client, query);
  }

  async batch<T = any>(
    statements: D1PreparedStatementShim[],
  ): Promise<{ success: boolean; results: T[]; error?: string; meta: any }[]> {
    try {
      const stmts = statements.map((s) => s.statement);
      const res = await this.client.batch(stmts, "write");
      return res.map((r) => ({
        success: true,
        results: r.rows as unknown as T[],
        meta: d1Meta(r),
      }));
    } catch (e: any) {
      throw new Error(`D1 batch error: ${e.message}`);
    }
  }
}

function d1Meta(result: {
  rows: unknown[];
  rowsAffected: number;
  lastInsertRowid?: bigint;
}) {
  return {
    changes: result.rowsAffected,
    last_row_id: result.lastInsertRowid == null
      ? 0
      : Number(result.lastInsertRowid),
    changed_db: result.rowsAffected > 0,
    rows_read: result.rows.length,
    rows_written: result.rowsAffected,
    duration: 0,
    size_after: 0,
  };
}

// --- KVNamespace Shim ---

export class KVNamespaceShim {
  private kv: Deno.Kv;
  private prefix: string;

  constructor(kv: Deno.Kv, prefix: string = "kv") {
    this.kv = kv;
    this.prefix = prefix;
  }

  async get(
    key: string,
    type?: "text" | "json" | "arrayBuffer" | "stream",
  ): Promise<any> {
    const res = await this.kv.get([this.prefix, key]);
    if (!res.value) return null;
    if (type === "json") {
      return typeof res.value === "string" ? JSON.parse(res.value) : res.value;
    }
    return res.value;
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ReadableStream,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    let valToStore = value;
    if (typeof value !== "string" && !(value instanceof ArrayBuffer)) {
      throw new Error("Streams not supported in KVNamespaceShim yet");
    }
    await this.kv.set(
      [this.prefix, key],
      valToStore,
      options?.expirationTtl
        ? { expireIn: options.expirationTtl * 1000 }
        : undefined,
    );
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete([this.prefix, key]);
  }
}

// --- S3Bucket Shim ---

export class S3BucketShim {
  private s3: S3Client;
  private bucketName: string;

  constructor(s3: S3Client, bucketName: string) {
    this.s3 = s3;
    this.bucketName = bucketName;
  }

  async get(key: string): Promise<
    {
      body: ReadableStream;
      httpMetadata: { contentType?: string };
      arrayBuffer: () => Promise<ArrayBuffer>;
      text: () => Promise<string>;
      json: () => Promise<any>;
    } | null
  > {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });
      const response = await this.s3.send(command);
      if (!response.Body) return null;
      const bodyStream = response.Body as any;
      return {
        body: bodyStream,
        httpMetadata: { contentType: response.ContentType },
        async arrayBuffer() {
          const arr = await response.Body?.transformToByteArray();
          return (arr ? arr.buffer : new ArrayBuffer(0)) as ArrayBuffer;
        },
        async text() {
          return await response.Body?.transformToString() ?? "";
        },
        async json() {
          const t = await response.Body?.transformToString();
          return t ? JSON.parse(t) : null;
        },
      };
    } catch (e: any) {
      // Only a genuine missing object is a cache miss. Authentication,
      // entitlement, TLS, and provider outages must reject so the durable
      // queue can retry instead of acknowledging lost RAW_FILES access.
      const name = String(e?.name ?? "");
      const code = String(
        e?.Code ?? e?.code ?? e?.$metadata?.httpStatusCode ?? "",
      );
      if (
        name === "NoSuchKey" ||
        name === "NotFound" ||
        code === "NoSuchKey" ||
        code === "NotFound" ||
        code === "404"
      ) {
        return null;
      }
      throw e;
    }
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ReadableStream | Blob,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<void> {
    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: value as any,
      ContentType: options?.httpMetadata?.contentType,
    });
    await this.s3.send(command);
  }

  async delete(key: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    });
    await this.s3.send(command);
  }

  async createMultipartUpload(
    key: string,
    options?: { httpMetadata?: { contentType?: string } },
  ) {
    const created = await this.s3.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucketName,
        Key: key,
        ContentType: options?.httpMetadata?.contentType,
      }),
    );
    if (!created.UploadId) {
      throw new Error("S3 multipart upload did not return an upload id");
    }
    const uploadId = created.UploadId;
    const s3 = this.s3;
    const bucketName = this.bucketName;
    return {
      key,
      uploadId,
      async uploadPart(partNumber: number, value: unknown) {
        const uploaded = await s3.send(
          new UploadPartCommand({
            Bucket: bucketName,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: value as any,
          }),
        );
        if (!uploaded.ETag) {
          throw new Error(
            `S3 multipart part ${partNumber} did not return an ETag`,
          );
        }
        return { partNumber, etag: uploaded.ETag };
      },
      async complete(parts: Array<{ partNumber: number; etag: string }>) {
        await s3.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucketName,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: {
              Parts: parts.map((part) => ({
                PartNumber: part.partNumber,
                ETag: part.etag,
              })),
            },
          }),
        );
      },
      async abort() {
        await s3.send(
          new AbortMultipartUploadCommand({
            Bucket: bucketName,
            Key: key,
            UploadId: uploadId,
          }),
        );
      },
    };
  }
}
