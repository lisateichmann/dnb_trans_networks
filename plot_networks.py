"""Plot prepared network JSONs: community counts vs parameters, centrality distributions, and greedy dendrograms.

Run after `prepare_data.py` has generated JSON files in `data/`.

Example:
    python plot_networks.py --output-dir plots
"""
from __future__ import annotations

import argparse
from pathlib import Path
from typing import Dict, List

import json
import csv

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from matplotlib.lines import Line2D

try:  # Optional dependency for dendrogram visualization
    from scipy.cluster.hierarchy import dendrogram, linkage
    from scipy.spatial.distance import squareform
except Exception:  # pragma: no cover - SciPy may be unavailable
    dendrogram = linkage = squareform = None

THIS_DIR = Path(__file__).resolve().parent
DATA_DIR = THIS_DIR / "data"

GRAPH_FILES = {
    "author_author": DATA_DIR / "author_author_graph.json",
    "author_language": DATA_DIR / "author_language_graph.json",
    "language_language": DATA_DIR / "language_language_graph.json",
}


def _load_graph(path: Path) -> Dict:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def _summarize_communities(graph: Dict, graph_name: str) -> Dict[str, int]:
    """Return mapping algorithm -> number of communities from meta.

    For graphs without communities (e.g. bipartite/language graphs), this is empty.
    """
    meta = graph.get("meta", {})
    communities = meta.get("communities") or {}
    summary = {}
    for alg, count in communities.items():
        try:
            summary[str(alg)] = int(count)
        except Exception:
            continue
    if summary:
        print(f"[{graph_name}] communities:")
        for alg, count in sorted(summary.items()):
            print(f"  - {alg}: {count} communities")
    else:
        print(f"[{graph_name}] no community metadata available")
    return summary


def _plot_language_greedy_dendrogram(
    graph: Dict,
    output_dir: Path,
    graph_name: str = "language_language",
) -> None:
    """Plot a dendrogram of languages colored by greedy community assignments."""

    if linkage is None or dendrogram is None or squareform is None:
        print(f"[{graph_name}] SciPy not available - skipping dendrogram visualization")
        return

    nodes = [node for node in graph.get("nodes", []) if node.get("type") == "language"]
    communities = {
        node.get("id"): (node.get("communities") or {}).get("greedy")
        for node in nodes
    }
    valid_nodes = [node_id for node_id, community in communities.items() if community is not None]
    if len(valid_nodes) < 2:
        print(f"[{graph_name}] Not enough nodes with greedy communities to plot dendrogram")
        return

    node_index = {node_id: idx for idx, node_id in enumerate(valid_nodes)}
    links = graph.get("links", [])
    if not links:
        print(f"[{graph_name}] No edges available for dendrogram computation")
        return

    max_weight = max((float(link.get("weight", 0) or 0) for link in links), default=0.0)
    if max_weight <= 0:
        print(f"[{graph_name}] Edge weights missing - skipping dendrogram visualization")
        return

    fill_value = max_weight + 1.0
    n = len(valid_nodes)
    distance_matrix = np.full((n, n), fill_value, dtype=float)
    np.fill_diagonal(distance_matrix, 0.0)

    for link in links:
        source = link.get("source")
        target = link.get("target")
        if source not in node_index or target not in node_index:
            continue
        weight = float(link.get("weight", 0) or 0)
        dist = max(fill_value - weight, 0.0)
        i, j = node_index[source], node_index[target]
        if dist < distance_matrix[i, j]:
            distance_matrix[i, j] = distance_matrix[j, i] = dist

    condensed = squareform(distance_matrix)
    linkage_matrix = linkage(condensed, method="average")

    plot_dir = output_dir / "dendrograms"
    plot_dir.mkdir(parents=True, exist_ok=True)
    out_path = plot_dir / f"{graph_name}_greedy_dendrogram.png"

    fig_height = max(6, 0.25 * len(valid_nodes))
    fig, ax = plt.subplots(figsize=(9, fig_height))
    dendrogram(
        linkage_matrix,
        labels=valid_nodes,
        orientation="right",
        ax=ax,
        color_threshold=0,
        above_threshold_color="black",
    )
    ax.set_title("Language-language greedy communities dendrogram")
    ax.set_xlabel("distance (inverse shared author weight)")

    # Color tick labels by community assignment for quick visual grouping.
    unique_comms = sorted({c for c in communities.values() if c is not None})
    if unique_comms:
        cmap = plt.get_cmap("tab20")
        color_lookup = {
            community: cmap(idx % cmap.N)
            for idx, community in enumerate(unique_comms)
        }
        for label in ax.get_ymajorticklabels():
            node_id = label.get_text()
            community_id = communities.get(node_id)
            if community_id is not None:
                label.set_color(color_lookup.get(community_id, "black"))

        legend_handles = [
            Line2D(
                [0],
                [0],
                marker="o",
                color="none",
                markerfacecolor=color_lookup[community],
                label=f"greedy community {community}",
            )
            for community in unique_comms
        ]
        ax.legend(handles=legend_handles, loc="lower right", fontsize="small")

    fig.tight_layout()
    fig.savefig(out_path, dpi=200)
    plt.close(fig)
    print(f"[{graph_name}] Saved greedy dendrogram: {out_path}")


