# DNB Translation Networks

A network analysis and interactive visualization project exploring the transfer routes and canons of German fiction in translation (translated fiction originally published in German) using bibliographic data from the German National Library (Deutsche Nationalbibliothek, DNB).

# DNB Translation Networks

The interactive web application with visualizations can be accessed here: https://lisateichmann.github.io/dnb_trans_networks/

## Data source

The dataset was derived from the German National Library and published here: https://doi.org/10.7910/DVN/LJFLL9
If you re-use any of the data please cite: Teichmann, Lisa (2025) ‘The “Mapping German Fiction in Translation” Dataset: Data Collection, Scope, and Data Quality’, Journal of Cultural Analytics, 10/1, https://doi.org/10.22148/001c.128010.


## Project Overview

This project analyzes the transfer networks of German literature in translation by examining relationships between authors and languages. It constructs three interconnected network representations:

1. **Author-Language Network** (bipartite): Maps authors to the languages their works have been translated into
2. **Author-Author Network** (unimodal): Connects authors who share common translation languages, revealing central authors in the DNB's collection
3. **Language-Language Network**: Links languages that share translated authors, showing relations between target languages


The analysis pipeline combines Python-based network construction and analysis with:
- **Interactive D3.js visualization**: Explore author communities, centrality, and language flows in a rich web UI.
- **Tabular and Markdown exports**: Scripts generate CSV and Markdown tables for reproducible analysis and reporting.

## Project Structure

```
├── data.csv                          # Source translation data, author names and target languages, one line represents one translated title
├── prepare_data.py                   # Network construction and analysis
├── analyze_networks.py               # Statistical analysis and plotting
├── extract_csv.py                    # Export CSVs from network JSONs for tabular analysis
├── plot_networks.py                  # Generates plots and Markdown tables from network data
├── index.html                        # Main visualization interface
├── main.js                           # Visualization orchestration
├── requirements.txt                  # Python dependencies
├── data/                             # Generated network JSON files
│   ├── author_author_graph.json
│   ├── author_language_graph.json
│   └── language_language_graph.json
├── extracted/                        # CSVs exported from JSONs (for tables/analysis)
│   ├── author_edges_all_communities.csv
│   ├── author_edges_community_0.csv
│   ├── author_edges_community_1_2.csv
│   ├── language_edges.csv
│   └── language_nodes.csv
├── plots/                            # Analysis outputs
│   ├── centralization/               # Centrality distributions
│   ├── dendrograms/                  # Community structure plots
│   └── tables/                       # Markdown tables generated from CSVs
│       ├── author_edges_all_communities.md
│       ├── author_edges_community_0.md
│       ├── author_edges_community_1_2.md
│       ├── language_edges.md
│       └── language_nodes.md
└── src/                              # Visualization modules & build system
	├── index.js                      # Main entry point (Webpack)
	├── app.js                        # Main application logic
	├── authorAuthor.js               # Author network visualization
	├── authorLanguage.js             # Bipartite visualization
	├── languageLanguage.js           # Language network visualization
	├── styles.css                    # Styling
	├── utils.js                      # Shared utilities
	├── webpack.config.js             # Webpack config (dev server & build)
	├── package.json                  # JS dependencies & scripts
	└── dist/                         # Production build output (after `npm run build`)
```


## Workflow

The project workflow consists of:

1. **Data Preparation**: Convert CSV translation data into network JSON files with optional community detection and centrality metrics (`prepare_data.py`).
2. **Export CSVs**: Use `extract_csv.py` to export author/language edge and node tables from the JSONs for further analysis or reporting.
3. **Statistical Analysis & Markdown Tables**: Run `plot_networks.py` to generate centrality/community plots and Markdown tables from the exported CSVs.
4. **Interactive Visualization**: Explore the networks and all analytics through a web-based D3.js interface (`index.html`).


## 1. Prepare the data

The script expects the cleaned CSV files already present in the project root.

### Quick start

```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python prepare_data.py --top-languages 40 --top-authors 200
```

`prepare_data.py` only runs the heavy analytics (community detection + centrality metrics) when you ask for them, so incremental runs can focus on a single measure without recomputing everything. Re-running with different options merges the new metrics/communities into the existing `author_author_graph.json` instead of overwriting previous results.

## 2. Export CSVs for tabular analysis

Run:

```bash
python extract_csv.py
```

This generates CSVs in `extracted/` for author/language edges and nodes, split by community as needed.

## 3. Generate plots and Markdown tables

Run:

```bash
python plot_networks.py --output-dir plots --convert-csv-to-markdown
```

This creates:
- Centrality and community distribution plots in `plots/centralization/` and `plots/dendrograms/`
- Markdown tables for each CSV in `plots/tables/` (with summary statistics)

### Key arguments

