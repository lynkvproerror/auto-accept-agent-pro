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

    // ─── Step 3: Obfuscate auto_accept.js (injected browser script) ───
    const autoAcceptPath = path.join('./main_scripts', 'auto_accept.js');
    if (fs.existsSync(autoAcceptPath)) {
        console.log('[3/3] Obfuscating auto_accept.js...');
        const browserCode = fs.readFileSync(autoAcceptPath, 'utf8');
        const obfBrowser = JavaScriptObfuscator.obfuscate(browserCode, {
            compact: true,
            controlFlowFlattening: true,
            controlFlowFlatteningThreshold: 0.4,
            deadCodeInjection: true,
            deadCodeInjectionThreshold: 0.15,
            identifierNamesGenerator: 'hexadecimal',
            renameGlobals: false,
            rotateStringArray: true,
            selfDefending: false,
            shuffleStringArray: true,
            splitStrings: true,
            splitStringsChunkLength: 10,
            stringArray: true,
            stringArrayEncoding: ['base64'],
            stringArrayThreshold: 0.75,
            transformObjectKeys: true,
            target: 'browser',
            // Keep public API names so CDP handler can call them
            reservedNames: [
                '^__autoAcceptStart$', '^__autoAcceptStop$',
                '^__autoAcceptGetStats$', '^__autoAcceptResetStats$',
                '^__autoAcceptUpdateBannedCommands$', '^__autoAcceptSetFocusState$',
                '^__autoAcceptState$', '^__agBGLoopOwner$',
                '^__agToolIntervals$', '^__agAutoEnabled$',
                '^__agScrollEnabled$', '^__agSafeClickEnabled$',
                '^__agDiffProtectionEnabled$', '^__agHttpPort$'
            ],
        });
        fs.writeFileSync(autoAcceptPath, obfBrowser.getObfuscatedCode(), 'utf8');
        const bOriginal = Buffer.byteLength(browserCode, 'utf8');
        const bObfuscated = Buffer.byteLength(obfBrowser.getObfuscatedCode(), 'utf8');
        console.log(`[3/3] auto_accept.js: ${(bOriginal / 1024).toFixed(1)}KB → ${(bObfuscated / 1024).toFixed(1)}KB`);
    }

    // ─── Step 4: Obfuscate remaining main_scripts (cdp-handler, compositor, relauncher) ───
    const nodeScripts = ['cdp-handler.js', 'compositor.js', 'relauncher.js'];
    let step = 4;
    const totalSteps = 3 + nodeScripts.length;

    for (const scriptName of nodeScripts) {
        const scriptPath = path.join('./main_scripts', scriptName);
        if (!fs.existsSync(scriptPath)) {
            console.log(`[${step}/${totalSteps}] Skipping ${scriptName} (not found)`);
            step++;
            continue;
        }

        console.log(`[${step}/${totalSteps}] Obfuscating ${scriptName}...`);
        const srcCode = fs.readFileSync(scriptPath, 'utf8');
        const obfNode = JavaScriptObfuscator.obfuscate(srcCode, {
            compact: true,
            controlFlowFlattening: true,
            controlFlowFlatteningThreshold: 0.4,
            deadCodeInjection: true,
            deadCodeInjectionThreshold: 0.15,
            identifierNamesGenerator: 'hexadecimal',
            renameGlobals: false,
            rotateStringArray: true,
            selfDefending: false,
            shuffleStringArray: true,
            splitStrings: true,
            splitStringsChunkLength: 8,
            stringArray: true,
            stringArrayEncoding: ['base64'],
            stringArrayThreshold: 0.75,
            transformObjectKeys: true,
            target: 'node',
            reservedNames: [
                '^require$', '^module$', '^exports$', '^__dirname$', '^__filename$',
                // Preserve exported class/function names
                '^CdpHandler$', '^Relauncher$', '^compose$'
            ],
            reservedStrings: ['vscode'],
        });
        fs.writeFileSync(scriptPath, obfNode.getObfuscatedCode(), 'utf8');
        const sOriginal = Buffer.byteLength(srcCode, 'utf8');
        const sObfuscated = Buffer.byteLength(obfNode.getObfuscatedCode(), 'utf8');
        console.log(`[${step}/${totalSteps}] ${scriptName}: ${(sOriginal / 1024).toFixed(1)}KB → ${(sObfuscated / 1024).toFixed(1)}KB`);
        step++;
    }

    // ─── Cleanup: delete sourcemaps ───
    const mapFile = path.join(DIST_DIR, 'extension.js.map');
    if (fs.existsSync(mapFile)) {
        fs.unlinkSync(mapFile);
        console.log('🗑️  Deleted extension.js.map');
    }

    console.log('\n✅ Build + Obfuscation complete!');
    console.log('   Run: npx @vscode/vsce package --no-dependencies --allow-missing-repository');
}

build().catch(e => {
    console.error('Build failed:', e);
    process.exit(1);
});
