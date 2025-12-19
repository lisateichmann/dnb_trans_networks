# DNB Translation Networks

A network analysis and interactive visualization project exploring German fiction translation patterns using data from the German National Library (Deutsche Nationalbibliothek).

## Project Overview

This project analyzes the translation networks of German literature by examining relationships between authors, languages, and their translation patterns. It constructs three interconnected network representations:

1. **Author-Language Network** (bipartite): Maps authors to the languages their works have been translated into
2. **Author-Author Network** (unimodal): Connects authors who share common translation languages, revealing communities and influence patterns
3. **Language-Language Network**: Links languages that share translated authors, showing translation corridors and flows

The analysis pipeline combines Python-based network construction and analysis with an interactive D3.js visualization that allows exploration of author communities, centrality metrics, and language popularity patterns through a rich web-based interface.

## Project Structure

```
├── data.csv                          # Source translation data
├── prepare_data.py                   # Network construction and analysis
├── analyze_networks.py               # Statistical analysis and plotting
├── index.html                        # Main visualization interface
├── main.js                          # Visualization orchestration
├── requirements.txt                  # Python dependencies
├── data/                            # Generated network JSON files
│   ├── author_author_graph.json
│   ├── author_language_graph.json
│   └── language_language_graph.json
├── plots/                           # Analysis outputs
│   ├── centralization/             # Centrality distributions
│   └── dendrograms/                # Community structure plots
└── src/                            # Visualization modules
    ├── app.js                      # Main application logic
    ├── authorAuthor.js             # Author network visualization
    ├── authorLanguage.js           # Bipartite visualization
    ├── languageLanguage.js         # Language network visualization
    ├── styles.css                  # Styling
    └── utils.js                    # Shared utilities
```

## Workflow

The project has two main phases:

1. **Data Preparation**: Convert CSV translation data into network JSON files with optional community detection and centrality metrics (`prepare_data.py`)
2. **Interactive Visualization**: Explore the networks through a web-based D3.js interface (`index.html`)

## 1. Prepare the data

The script expects the cleaned CSV files already present under `Network Analysis/`.

### Quick start

```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python prepare_data.py --top-languages 40 --top-authors 200
```

`prepare_data.py` only runs the heavy analytics (community detection + centrality metrics) when you ask for them, so incremental runs can focus on a single measure without recomputing everything. Re-running with different options merges the new metrics/communities into the existing `author_author_graph.json` instead of overwriting previous results.

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
| `--community-algorithms` | Comma list of `louvain`, `leiden`, `infomap` for the author-author graph. Omit or pass `none` to skip. | _not set_ (skip) |
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

## 2. Launch the visualizations

Use any static web server so the browser can load the JSON files via `fetch`. A simple option with Python:

```bash
cd /path/to/dnb_trans_networks
python -m http.server 8000
```

Then navigate to http://localhost:8000/ in your browser.

## Interactive Visualization Features

The web-based visualization focuses on the **Author Communities & Centrality Rings** network, featuring a concentric ring layout where authors are positioned based on their centrality within the translation ecosystem.

### Layout & Visual Encoding

- **Concentric Rings**: Authors are arranged in three adaptive tiers (Core, Periphery, Outer Periphery) based on normalized centralization scores—typically the top 15% occupy the Core, with breakpoints displayed in the histogram
- **Community Colors**: Authors are color-coded by detected community (Louvain, Leiden, or Infomap algorithms)
- **Node Size**: Encodes total translation count for each author
- **Edge Thickness**: Represents connection strength based on shared translation languages
- **Spatial Layout**: Within each community sector, authors are sorted by score and positioned with collision-avoidance

### Interactive Controls

**Language Popularity Chart** — Horizontal scrollable bar chart showing translation distribution across languages; click bars to filter authors by language (Ctrl+click for multiple); hover for precise percentages

**Edge Weight Histogram** — Brushable histogram for filtering connections by strength; drag to select weight ranges; active range displayed below

**Centralization Score Window** — Brushable histogram of author centralization scores; filter by network hierarchy position; shows tier breakpoints and statistics

**Author Search** — Type-ahead search with real-time suggestions in the network header; instantly highlights matching authors

**Community Filter Panel** — Sticky side panel listing communities with dominant languages; select communities to filter the canvas; only shows edges where both endpoints share a translated language