def _collect_centrality(graph: Dict, metric: str) -> List[float]:
    """Collect centrality values for a given metric across all nodes."""
    values: List[float] = []
    for node in graph.get("nodes", []):
        cent = node.get("centrality") or {}
        if metric in cent and cent[metric] is not None:
            try:
                values.append(float(cent[metric]))
            except Exception:
                continue
    return values


def _collect_node_metric(graph: Dict, field: str) -> List[float]:
    """Collect a scalar node attribute (e.g., centralizationScore) across nodes."""
    values: List[float] = []
    for node in graph.get("nodes", []):
        if field in node and node[field] is not None:
            try:
                values.append(float(node[field]))
            except Exception:
                continue
    return values


def _plot_histograms(
    data: Dict[str, Dict[str, List[float]]],
    output_dir: Path,
    bins: int = 30,
    *,
    value_label: str = "centrality value",
    title_suffix: str = "centrality",
) -> None:
    """Create histograms for each graph/metric pair and save them as PNGs."""
    output_dir.mkdir(parents=True, exist_ok=True)

    for graph_name, metrics in data.items():
        for metric, values in metrics.items():
            if not values:
                continue
            arr = np.asarray(values, dtype=float)
            fig, ax = plt.subplots(figsize=(6, 4))
            ax.hist(arr, bins=bins, color="steelblue", edgecolor="black", alpha=0.8)
            ax.set_title(f"{graph_name}: {metric} {title_suffix}")
            ax.set_xlabel(value_label)
            ax.set_ylabel("frequency")
            ax.grid(True, linestyle=":", alpha=0.4)

            safe_metric = metric.replace("/", "_")
            out_path = output_dir / f"{graph_name}_{title_suffix}_{safe_metric}.png"
            fig.tight_layout()
            fig.savefig(out_path, dpi=200)
            plt.close(fig)
            print(f"Saved histogram: {out_path}")


