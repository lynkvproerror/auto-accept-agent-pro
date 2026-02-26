const esbuild = require('esbuild');
const JavaScriptObfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');

const DIST_DIR = './dist';
const BUNDLE_FILE = path.join(DIST_DIR, 'extension.js');

// ─── Step 1: esbuild bundle (no minify — obfuscator will handle it) ───
async function build() {
    console.log('[1/3] Bundling with esbuild...');
    await esbuild.build({
        entryPoints: ['./extension.js'],
        bundle: true,
        outfile: BUNDLE_FILE,
        external: ['vscode'],
        format: 'cjs',
        platform: 'node',
        target: 'node16',
        sourcemap: false,  // No sourcemaps for distribution!
        minify: false       // Obfuscator will minify
    });
    console.log('[1/3] Bundle created');

    // ─── Step 2: Obfuscate the bundled extension.js ───
    console.log('[2/3] Obfuscating extension.js...');
    const code = fs.readFileSync(BUNDLE_FILE, 'utf8');
    const obfuscated = JavaScriptObfuscator.obfuscate(code, {
        // ── High obfuscation preset ──
        compact: true,
        controlFlowFlattening: true,
        controlFlowFlatteningThreshold: 0.5,
        deadCodeInjection: true,
        deadCodeInjectionThreshold: 0.2,
        identifierNamesGenerator: 'hexadecimal',
        renameGlobals: false,  // Don't rename module.exports
        rotateStringArray: true,
        selfDefending: false,  // Can break in strict envs
        shuffleStringArray: true,
        splitStrings: true,
        splitStringsChunkLength: 8,
        stringArray: true,
        stringArrayCallsTransform: true,
        stringArrayEncoding: ['base64'],
        stringArrayIndexShift: true,
        stringArrayRotate: true,
        stringArrayShuffle: true,
        stringArrayWrappersCount: 2,
        stringArrayWrappersChainedCalls: true,
        stringArrayWrappersParametersMaxCount: 4,
        stringArrayWrappersType: 'function',
        stringArrayThreshold: 0.75,
        transformObjectKeys: true,
        unicodeEscapeSequence: false,

        // ── Keep Node.js compatibility ──
        target: 'node',
        // Don't break require() calls
        reservedNames: ['^require$', '^module$', '^exports$', '^__dirname$', '^__filename$'],
        reservedStrings: ['vscode'],
    });
    fs.writeFileSync(BUNDLE_FILE, obfuscated.getObfuscatedCode(), 'utf8');

    const originalSize = Buffer.byteLength(code, 'utf8');
    const obfuscatedSize = Buffer.byteLength(obfuscated.getObfuscatedCode(), 'utf8');
    console.log(`[2/3] Obfuscated: ${(originalSize / 1024).toFixed(1)}KB → ${(obfuscatedSize / 1024).toFixed(1)}KB`);

    // ─── NOTE: main_scripts/ are NOT obfuscated (clean source preserved) ───
    // Only dist/extension.js is obfuscated. main_scripts/ files are kept readable
    // for development and debugging. To obfuscate for release, use a separate
    // npm run compile:release script.

    // ─── Cleanup: delete sourcemaps ───
    const mapFile = path.join(DIST_DIR, 'extension.js.map');
    if (fs.existsSync(mapFile)) {
        fs.unlinkSync(mapFile);
        console.log('🗑️  Deleted extension.js.map');
    }

    // ─── Copy dynamically-required scripts into dist/ ───
    // cdp-handler.js uses `require('./compositor')` which resolves relative to dist/
    // compositor.js uses `require('./background_mode.js')` via fs.readFileSync
    // setup-panel.js is dynamically required by extension.js
    const dynamicDeps = [
        { src: path.join('./main_scripts', 'compositor.js'), dest: path.join(DIST_DIR, 'compositor.js') },
        { src: path.join('./main_scripts', 'background_mode.js'), dest: path.join(DIST_DIR, 'background_mode.js') },
        { src: './setup-panel.js', dest: path.join(DIST_DIR, 'setup-panel.js') },
    ];
    for (const { src, dest } of dynamicDeps) {
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, dest);
            console.log(`📋 Copied ${src} → ${dest}`);
        } else {
            console.log(`⚠️  Skipping ${src} (not found)`);
        }
    }

    console.log('\n✅ Build + Obfuscation complete!');
    console.log('   Run: npx @vscode/vsce package --no-dependencies --allow-missing-repository');
}

build().catch(e => {
    console.error('Build failed:', e);
    process.exit(1);
});
