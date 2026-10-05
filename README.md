# Cropart

A personal drawing library organized with manually assigned tags. No AI and no application server: drawings and tags stay in your browser's local storage.

## Run locally

```bash
npm install
npm run dev
```

Open the address shown in the terminal (usually http://localhost:5173).

## Use the app

- Drag drawings into the page (PNG, JPG, or WebP), or click **Add drawings**.
- Open a drawing. Drag a rectangle to tag a specific area, or leave the image unselected to tag the whole drawing.
- Search for a tag or click one of the tags above the grid to find matching drawings and regions.
- Use **Hide tags** in the viewer to inspect the artwork without tag boxes. This only hides the overlays; it does not remove or change saved tags. Click **Show tags** to display them again.
- Switch between light and dark mode with the theme button.

## Data and privacy

Drawings and tags are stored in IndexedDB in the browser. There are no accounts, backend, or synchronization, so each browser has its own library. Clearing this site's browser data may erase the library; keep the original image files somewhere safe.

## Deploy to GitHub Pages

This project can be hosted for free as a static site:

1. Create a GitHub repository (for example, `cropart`).
2. Add **the contents of this folder** to the repository root and push them to the `main` branch.
3. Under **Settings → Pages**, choose **GitHub Actions** as the deployment source.
4. On every push to `main`, the workflow in `.github/workflows/deploy.yml` checks and builds the project, then publishes the `dist` folder.

The base path for GitHub Pages is detected automatically during the build. User drawings and tags are not uploaded to GitHub; they remain in the local browser storage of each person using the site.

## Tech stack

Vite, Svelte, TypeScript, and Dexie/IndexedDB. Build with `npm run build`; check types and Svelte components with `npm run check`.
