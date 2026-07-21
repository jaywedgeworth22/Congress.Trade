export const withSentry = (options: any, worker: any) => worker;
export const withMonitor = (name: string, fn: any, options?: any) => fn;
export const captureException = (err: any, options: any) => console.error("Dummy Sentry captureException", err, options);
export const setTags = (tags: any) => {};
