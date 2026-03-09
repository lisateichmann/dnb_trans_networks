#!/usr/bin/env python3
"""network_measures.py — Structural measures for the language-language
translation co-authorship network.

Graph construction (from data.csv)
  Nodes  = target languages
  Edges  = language pairs that share ≥1 common author
  Weight = number of authors who translated into both languages

Community detection algorithms
  · Fast-greedy  — NetworkX greedy_modularity_communities (weighted)
  · Louvain      — NetworkX louvain_communities (weighted, seed=42)
  · Leiden       — leidenalg ModularityVertexPartition (weighted, seed=42)
                   [skipped with a warning if leidenalg/igraph are not installed]

Usage
  python network_measures.py [--csv path/to/data.csv] [--out network_measures.txt]

Output
  Prints all results to stdout and also writes them to network_measures.txt
  (or the path given by --out) in the project root.
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from itertools import combinations
from pathlib import Path
from time import perf_counter
from typing import Dict, List, Set, Tuple

import networkx as nx
import networkx.algorithms.community as nx_community
import pandas as pd

try:
    import igraph as ig
    import leidenalg
    _LEIDEN_AVAILABLE = True
except ImportError:
    ig = None
    leidenalg = None
    _LEIDEN_AVAILABLE = False

ROOT = Path(__file__).resolve().parent
DEFAULT_CSV = ROOT / "data.csv"
DEFAULT_JSON = ROOT / "data" / "language_language_graph.json"
DEFAULT_OUT = ROOT / "network_measures.txt"


# ─── graph construction ───────────────────────────────────────────────────────

def build_language_graph(csv_path: Path) -> nx.Graph:
    """Build undirected weighted language-language graph from the CSV.

    Edge weight between two languages = number of authors who appear in both.
    """
    df = pd.read_csv(csv_path).dropna(subset=["author", "language"])
    df["author"] = df["author"].str.strip()
    df["language"] = df["language"].str.strip()

    # Author → unique languages
    author_langs: Dict[str, Set[str]] = (
        df.groupby("author")["language"]
        .apply(lambda s: set(s.unique()))
        .to_dict()
    )

    # Accumulate shared-author sets for each language pair
    edge_authors: Dict[Tuple[str, str], set] = defaultdict(set)
    for author, langs in author_langs.items():
        for a, b in combinations(sorted(langs), 2):
            edge_authors[(a, b)].add(author)

    G = nx.Graph()
    for (a, b), authors in edge_authors.items():
        G.add_edge(a, b, weight=len(authors))

    return G


def build_language_graph_from_json(json_path: Path) -> nx.Graph:
    """Build undirected weighted language-language graph from a pre-built JSON.

    Reads the 'links' array (source, target, weight) produced by prepare_data.py.
    """
    with json_path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    G = nx.Graph()
    for link in data.get("links", []):
        G.add_edge(link["source"], link["target"], weight=int(link["weight"]))

    return G


# ─── igraph bridge (for Leiden) ───────────────────────────────────────────────

def _nx_to_igraph(G: nx.Graph):
    """Convert a NetworkX Graph to an igraph Graph."""
    nodes = list(G.nodes())
    idx = {n: i for i, n in enumerate(nodes)}
    g = ig.Graph()
    g.add_vertices(len(nodes))
    g.vs["name"] = nodes
    g.add_edges([(idx[u], idx[v]) for u, v in G.edges()])
    g.es["weight"] = [float(G.edges[u, v]["weight"]) for u, v in G.edges()]
    return g


# ─── analysis ─────────────────────────────────────────────────────────────────

def compute_measures(G: nx.Graph) -> List[str]:
    lines: List[str] = []

    SEP = "=" * 64

    def section(title: str) -> None:
        lines.extend(["", SEP, title, SEP])

    def row(label: str, value) -> None:
        lines.append(f"  {label:<44} {value}")

    # ── Basic ─────────────────────────────────────────────────────
    section("BASIC GRAPH STATISTICS")
    n = G.number_of_nodes()
    m = G.number_of_edges()
    row("Nodes", n)
    row("Edges", m)
    row("Graph density", f"{nx.density(G):.6f}")
    row("Self-loops", nx.number_of_selfloops(G))
    row("Is connected", nx.is_connected(G))
    row("Number of connected components", nx.number_connected_components(G))

    # ── Degree ─────────────────────────────────────────────────────
    section("DEGREE STATISTICS  (unweighted)")
    degrees = [d for _, d in G.degree()]
    row("Average degree", f"{sum(degrees) / len(degrees):.4f}")
    row("Min degree", min(degrees))
    row("Max degree", max(degrees))
    lines.append("")
    lines.append("  Per-node degree (sorted descending):")
    for node, deg in sorted(G.degree(), key=lambda x: -x[1]):
        lines.append(f"    {node:<14} {deg}")

    # ── Strength (weighted degree) ──────────────────────────────────
    section("STRENGTH  (weighted degree = sum of edge weights)")
    strengths = [d for _, d in G.degree(weight="weight")]
    row("Average strength", f"{sum(strengths) / len(strengths):.4f}")
    row("Min strength", min(strengths))
    row("Max strength", max(strengths))
    lines.append("")
    lines.append("  Per-node strength (sorted descending):")
    for node, w in sorted(G.degree(weight="weight"), key=lambda x: -x[1]):
        lines.append(f"    {node:<14} {w}")

    # ── Diameter & average path length ─────────────────────────────
    section("DIAMETER & AVERAGE PATH LENGTH  (unweighted, largest component)")
    Gc = G.subgraph(max(nx.connected_components(G), key=len)).copy()
    gc_nodes = Gc.number_of_nodes()
    gc_edges = Gc.number_of_edges()
    row("Largest component — nodes", gc_nodes)
    row("Largest component — edges", gc_edges)

    EXACT_THRESHOLD = 2000  # nodes; exact computation is O(V*(V+E))
    if gc_nodes <= EXACT_THRESHOLD:
        t0 = perf_counter()
        diam = nx.diameter(Gc)
        apl = nx.average_shortest_path_length(Gc)
        elapsed = perf_counter() - t0
        row("Diameter (unweighted)", diam)
        row("Average path length (unweighted)", f"{apl:.6f}")
        row("Elapsed (s)", f"{elapsed:.2f}")
    else:
        lines.append(
            f"\n  ⚑ FLAG: Exact diameter and APL are O(V*(V+E)) and may be"
            f" slow on this graph ({gc_nodes} nodes).  A sampling approximation"
            f" (1 000 BFS sources) is reported instead."
        )
        import random
        random.seed(42)
        sources = random.sample(list(Gc.nodes()), min(1000, gc_nodes))
        path_lengths: List[int] = []
        t0 = perf_counter()
        for s in sources:
            path_lengths.extend(nx.single_source_shortest_path_length(Gc, s).values())
        row("Approx. avg path length (1 000 BFS sources)", f"{sum(path_lengths)/len(path_lengths):.6f}")
        row("Elapsed (s)", f"{perf_counter()-t0:.2f}")

    # ── Clustering ─────────────────────────────────────────────────
    section("CLUSTERING COEFFICIENTS  (unweighted)")
    avg_cc = nx.average_clustering(G)
    global_cc = nx.transitivity(G)
    row("Average clustering coefficient", f"{avg_cc:.6f}")
    row("Global clustering coefficient (transitivity)", f"{global_cc:.6f}")

    # ── Community detection ────────────────────────────────────────
    section("COMMUNITY DETECTION")
    lines.append("  Edge weights used: YES  ('weight' = # shared authors)")
    lines.append("")

    # Fast-greedy
    t0 = perf_counter()
    greedy_parts = list(nx_community.greedy_modularity_communities(G, weight="weight"))
    q_greedy = nx_community.modularity(G, greedy_parts, weight="weight")
    elapsed_g = perf_counter() - t0
    lines.append("  ── Fast-greedy  (greedy_modularity_communities)")
    lines.append(f"     Communities detected : {len(greedy_parts)}")
    lines.append(f"     Modularity Q         : {q_greedy:.6f}")
    lines.append(f"     Elapsed (s)          : {elapsed_g:.2f}")
    lines.append("")

    # Louvain
    t0 = perf_counter()
    louvain_parts = list(nx_community.louvain_communities(G, weight="weight", seed=42))
    q_louvain = nx_community.modularity(G, louvain_parts, weight="weight")
    elapsed_l = perf_counter() - t0
    lines.append("  ── Louvain  (louvain_communities, seed=42)")
    lines.append(f"     Communities detected : {len(louvain_parts)}")
    lines.append(f"     Modularity Q         : {q_louvain:.6f}")
    lines.append(f"     Elapsed (s)          : {elapsed_l:.2f}")
    lines.append("")

    # Leiden
    if _LEIDEN_AVAILABLE:
        t0 = perf_counter()
        g_ig = _nx_to_igraph(G)
        partition = leidenalg.find_partition(
            g_ig,
            leidenalg.ModularityVertexPartition,
            weights="weight",
            seed=42,
        )
        q_leiden = partition.modularity
        elapsed_ld = perf_counter() - t0
        lines.append("  ── Leiden  (leidenalg ModularityVertexPartition, seed=42)")
        lines.append(f"     Communities detected : {len(partition)}")
        lines.append(f"     Modularity Q         : {q_leiden:.6f}")
        lines.append(f"     Elapsed (s)          : {elapsed_ld:.2f}")
    else:
        lines.append(
            "  ── Leiden  SKIPPED — leidenalg and/or igraph are not installed.\n"
            "     Install with:  pip install igraph leidenalg"
        )

    lines.append("")
    return lines


# ─── key-metrics extractor (for comparison table) ─────────────────────────────

def extract_key_metrics(G: nx.Graph) -> Dict:
    """Return a flat dict of the headline measures for a graph."""
    degrees = [d for _, d in G.degree()]
    Gc = G.subgraph(max(nx.connected_components(G), key=len)).copy()

    greedy_parts = list(nx_community.greedy_modularity_communities(G, weight="weight"))
    q_greedy = nx_community.modularity(G, greedy_parts, weight="weight")

    louvain_parts = list(nx_community.louvain_communities(G, weight="weight", seed=42))
    q_louvain = nx_community.modularity(G, louvain_parts, weight="weight")

    q_leiden = None
    n_leiden = None
    if _LEIDEN_AVAILABLE:
        g_ig = _nx_to_igraph(G)
        partition = leidenalg.find_partition(
            g_ig, leidenalg.ModularityVertexPartition, weights="weight", seed=42
        )
        q_leiden = partition.modularity
        n_leiden = len(partition)

    return {
        "nodes":           G.number_of_nodes(),
        "edges":           G.number_of_edges(),
        "density":         nx.density(G),
        "avg_degree":      sum(degrees) / len(degrees),
        "min_degree":      min(degrees),
        "max_degree":      max(degrees),
        "diameter":        nx.diameter(Gc),
        "avg_path_length": nx.average_shortest_path_length(Gc),
        "avg_clustering":  nx.average_clustering(G),
        "transitivity":    nx.transitivity(G),
        "q_greedy":        q_greedy,
        "n_greedy":        len(greedy_parts),
        "q_louvain":       q_louvain,
        "n_louvain":       len(louvain_parts),
        "q_leiden":        q_leiden,
        "n_leiden":        n_leiden,
    }


def format_comparison_table(csv_m: Dict, json_m: Dict) -> List[str]:
    """Format a side-by-side comparison table of metrics from two sources."""
    SEP = "=" * 64
    lines = ["", SEP, "SOURCE COMPARISON  (data.csv  vs  language_language_graph.json)", SEP]

    ROWS = [
        ("Metric",                          "CSV",       "JSON",      "Match"),
        ("─" * 34,                          "─" * 10,    "─" * 10,    "─" * 5),
        ("Nodes",                           "{nodes}",   "{nodes}",   None),
        ("Edges",                           "{edges}",   "{edges}",   None),
        ("Density",                         "{density:.6f}", "{density:.6f}", None),
        ("Avg degree",                      "{avg_degree:.4f}", "{avg_degree:.4f}", None),
        ("Min degree",                      "{min_degree}", "{min_degree}", None),
        ("Max degree",                      "{max_degree}", "{max_degree}", None),
        ("Diameter (unweighted)",           "{diameter}", "{diameter}", None),
        ("Avg path length (unweighted)",    "{avg_path_length:.6f}", "{avg_path_length:.6f}", None),
        ("Avg clustering coeff.",           "{avg_clustering:.6f}", "{avg_clustering:.6f}", None),
        ("Global clustering (transitivity)","{transitivity:.6f}", "{transitivity:.6f}", None),
        ("Fast-greedy communities",         "{n_greedy}", "{n_greedy}", None),
        ("Fast-greedy modularity Q",        "{q_greedy:.6f}", "{q_greedy:.6f}", None),
        ("Louvain communities",             "{n_louvain}", "{n_louvain}", None),
        ("Louvain modularity Q",            "{q_louvain:.6f}", "{q_louvain:.6f}", None),
        ("Leiden communities",              "{n_leiden}", "{n_leiden}", None),
        ("Leiden modularity Q",             "{q_leiden:.6f}", "{q_leiden:.6f}", None),
    ]

    col_w = [36, 12, 12, 6]

    def fmt(template: str, m: Dict) -> str:
        try:
            return template.format(**m)
        except (KeyError, TypeError, ValueError):
            return "N/A"

    for i, row in enumerate(ROWS):
        label, csv_tpl, json_tpl, _ = row
        if i < 2:
            # header / separator rows — print as-is
            lines.append(
                f"  {label:<{col_w[0]}} {csv_tpl:<{col_w[1]}} {json_tpl:<{col_w[2]}} {'':>{col_w[3]}}"
            )
            continue
        csv_val  = fmt(csv_tpl,  csv_m)
        json_val = fmt(json_tpl, json_m)
        match    = "✓" if csv_val == json_val else "✗ DIFF"
        lines.append(
            f"  {label:<{col_w[0]}} {csv_val:<{col_w[1]}} {json_val:<{col_w[2]}} {match:>{col_w[3]}}"
        )

    lines.append("")
    return lines


# ─── entry point ──────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Compute network measures for the language-language graph."
    )
    parser.add_argument(
        "--csv", type=Path, default=DEFAULT_CSV,
        help="Path to the source CSV file (default: data.csv in project root)."
    )
    parser.add_argument(
        "--json", type=Path, default=DEFAULT_JSON,
        help="Pre-built JSON graph file to cross-validate against (default: %(default)s).",
    )
    parser.add_argument(
        "--out", type=Path, default=DEFAULT_OUT,
        help="Output file path (default: network_measures.txt in project root)."
    )
    args = parser.parse_args()

    # ── Primary: build from CSV ────────────────────────────────────
    print("[network_measures] Building graph from CSV:", args.csv)
    G_csv = build_language_graph(args.csv)
    source_label = args.csv.name
    print(f"[network_measures] CSV graph — {G_csv.number_of_nodes()} nodes, "
          f"{G_csv.number_of_edges()} edges")

    header = [
        "=" * 64,
        "LANGUAGE-LANGUAGE TRANSLATION NETWORK — STRUCTURAL MEASURES",
        "=" * 64,
        f"  Graph type  : undirected weighted (NetworkX Graph)",
        f"  Data source : {source_label}",
        f"  Node type   : target language (ISO 639-2/B code)",
        f"  Edge type   : language pair sharing ≥1 common author",
        f"  Edge weight : number of shared authors",
        f"  Generated   : {pd.Timestamp.now().strftime('%Y-%m-%d %H:%M:%S')}",
    ]

    lines = header + compute_measures(G_csv)

    # ── Cross-validation: load JSON and append comparison table ───
    if args.json is not None and args.json.exists():
        print("[network_measures] Loading JSON graph for cross-validation:", args.json)
        G_json = build_language_graph_from_json(args.json)
        print(f"[network_measures] JSON graph  — {G_json.number_of_nodes()} nodes, "
              f"{G_json.number_of_edges()} edges")
        csv_m  = extract_key_metrics(G_csv)
        json_m = extract_key_metrics(G_json)
        lines += format_comparison_table(csv_m, json_m)
    else:
        print("[network_measures] No JSON file found — skipping cross-validation table.")

    output = "\n".join(lines) + "\n"

    print("\n" + output)

    args.out.write_text(output, encoding="utf-8")
    print(f"[network_measures] Results written to {args.out}")


if __name__ == "__main__":
    main()
