import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

// GitHub Pages serves project repositories from /repository-name/.
// Local builds and <user>.github.io repositories use /.
const repository = process.env.GITHUB_REPOSITORY?.split('/')[1]
const base =
  process.env.GITHUB_ACTIONS === 'true' && repository && !repository.endsWith('.github.io')
    ? `/${repository}/`
    : '/'

export default defineConfig({
  base,
  plugins: [svelte()],
})