def _plot_community_distributions(graphs: Dict[str, Dict], output_dir: Path) -> None:
    """Plot distribution of authors per language community and languages per language community."""
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # Plot authors per language community (from author-author graph)
    author_graph = graphs.get("author_author")
    if author_graph:
        language_communities = []
        for node in author_graph.get("nodes", []):
            lang_comm = node.get("languageCommunity", -1)
            # Accept any non-negative int or any non-empty string
            if isinstance(lang_comm, int) and lang_comm >= 0:
                language_communities.append(str(lang_comm))
            elif isinstance(lang_comm, str) and lang_comm:
                language_communities.append(lang_comm)
        if language_communities:
            # Count all unique community labels (including multi-community)
            from collections import Counter
            comm_counter = Counter(language_communities)
            unique_comms = list(comm_counter.keys())
            counts = list(comm_counter.values())
            fig, ax = plt.subplots(figsize=(10, 5))
            ax.bar(unique_comms, counts, color="steelblue", edgecolor="black", alpha=0.8)
            ax.set_title("Distribution of Authors per Language Community")
            ax.set_xlabel("Language Community")
            ax.set_ylabel("Number of Authors")
            ax.grid(True, linestyle=":", alpha=0.4, axis='y')
            # Add value labels on top of bars
            for i, (comm, count) in enumerate(zip(unique_comms, counts)):
                ax.text(i, count, str(count), ha='center', va='bottom')
            ax.set_xticks(range(len(unique_comms)))
            ax.set_xticklabels(unique_comms, rotation=45, ha='right')
            out_path = output_dir / "authors_per_language_community.png"
            fig.tight_layout()
            fig.savefig(out_path, dpi=200)
            plt.close(fig)
            print(f"Saved authors per language community distribution: {out_path}")
    
    # Plot languages per language community (from language-language graph)
    language_graph = graphs.get("language_language")
    if language_graph:
        communities = []
        for node in language_graph.get("nodes", []):
            comm_dict = node.get("communities", {})
            greedy_comm = comm_dict.get("greedy", -1)
            if greedy_comm >= 0:
                communities.append(greedy_comm)
        
        if communities:
            unique_comms, counts = np.unique(communities, return_counts=True)
            fig, ax = plt.subplots(figsize=(8, 5))
            ax.bar(unique_comms, counts, color="darkorange", edgecolor="black", alpha=0.8)
            ax.set_title("Distribution of Languages per Language Community")
            ax.set_xlabel("Language Community")
            ax.set_ylabel("Number of Languages")
            ax.grid(True, linestyle=":", alpha=0.4, axis='y')
            
            # Add value labels on top of bars
            for comm, count in zip(unique_comms, counts):
                ax.text(comm, count, str(count), ha='center', va='bottom')
            
            out_path = output_dir / "languages_per_language_community.png"
            fig.tight_layout()
            fig.savefig(out_path, dpi=200)
            plt.close(fig)
            print(f"Saved languages per language community distribution: {out_path}")


