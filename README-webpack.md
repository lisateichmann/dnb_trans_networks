# DNB Trans Networks – Webpack Setup

## Quick Start

1. **Install dependencies:**
   ```sh
   npm install
   ```
2. **Start the dev server:**
   ```sh
   npm start
   ```
   This will open the app at http://localhost:8080

3. **Build for production:**
   ```sh
   npm run build
   ```
   Output will be in the `dist/` folder.

## Notes
- Entry point: `src/app.js` (via `src/index.js`)
- All static assets in `data/`, `extracted/`, and `plots/` are copied to `dist/`.
- `index.html` and `src/styles.css` are bundled automatically.
- You can import CSS in JS: `import './styles.css';`
- D3 is loaded via CDN in `index.html` (or you can `npm install d3` and import if you want).

---

If you want to use D3 as an npm package, run:
```sh
npm install d3
```
And replace the CDN script in `index.html` with `import * as d3 from 'd3';` in your JS files.
