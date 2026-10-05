import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

// GitHub Pages sert les projets de dépôt sous /nom-du-depot/.
// En local et sur un dépôt utilisateur <utilisateur>.github.io, la base est /.
const repository = process.env.GITHUB_REPOSITORY?.split('/')[1]
const base =
  process.env.GITHUB_ACTIONS === 'true' && repository && !repository.endsWith('.github.io')
    ? `/${repository}/`
    : '/'

export default defineConfig({
  base,
  plugins: [svelte()],
})