def _convert_csv_to_markdown(data_dir: Path, output_dir: Path) -> None:
    """Convert CSV files to markdown tables and save them."""
    csv_files = list(data_dir.glob("*.csv"))
    
    print(f"Searching for CSV files in: {data_dir}")
    print(f"Found {len(csv_files)} CSV files: {[f.name for f in csv_files]}")
    
    if not csv_files:
        print(f"No CSV files found in {data_dir}")
        return
    
    # Create tables directory
    tables_dir = output_dir / "tables"
    tables_dir.mkdir(parents=True, exist_ok=True)
    print(f"Output directory: {tables_dir}\n")
    
    for csv_file in sorted(csv_files):
        try:
            print(f"Processing {csv_file.name}...")
            df = pd.read_csv(csv_file)
            
            # Create markdown filename
            md_filename = csv_file.stem + ".md"
            md_path = tables_dir / md_filename
            
            # Build markdown content
            md_content = []
            md_content.append(f"# {csv_file.stem.replace('_', ' ').title()}\n")
            md_content.append(f"**Source:** `{csv_file.name}`  ")
            md_content.append(f"**Shape:** {df.shape[0]} rows × {df.shape[1]} columns\n")
            
            # Convert dataframe to markdown table
            md_content.append("## Data\n")
            md_content.append(df.to_markdown(index=False))
            md_content.append("\n")
            
            # Add summary statistics for numeric columns
            numeric_cols = df.select_dtypes(include=[np.number]).columns
            if len(numeric_cols) > 0:
                md_content.append("## Summary Statistics\n")
                stats_df = df[numeric_cols].describe()
                md_content.append(stats_df.to_markdown())
                md_content.append("\n")
            
            # Write to file
            md_path.write_text("\n".join(md_content), encoding="utf-8")
            print(f"Converted {csv_file.name} to markdown: {md_path}")
            
        except Exception as e:
            print(f"Error converting {csv_file.name}: {e}")
            continue


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Analyze prepared network JSONs: report number of communities, plot centrality "
            "distributions, and visualize the language-language greedy dendrogram."
        )
    )
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=DATA_DIR,
        help="Directory containing *_graph.json files (default: %(default)s)",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=THIS_DIR / "plots",
        help="Directory to save histogram PNGs (default: %(default)s)",
    )
    parser.add_argument(
        "--centrality-metrics",
        type=str,
        default="degree,closeness,betweenness,eigenvector",
        help=(
            "Comma-separated centrality metrics to visualize. "
            "Must match those computed in prepare_data.py."
        ),
    )
    parser.add_argument(
        "--bins",
        type=int,
        default=30,
        help="Number of bins for histograms (default: %(default)s)",
    )
    parser.add_argument(
        "--convert-csv-to-markdown",
        action="store_true",
        help="Convert CSV files to markdown tables in plots/tables directory",
    )

    args = parser.parse_args()

    # Resolve graph file paths based on --data-dir
    graph_paths = {
        name: args.data_dir / path.name for name, path in GRAPH_FILES.items()
    }

    centrality_data: Dict[str, Dict[str, List[float]]] = {}
    centralization_data: Dict[str, Dict[str, List[float]]] = {}
    graphs: Dict[str, Dict] = {}

    for graph_name, path in graph_paths.items():
        if not path.exists():
            print(f"[{graph_name}] missing file: {path} (skipping)")
            continue
        graph = _load_graph(path)
        graphs[graph_name] = graph

        # 1) Summarize communities, when available
        community_summary = _summarize_communities(graph, graph_name)
        if graph_name == "language_language" and community_summary.get("greedy"):
            _plot_language_greedy_dendrogram(graph, args.output_dir, graph_name)

        # 2) Collect centrality values for requested metrics
        meta_metrics = set(graph.get("meta", {}).get("centralityMetrics", []))

        raw_metrics = [m.strip().lower() for m in args.centrality_metrics.split(",") if m.strip()]
        if raw_metrics:
            use_metrics = [m for m in raw_metrics if (not meta_metrics) or (m in meta_metrics)]
        else:
            use_metrics = sorted(meta_metrics)

        graph_centrality: Dict[str, List[float]] = {}
        for metric in use_metrics:
            vals = _collect_centrality(graph, metric)
            if vals:
                graph_centrality[metric] = vals
                print(
                    f"[{graph_name}] collected {len(vals)} values for centrality metric '{metric}'"
                )
        if graph_centrality:
            centrality_data[graph_name] = graph_centrality

        # 3) Collect author-level centralization scores for tier calibration
        if graph_name == "author_author":
            fields = {
                "centralizationScore": "centralization score",
                "centralizationScoreNormalized": "centralization score normalized",
            }
            field_values: Dict[str, List[float]] = {}
            for field, label in fields.items():
                vals = _collect_node_metric(graph, field)
                if vals:
                    field_values[field] = vals
                    print(
                        f"[author_author] collected {len(vals)} values for '{field}' ({label})"
                    )
            if field_values:
                centralization_data[graph_name] = field_values

    # Plot histograms for all collected centrality data
    if centrality_data:
        _plot_histograms(centrality_data, args.output_dir, bins=args.bins)
    else:
        print("No centrality data found in graphs; nothing to plot.")

    if centralization_data:
        centralization_dir = args.output_dir / "centralization"
        _plot_histograms(
            centralization_data,
            centralization_dir,
            bins=args.bins,
            value_label="score",
            title_suffix="centralization",
        )
    else:
        print("No centralization scores found; skipping distribution plots.")
    
    # Plot community distributions
    if graphs:
        _plot_community_distributions(graphs, args.output_dir)
    
    # Convert CSV files to markdown tables if requested
    if args.convert_csv_to_markdown:
        extracted_dir = args.data_dir.parent / "extracted"
        _convert_csv_to_markdown(extracted_dir, args.output_dir)


if __name__ == "__main__":
    main()
