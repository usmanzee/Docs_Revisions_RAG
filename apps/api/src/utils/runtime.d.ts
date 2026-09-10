/**
 * Node runtime check.
 *
 * `package.json` declares an `engines` range, but npm only warns about it - and
 * a warning scrolls past. Running on an older Node does not fail cleanly: the
 * PDF parser throws `Promise.withResolvers is not a function` once per document,
 * which reads like a corrupt-file problem rather than a runtime problem, and an
 * ingestion run turns into dozens of misleading failures.
 *
 * One clear error at start-up is worth far more than that.
 */
/** Minimum supported major version. pdfjs-dist, openai and @langchain/openai all require it. */
export declare const MINIMUM_NODE_MAJOR = 22;
export declare function currentNodeMajor(version?: string): number;
export declare function nodeVersionError(version?: string): string | null;
/**
 * Abort with a readable message when the runtime is too old.
 * Called from the server entry point and from every CLI script.
 */
export declare function assertSupportedNodeVersion(): void;
//# sourceMappingURL=runtime.d.ts.map