import { Client, InStatement } from '@libsql/client';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

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

  async all<T = any>(): Promise<{ success: boolean; results: T[]; error?: string; meta: any }> {
    try {
      const res = await this.client.execute({ sql: this.query, args: this.params });
      return { success: true, results: res.rows as unknown as T[], meta: res };
    } catch (e: any) {
      return { success: false, results: [], error: e.message, meta: {} };
    }
  }

  async first<T = any>(colName?: string): Promise<T | null> {
    const res = await this.client.execute({ sql: this.query, args: this.params });
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    if (colName) {
      return (row[colName] ?? null) as T;
    }
    return row as unknown as T;
  }

  async run<T = any>(): Promise<{ success: boolean; results: T[]; error?: string; meta: any }> {
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

  async batch<T = any>(statements: D1PreparedStatementShim[]): Promise<{ success: boolean; results: T[]; error?: string; meta: any }[]> {
    try {
      const stmts = statements.map(s => s.statement);
      const res = await this.client.batch(stmts, 'write');
      return res.map(r => ({ success: true, results: r.rows as unknown as T[], meta: r }));
    } catch (e: any) {
      throw new Error(`D1 batch error: ${e.message}`);
    }
  }
}

// --- KVNamespace Shim ---

export class KVNamespaceShim {
  private kv: Deno.Kv;
  private prefix: string;

  constructor(kv: Deno.Kv, prefix: string = 'kv') {
    this.kv = kv;
    this.prefix = prefix;
  }

  async get(key: string, type?: 'text' | 'json' | 'arrayBuffer' | 'stream'): Promise<any> {
    const res = await this.kv.get([this.prefix, key]);
    if (!res.value) return null;
    if (type === 'json') {
      return typeof res.value === 'string' ? JSON.parse(res.value) : res.value;
    }
    return res.value;
  }

  async put(key: string, value: string | ArrayBuffer | ReadableStream, options?: { expirationTtl?: number }): Promise<void> {
    // Note: Deno KV has expireIn, but it requires Deno Deploy or specific flags. 
    // We will just store it without TTL for now, or use expireIn if available.
    let valToStore = value;
    if (typeof value !== 'string' && !(value instanceof ArrayBuffer)) {
      // Stream not easily supported in KV, we convert to string if possible, or just reject
      throw new Error("Streams not supported in KVNamespaceShim yet");
    }
    await this.kv.set([this.prefix, key], valToStore, options?.expirationTtl ? { expireIn: options.expirationTtl * 1000 } : undefined);
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete([this.prefix, key]);
  }
}

// --- Queue Shim ---

export class QueueShim<Message> {
  private kv: Deno.Kv;
  private queueName: string;

  constructor(kv: Deno.Kv, queueName: string) {
    this.kv = kv;
    this.queueName = queueName;
  }

  async send(message: Message): Promise<void> {
    await this.kv.enqueue({ queue: this.queueName, body: message });
  }

  async sendBatch(messages: { body: Message }[]): Promise<void> {
    for (const msg of messages) {
      await this.send(msg.body);
    }
  }
}

// --- R2Bucket Shim ---

export class R2BucketShim {
  private s3: S3Client;
  private bucketName: string;

  constructor(s3: S3Client, bucketName: string) {
    this.s3 = s3;
    this.bucketName = bucketName;
  }

  async get(key: string): Promise<{ body: ReadableStream, arrayBuffer: () => Promise<ArrayBuffer>, text: () => Promise<string>, json: () => Promise<any> } | null> {
    try {
      const command = new GetObjectCommand({ Bucket: this.bucketName, Key: key });
      const response = await this.s3.send(command);
      
      if (!response.Body) return null;
      
      // Node.js/Deno streams to web streams conversion might be needed, but @aws-sdk returns a web stream in Deno.
      const bodyStream = response.Body as any;
      
      return {
        body: bodyStream,
        async arrayBuffer() {
          const arr = await response.Body?.transformToByteArray();
          return arr ? arr.buffer : new ArrayBuffer(0);
        },
        async text() {
          return await response.Body?.transformToString() ?? '';
        },
        async json() {
          const t = await response.Body?.transformToString();
          return t ? JSON.parse(t) : null;
        }
      };
    } catch (e: any) {
      if (e.name === 'NoSuchKey') return null;
      throw e;
    }
  }

  async put(key: string, value: string | ArrayBuffer | ReadableStream | Blob, options?: { httpMetadata?: { contentType?: string } }): Promise<void> {
    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: value as any,
      ContentType: options?.httpMetadata?.contentType
    });
    await this.s3.send(command);
  }

  async delete(key: string): Promise<void> {
    const command = new DeleteObjectCommand({ Bucket: this.bucketName, Key: key });
    await this.s3.send(command);
  }
}
