import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

/**
 * Content-Security-Policy, generated per mode because the bridge address is
 * configurable. Production gets `script-src 'self'`; development also allows
 * the inline preamble React Fast Refresh injects and Vite's HMR socket.
 *
 * `connect-src` names the bridge exactly; `img-src`/`media-src` allow only this
 * origin plus data:/blob: (decoded speech), so nothing the model writes can
 * make the page contact another host.
 */
function contentSecurityPolicy(options: { dev: boolean; bridge: string; uiPort: number }): Plugin {
  const bridgeWs = options.bridge.replace(/^http/, 'ws')
  const hmr = options.dev ? ` ws://localhost:${options.uiPort} ws://127.0.0.1:${options.uiPort}` : ''
  const policy = [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    `script-src 'self'${options.dev ? " 'unsafe-inline'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    `connect-src 'self' ${options.bridge} ${bridgeWs}${hmr}`,
  ].join('; ')
  return {
    name: 'clap-csp',
    transformIndexHtml(html) {
      return html.replace('%CLAP_CSP%', policy)
    },
  }
}

/** Anything VITE_* ships to the browser. Refuse to build if a secret is about to. */
function forbidSecretsInBundle(env: Record<string, string>): Plugin {
  return {
    name: 'clap-no-secrets',
    configResolved() {
      const leaked = Object.keys(env).filter((key) => key.startsWith('VITE_') && /(KEY|TOKEN|SECRET|PASSWORD)/i.test(key))
      if (leaked.length) {
        throw new Error(
          `Refusing to build: ${leaked.join(', ')} would be embedded in the browser bundle. ` +
            'Secrets belong in bridge variables (no VITE_ prefix).',
        )
      }
    },
  }
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const uiPort = Number(env.CLAP_UI_PORT || 5173)
  const bridge = (env.VITE_CLAP_BRIDGE_URL || `http://127.0.0.1:${env.CLAP_BRIDGE_PORT || 7719}`).replace(/\/+$/, '')

  return {
    plugins: [react(), contentSecurityPolicy({ dev: command === 'serve', bridge, uiPort }), forbidSecretsInBundle(env)],
    define: {
      __CLAP_BRIDGE_URL__: JSON.stringify(bridge),
    },
    server: {
      host: '127.0.0.1',
      port: uiPort,
      // The bridge trusts exactly this origin; a silently different port would
      // look alive and never connect.
      strictPort: true,
    },
    preview: {
      host: '127.0.0.1',
      port: uiPort,
      strictPort: true,
    },
    build: {
      target: 'es2023',
      sourcemap: true,
      // The 3D scene (three.js + postprocessing) is a lazy ~1 MB chunk loaded
      // after the HUD; warn if it, or anything else, grows past that.
      chunkSizeWarningLimit: 1100,
    },
  }
})
