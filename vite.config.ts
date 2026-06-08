import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
//
// `base` is the public path the site is served from. For GitHub Pages, the
// project site lives at https://<user>.github.io/<repo>/ so every asset URL
// (JS, CSS, /data/*.json fetches) needs the /<repo>/ prefix injected.
//
// The deploy workflow (.github/workflows/deploy.yml) sets BASE_PATH to the
// matching value before running `npm run build`. Locally `npm run dev` and
// `npm run build` fall back to '/' which is what you want for vite dev
// server + previewing a local prod build.
const base = process.env.BASE_PATH || '/'

export default defineConfig({
  plugins: [react()],
  base,
})
