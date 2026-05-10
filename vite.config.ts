import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// https://vite.dev/config/
export default defineConfig({
  build: {
    copyPublicDir: false,
  },
  plugins: [react(), viteSingleFile({ removeViteModuleLoader: true })],
})
