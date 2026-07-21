export const withSentry = (options: any, worker: any) => worker;
export const withMonitor = (name: string, fn: any, options?: any) => fn;
export const captureException = (err: any, options?: any) => console.error("Dummy Sentry captureException", err, options);
export const captureMessage = (msg: string, level?: string) => console.log("Dummy Sentry captureMessage", msg, level);
export const setTags = (tags: any) => {};
export const consoleLoggingIntegration = (options: any) => ({ name: 'ConsoleLogging' });
