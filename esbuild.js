const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').Plugin} */
const problemMatcherPlugin = {
    name: 'esbuild-problem-matcher',
    setup(build) {
        build.onStart(() => console.log('[watch] build started'));
        build.onEnd((result) => {
            for (const { text, location } of result.errors) {
                console.error(`✘ [ERROR] ${text}`);
                if (location) {
                    console.error(`    ${location.file}:${location.line}:${location.column}:`);
                }
            }
            console.log('[watch] build finished');
        });
    },
};

const shared = {
    bundle: true,
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    logLevel: watch ? 'silent' : 'warning',
    plugins: watch ? [problemMatcherPlugin] : [],
};

async function main() {
    const contexts = await Promise.all([
        // Extension host bundle (Node.js, CommonJS; `vscode` is provided at runtime).
        esbuild.context({
            ...shared,
            entryPoints: ['src/extension.ts'],
            outfile: 'dist/extension.js',
            platform: 'node',
            format: 'cjs',
            external: ['vscode'],
        }),
        // Webview bundle (browser, self-contained script).
        esbuild.context({
            ...shared,
            entryPoints: ['src/webview/main.ts'],
            outfile: 'dist/webview.js',
            platform: 'browser',
            format: 'iife',
            target: 'es2022',
        }),
    ]);
    if (watch) {
        await Promise.all(contexts.map((ctx) => ctx.watch()));
    } else {
        await Promise.all(contexts.map((ctx) => ctx.rebuild()));
        await Promise.all(contexts.map((ctx) => ctx.dispose()));
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