| Flag | Description | Default |
| --- | --- | --- |
| `--input-csv` | Path to the cleaned CSV export. | `visualizations/d3/data.csv` |
| `--output-dir` | Destination folder for the three JSON files. | `visualizations/d3/data/` |
| `--min-author-language-weight` | Minimum translations to keep an author→language edge (`0` keeps all). | `0` |
| `--min-author-author-weight` | Minimum shared-language count to keep an author↔author edge. | `1` |
| `--min-language-language-weight` | Minimum shared-author weight to keep a language↔language edge (`0` keeps all). | `0` |
| `--top-authors` | Cap on most translated authors (`0` keeps all). | `0` |
| `--top-languages` | Cap on destination languages (`0` keeps all). | `0` |
| `--community-algorithms` | Comma list of `louvain`, `leiden`, `infomap`, `greedy` for the author-author graph. Omit or pass `none` to skip. | _not set_ (skip) |
| `--language-community-algorithms` | Currently only `greedy` for the language-language graph. Omit/`none` to skip. | _not set_ (skip) |
| `--community-targets` | Graphs that should run their community algorithms (`author-language`, `author-author`, `language-language`, `all`). | _not set_ (skip all) |
| `--centrality-metrics` | Comma list of `degree`, `closeness`, `betweenness`, `eigenvector`, `languageCentral`. Omit/`none` to skip. (`languageCentral` only applies to the author↔author graph.) | _not set_ (skip) |
| `--centrality-targets` | Graphs that should receive centrality metrics (`author-language`, `author-author`, `language-language`, `all`). | _not set_ (skip all) |
Targeting works in two steps: first declare which metrics/algorithms you want, then list the graphs that should receive them. For example, the following command only computes degree/closeness centrality for the author-author graph and runs Louvain plus greedy language communities, leaving the other charts untouched:

```bash
python prepare_data.py \
	--centrality-metrics degree,closeness \
	--centrality-targets author-author \
	--community-algorithms louvain \
	--community-targets author-author,language-language \
	--language-community-algorithms greedy
```

The custom `languageCentral` metric exposes each author's percentage-weighted destination mix:

$$
	{score}(a) = \sum_{\ell \in L_a} \big(p_\ell \times 100\big) \cdot t_{a,\ell}
$$

We iterate over every author $a$ in the author set $A$ produced by `prepare_data.py` and store `extscore(a)` as part of the node metadata.

Where:

- $L_a$ – set of languages that author $a$ has been translated into (after enforcing `--min-author-language-weight`).
- $p_\ell$ – `popularity_ratio` for language $\ell$, i.e., the share of total translations in `data.csv` that target $\ell$ once duplicates and low-weight entries are filtered out.
- $t_{a,\ell}$ – count (or weighted sum, if you pass non-integer weights) of author $a$'s translations into language $\ell$.

The popularity ratio is computed as

$$
p_\ell = \frac{\sum_{a \in A} t_{a,\ell}}{\sum_{\ell' \in L} \sum_{a \in A} t_{a,\ell'}}
$$

where $L$ is the set of all retained languages. During each `prepare_data.py` run the script recomputes these ratios by counting every translation event that passes the configured thresholds, dividing by the grand total, and storing the normalized values alongside the graph metadata. That means the metric automatically respects whichever language/edge filters you apply at ingestion time. A normalized variant of the same value continues to drive the concentric-ring layout, but the centrality metric reflects the raw weighted sum so you can rank authors by how concentrated they are in globally popular target languages.

To surface the metric inside `author_author_graph.json`, include it in `--centrality-metrics` **and** target the author network, for example:

```bash
python prepare_data.py \
	--centrality-metrics languageCentral \
	--centrality-targets author-author
```

The script always recalculates the underlying language ratios and author scores, so subsequent runs can layer `languageCentral` onto an existing JSON without regenerating other metrics.

When neither the metrics/algorithms nor their corresponding `--*-targets` flags are supplied, the script skips those expensive computations entirely, reusing any previously written analytics if you only need to append new ones later. Console output now scopes every progress message with the graph being processed (e.g., `[author-author] Computing centrality metrics…`) so you can follow long runs.

All arguments are additive—you can run `python prepare_data.py --centrality-metrics degree` today, then `python prepare_data.py --centrality-metrics eigenvector` tomorrow to append that metric without touching the previously stored degree results. The console logs report which analytics were requested, how long they took, and when a section was skipped (e.g., community detection disabled).

Running the script writes three JSON files under `data/`:

- `author_language_graph.json` – bipartite author⇄language network.
- `author_author_graph.json` – unimodal author graph with Louvain communities and per-language breakdown embedded in each node. Each link now includes both `sharedLanguageCount` (how many destination languages the pair overlaps on) and `sharedTranslationCount` (the overlapping translation volume for those languages) in addition to the legacy `weight` for compatibility.
- `language_language_graph.json` – language⇄language network derived from shared authors.

Optional community detection (Leiden, Infomap) requires `igraph`, `leidenalg`, and `infomap`, all pre-listed in `requirements.txt`. If a library is missing, that algorithm is skipped automatically. **Note:** `infomap` does not work on Windows machines.



## 4. Launch the interactive visualizations (Dev & Production)

### Quick Start (JavaScript Visualization)

