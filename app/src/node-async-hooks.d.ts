declare module 'node:async_hooks' {
  /** Minimal runtime surface provided by Cloudflare Workers nodejs_compat. */
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  }
}
