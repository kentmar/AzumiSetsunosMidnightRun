import { defineConfig, type Plugin } from 'vite';
import JavaScriptObfuscator from 'javascript-obfuscator';

// Production build hardening:
// - libraries (three, rapier) go in their own vendor chunk, left as plain minified
// - our game code chunk is run through javascript-obfuscator, light settings only
//   (no control-flow flattening / dead code) so the 60 Hz loop doesn't pay for it
// - no source maps
// - hosts the domain lock (src/guard.ts) accepts: the official site (always,
//   first entry = where the "unauthorized copy" notice links), plus ALLOWED_HOSTS
//   (comma list) and RAILWAY_PUBLIC_DOMAIN, read at build time. A listed host
//   also covers its subdomains, so azumisetsuno.com lets the main site embed it.

const OFFICIAL_HOSTS = 'drive.azumisetsuno.com,azumisetsuno.com';

const allowedHosts = [OFFICIAL_HOSTS, process.env.ALLOWED_HOSTS ?? '', process.env.RAILWAY_PUBLIC_DOMAIN ?? '']
  .flatMap((s) => s.split(','))
  .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
  .filter((s, i, a) => s && a.indexOf(s) === i);

function obfuscateGameCode(): Plugin {
  return {
    name: 'obfuscate-game-code',
    apply: 'build',
    enforce: 'post',
    renderChunk(code, chunk) {
      if (chunk.name === 'vendor') return null;
      const out = JavaScriptObfuscator.obfuscate(code, {
        compact: true,
        target: 'browser',
        sourceMap: false,
        identifierNamesGenerator: 'hexadecimal',
        renameGlobals: false,
        stringArray: true,
        stringArrayThreshold: 1,
        stringArrayEncoding: ['base64'],
        stringArrayRotate: true,
        stringArrayShuffle: true,
        splitStrings: false,
        controlFlowFlattening: false,
        deadCodeInjection: false,
        selfDefending: false,
        debugProtection: false,
        transformObjectKeys: false,
        unicodeEscapeSequence: false,
      });
      return { code: out.getObfuscatedCode(), map: null };
    },
  };
}

export default defineConfig({
  define: {
    __ALLOWED_HOSTS__: JSON.stringify(allowedHosts),
  },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) return 'vendor';
        },
      },
    },
  },
  plugins: [obfuscateGameCode()],
});