**Toggle Options:**
- Show/hide edges between authors to focus on spatial layout
- Use translation totals to modulate node opacity (more translations = more opaque)
- Show only shared connections between selected authors

**Filter Status Bar** — Displays all active filters with a "Clear All" button for quick reset

**Selection & Navigation** — Click nodes to focus on immediate neighbors; pan/zoom with mouse gestures; clear selection button (⟲) to reset; warped-force layout runs in static mode for immediate display

The interface dynamically updates all visualizations as you interact, providing immediate feedback without page reloads. Language popularity ratios are recomputed from `data.csv` on load.

## Statistical Analysis

The `analyze_networks.py` script provides additional analytical capabilities:

```bash
python analyze_networks.py --output-dir plots
```

Generates:
- **Community parameter analysis**: Plots community counts vs. parameter settings
- **Centrality distributions**: Visualizes metric distributions across the network  
- **Dendrograms**: Hierarchical clustering visualizations for greedy community detection

Output saved to `plots/centralization/` and `plots/dendrograms/`.

## Future Enhancements

- Greedy community detection for languages with dendrogram visualization
- Chord diagram showing language-language translation "flow"
- Quick-preset buttons (e.g., "Top 50 authors by degree")
- Modified chord diagram with German as central "source" language

## TODO:
- [ ] We want to compute the greedy community detection for languages and visualize it as a dendogram 
> The language communities serve as a selection / filtration mechanism for the centralization visualization.   
> Selecting one or multiple communities filters the author-author network to those authors and keeps only edges where both endpoints share at least one translated language.   
> Author nodes remain color-coded by community; multi-community authors inherit whichever assignment is active in the JSON metadata.   
> Author node size still encodes the weighted translation totals.   


- [ ] If time maybe some cool features like the following
> Cool buttons to have that match figures - clicking these automatically sets some configuration and updates the visualization to show that state   
> Top 50 authors (by degree)

- [ ] Double check how the dendogram is drawn - 2 v 6 splits or something



## Technical Details

**Data Format** — Three JSON network files containing nodes with metadata (communities, centrality metrics, language breakdowns), edges with weights (shared language/translation counts), and graph-level metadata (popularity ratios, statistics)

**Dependencies:**
- Python: pandas, networkx, igraph, leidenalg, infomap, matplotlib, scipy
- JavaScript: D3.js v7
- **Note**: `infomap` not compatible with Windows

**Browser Compatibility** — Modern browsers with ES6 module and SVG support

> _Screenshot placeholder: Wide shot of the cluster dashboard showing histograms, language bars, and toggles._

The warped-force layout runs in static mode by default so you see the final rings immediately, but you can still pan or zoom without restarting the simulation.

The **cluster view** now has a dashboard of scented controls that steer the canvas without reloading the page:

- A horizontal language popularity chart (scrollable when there are many languages) doubles as a filter—click or Ctrl+click bars to focus the graph on specific translation destinations. Only languages still present after the data filters are shown.
- Edge-weight and centralization histograms support brushing, letting you drag out the value windows instead of juggling numeric inputs; active ranges are displayed below each chart.
- Author search moved into the network header, so every term immediately highlights matches and surfaces suggestions without crowding the main control stack.
- A new “Show edges between authors” toggle hides links entirely when you want to focus on spatial layout, while the “Only show connections shared by selected authors” option further constrains link drawing to overlaps across the active selection.

Those ratios are still recomputed directly from `data.csv` on load by counting every language occurrence and normalizing by the total, and hovering the bars reveals precise percentages for the most common target languages. A sticky side panel lists each detected author community with its dominant translation languages; selecting one or more communities filters the canvas so only authors from those groups remain, and only edges where both endpoints share at least one translated language stay visible.

> _Screenshot placeholder: Author similarity canvas with enlarged rings, fixed legend, and header search._

> _Screenshot placeholder: Cluster language filter side panel showing community cards and dominant languages._

The concentric rings are driven by `centralizationScoreNormalized`, but instead of hard-coded thresholds they adapt to the current dataset: the script samples the distribution, places roughly the top 15 % of authors in the **Core**, the middle tranche in the **Periphery**, and everyone below the lower quantile in the **Outer periphery**. (Exact breakpoints are shown above the histogram each time the view loads.) Within each community sector, authors are sorted by their score (higher = closer to the center) and then nudged slightly by a collision-avoidance pass to keep overlaps manageable.


