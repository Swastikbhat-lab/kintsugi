/**
 * The Langfuse SDK is an *optional* dependency, imported dynamically only
 * when LANGFUSE keys are present (src/tracer.ts). Without a declaration,
 * tsc cannot resolve the uninstalled module; this keeps the import honest
 * without forcing the SDK on every install.
 */
declare module 'langfuse';
