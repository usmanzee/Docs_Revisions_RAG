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
export const MINIMUM_NODE_MAJOR = 22;
export function currentNodeMajor(version = process.versions.node) {
    return Number.parseInt(version.split('.')[0] ?? '0', 10);
}
export function nodeVersionError(version = process.versions.node) {
    const major = currentNodeMajor(version);
    if (Number.isFinite(major) && major >= MINIMUM_NODE_MAJOR)
        return null;
    return [
        '',
        `  Node ${version} is too old. This project requires Node ${MINIMUM_NODE_MAJOR} or newer.`,
        '',
        '  Symptoms if you continue: every PDF fails to parse with',
        '  "Promise.withResolvers is not a function", which looks like corrupt files',
        '  but is not - it is a missing language feature.',
        '',
        '  Fix (an .nvmrc is committed at the repo root):',
        '',
        '      nvm use',
        '      node -v      # expect v24.x',
        '',
        '  Run `nvm use` in every new terminal you use for this project.',
        '',
    ].join('\n');
}
/**
 * Abort with a readable message when the runtime is too old.
 * Called from the server entry point and from every CLI script.
 */
export function assertSupportedNodeVersion() {
    const message = nodeVersionError();
    if (!message)
        return;
    // Written straight to stderr rather than through the logger: this runs before
    // configuration is loaded, and the logger may not exist yet.
    process.stderr.write(`${message}\n`);
    process.exit(1);
}
//# sourceMappingURL=runtime.js.map