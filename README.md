# Crop

A personal drawing library organized with manually assigned tags. No AI and no application server: drawings and tags stay in your browser's local storage.

## Run locally

```bash
npm install
npm run dev
```

Open the address shown in the terminal (usually http://localhost:5173).

## Use the app

- Drag drawings into the page (PNG, JPG, or WebP), or click **Add**.
- Use the folder menu to create, rename, delete, and switch folders. Deleting a folder leaves its drawings in the unfiled collection.
- Select several drawings to move them together. Use **Arrange drawings** and the arrow buttons to reorder them on touch screens; drag cards to swap their positions on desktop.
- Open a drawing. Drag a rectangle to tag a specific area, or leave the image unselected to tag the whole drawing.
- Open the **Tags** menu below a drawing to choose which tags appear on it. Same-name tags are grouped and can be toggled together.
- Search for a tag or choose one from the **Tags** menu to find matching drawings and regions.
- Use **Backup** to download a local ZIP archive of drawings, folders, and tags. **Restore** merges a backup into the current library. Keep the archive somewhere safe; it is not uploaded or synced.
- Deleting a drawing offers an **Undo** action for a few seconds.
- Duplicate filenames show their import date and a short ID so they can be told apart.
- Switch between light and dark mode with the theme button.

## Data and privacy

Drawings and tags are stored in IndexedDB in the browser. There are no accounts, backend, or synchronization, so each browser has its own library. Clearing this site's browser data may erase the library; keep the original image files somewhere safe.

## Deploy to GitHub Pages

This project can be hosted for free as a static site:

1. Create a GitHub repository (for example, `crop`).
2. Add **the contents of this folder** to the repository root.
3. Push the project to the `main` branch.
4. Under **Settings → Pages**, choose **GitHub Actions** as the deployment source.
5. The workflow in `.github/workflows/deploy.yml` builds and publishes the site on each push to `main`. Check the **Actions** tab for the deployment status and URL.

The base path for GitHub Pages is detected automatically during the build. User drawings and tags are not uploaded to GitHub; they remain in the local browser storage of each person using the site.

## Tech stack

Vite, Svelte, TypeScript, and Dexie/IndexedDB. Build with `npm run build`; check types and Svelte components with `npm run check`.