```bash
cd src
npm install
npm start
```

This will start a local development server (Webpack Dev Server) at http://localhost:8080/ with hot reloading. The app will be available at that address.

### Building for Production

To build a static production bundle (output to `src/dist/`):

```bash
cd src
npm run build
```

You can then serve the contents of `src/dist/` using any static web server:

```bash
cd src/dist
python -m http.server 8000
```

Navigate to http://localhost:8000/ to view the production build.

> **Note:** The dev server (`npm start`) is recommended for local development. Use the static server only for the production build.


## Interactive Visualization Features

The web-based visualization provides:

- **Concentric Rings**: Authors are arranged in three adaptive tiers (Core, Periphery, Outer Periphery) based on normalized centralization scores.
- **Community Colors**: Authors are color-coded by detected community (Louvain, Leiden, Infomap).
- **Node Size**: Encodes total translation count for each author.
- **Edge Thickness**: Represents connection strength (shared translation languages).
- **Language Popularity Bar Chart**: Click/ctrl+click to filter authors by language; hover for precise percentages.
- **Edge Weight & Centralization Histograms**: Brush to filter by connection strength or centrality tier; breakpoints and stats shown.
- **Author Search**: Type-ahead search with real-time suggestions and instant highlighting.
- **Community Filter Panel**: Select communities to filter the canvas; only shows edges where both endpoints share a translated language.
- **Chord & Radial Diagrams**: Visualize translation flows between languages and from German to targets.
- **Toggle Controls**: Show/hide edges, modulate node opacity by translation totals, restrict to shared connections.
- **Download Buttons**: Export filtered JSONs for further analysis.
- **Filter Status Bar**: Shows all active filters with a "Clear All" button.
- **Selection & Navigation**: Click nodes to focus on neighbors; pan/zoom; reset selection with ⟲.


All visualizations update dynamically as you interact—no page reloads required.

## Deploy to GitHub Pages

You can deploy the interactive visualization (including all JSON and CSV data files) to GitHub Pages using the provided workflow. This allows you to share your analysis and interactive dashboard as a static website, with all data files accessible for client-side loading.

### How it works

- The workflow in `.github/workflows/deploy-pages.yml` automatically deploys the repository to GitHub Pages on every push to the `main` branch (or when manually triggered).
- It uploads the entire repository contents (including `index.html`, all scripts, JSON, and CSV files) as a static site.
- GitHub Pages serves all files as static assets, so your D3.js app can fetch JSON and CSV files just like when running `python -m http.server` locally.

### Steps to deploy

1. **Push your changes to the `main` branch** (or trigger the workflow manually from the Actions tab).
2. The workflow will build and deploy the site to GitHub Pages automatically.
3. After deployment, your site will be available at:
	- `https://<your-username>.github.io/<your-repo>/` (for user/org pages, or with the repo name for project pages)

### Notes

- No build step is required: the workflow simply uploads your static files as-is.
- All data files in `data/`, `extracted/`, and generated plots/tables are accessible to the web app and can be fetched by D3.js.
- If you add or update data, just commit and push—GitHub Pages will serve the latest version after the workflow completes.


### Local development (legacy/static)

If you prefer, you can still serve the static files (including the production build) using:

```bash
python -m http.server 8000
```

from the appropriate directory (`src/dist` for production, or project root for legacy mode). This mimics the static file serving provided by GitHub Pages.


## Statistical Analysis & Reporting

- `analyze_networks.py` and `plot_networks.py` provide additional analytics:
	- **Community parameter analysis**: Plots community counts vs. parameter settings
	- **Centrality distributions**: Visualizes metric distributions across the network
	- **Dendrograms**: Hierarchical clustering for greedy community detection
	- **Markdown tables**: All exported CSVs are converted to Markdown with summary statistics for reproducible reporting

Outputs are saved to `plots/centralization/`, `plots/dendrograms/`, and `plots/tables/`.

## Technical Details

**Data Format** — Three JSON network files containing nodes with metadata (communities, centrality metrics, language breakdowns), edges with weights (shared language/translation counts), and graph-level metadata (popularity ratios, statistics)


**Dependencies:**
- Python: pandas, networkx, igraph, leidenalg, infomap, matplotlib, scipy, tabulate
- JavaScript: D3.js v7
- **Note**: `infomap` not compatible with Windows


**Browser Compatibility** — Modern browsers with ES6 module and SVG support


> _Screenshot placeholder: Wide shot of the cluster dashboard showing histograms, language bars, and toggles._


The warped-force layout runs in static mode by default so you see the final rings immediately, but you can still pan or zoom without restarting the simulation. All controls and filters update the view instantly.

The **cluster view** dashboard includes:
- Language popularity chart (filter by clicking bars)
- Edge-weight and centralization histograms (brush to filter)
- Author search in the header
- Toggle controls for edges, opacity, and shared connections
- Community/language filter side panel
- Download/export buttons for filtered data

All ratios and statistics are recomputed from the current data and filters. Markdown tables and plots are always up to date with the latest exports.
