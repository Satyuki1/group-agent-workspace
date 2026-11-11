import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const primitives = fileURLToPath(new URL('../app/ui/src/primitives.js', import.meta.url))
export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom', 'react-markdown', 'remark-gfm', '@deepseek-ai/dsh-client-ui-primitives', 'qrcode-generator', 'deep-view'] },
  plugins: [{
    name: 'ds-bot-primitives',
    enforce: 'pre',
    resolveId(source, importer) {
      return (source === './dsh-primitives.js' || source.endsWith('/client/dsh-primitives.js')) && (importer?.replaceAll('\\', '/').includes('/ds-bot/src/client/') || importer?.includes('/team/web/native.jsx'))
        ? primitives : null
    },
  }],
})
