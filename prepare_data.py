"""Build weighted translation networks from visualizations/d3/data.csv."""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from itertools import combinations
from pathlib import Path
from time import perf_counter
from typing import Any, Dict, Iterable, List, Tuple, Set

import pandas as pd
import networkx as nx
from networkx.algorithms.community import louvain_communities, greedy_modularity_communities

try:
    import igraph as ig
    import leidenalg
except ImportError:  # pragma: no cover - optional dependency
    ig = None
    leidenalg = None

try:
    from infomap import Infomap
except ImportError:  # pragma: no cover - optional dependency
    Infomap = None

DEFAULT_COMMUNITY_ALGORITHMS = ("louvain", "leiden", "infomap")
CENTRALITY_METRICS = ("degree", "closeness", "betweenness", "eigenvector", "languagecentral")
GRAPH_TARGETS = ("author-language", "author-author", "language-language")


DATA_CSV = Path(__file__).resolve().parent / "data.csv"
OUTPUT_DIR = Path(__file__).resolve().parent / "data"


def _log_progress(message: str) -> None:
    print(f"[prepare_data] {message}")


def _as_int(value: Any) -> int:
    """Return a plain Python int for pandas/numpy scalar inputs."""
    if hasattr(value, "item"):
        try:
            return int(value.item())
        except Exception:
            pass
    return int(value)


def _load_records(csv_path: Path) -> pd.DataFrame:
    """Load CSV, drop incomplete rows, and trim author/language strings."""
    df = pd.read_csv(csv_path)
    df = df.dropna(subset=["author", "language"])
    df["author"] = df["author"].str.strip()
    df["language"] = df["language"].str.strip()
    return df


def _merge_existing_graph_data(author_graph: Dict, existing_path: Path) -> None:
    """Merge persisted community/centrality metadata into the new graph (works for any node type)."""
    if not existing_path.exists():
        return
    try:
        existing = json.loads(existing_path.read_text())
    except Exception as exc:  # pragma: no cover - file may be partially written
        _log_progress(f"Unable to reuse existing centrality data: {exc}")
        return

    existing_nodes = {
        (node.get("id") or node.get("label")): node
        for node in existing.get("nodes", [])
        if node.get("id") or node.get("label")
    }
    if not existing_nodes:
        return

    combined_metrics = set(author_graph.get("meta", {}).get("centralityMetrics", []))
    combined_metrics.update(existing.get("meta", {}).get("centralityMetrics", []))
    combined_algorithms = []
    for source in (author_graph.get("meta", {}), existing.get("meta", {})):
        for alg in source.get("communityAlgorithms", []) or []:
            if alg not in combined_algorithms:
                combined_algorithms.append(alg)

    for node in author_graph.get("nodes", []):
        node_id = node.get("id") or node.get("label")
        if not node_id:
            continue
        old_node = existing_nodes.get(node_id)
        if not old_node:
            continue
        old_centrality = old_node.get("centrality") or {}
        old_tiers = old_node.get("centralityTier") or {}
        old_communities = old_node.get("communities") or {}
        if not old_centrality and not old_communities:
            continue
        node.setdefault("centrality", {})
        node.setdefault("centralityTier", {})
        node.setdefault("communities", {})
        for metric, value in old_centrality.items():
            if metric not in node["centrality"]:
                node["centrality"][metric] = value
                if metric in old_tiers:
                    node["centralityTier"][metric] = old_tiers[metric]
        for alg, assignment in old_communities.items():
            node["communities"].setdefault(alg, assignment)

    author_graph.setdefault("meta", {})
    author_graph["meta"]["centralityMetrics"] = sorted(combined_metrics)
    if combined_algorithms:
        author_graph["meta"]["communityAlgorithms"] = combined_algorithms


def _author_language_counts(df: pd.DataFrame) -> pd.DataFrame:
    """Return edge list grouped by author/language with integer weights."""
    return (
        df.groupby(["author", "language"], as_index=False)
        .size()
        .rename(columns={"size": "weight"})
    )


def _author_stats(counts: pd.DataFrame) -> pd.DataFrame:
    """Aggregate total translations + language diversity per author."""
    return (
        counts.groupby("author")
        .agg(totalWeight=("weight", "sum"), languageCount=("language", "nunique"))
    )


def _language_stats(counts: pd.DataFrame) -> pd.DataFrame:
    """Aggregate total translations + author diversity per language."""
    return (
        counts.groupby("language")
        .agg(totalWeight=("weight", "sum"), authorCount=("author", "nunique"))
    )


def _author_language_breakdown(counts: pd.DataFrame) -> Dict[str, Dict[str, int]]:
    """Map author → {language: weight} for tooltip payloads."""
    breakdown: Dict[str, Dict[str, int]] = defaultdict(dict)
    for row in counts.itertuples(index=False):
        author = str(row.author)
        language = str(row.language)
        breakdown[author][language] = _as_int(row.weight)
    return breakdown


def _language_popularity_ratios(language_stats: pd.DataFrame) -> Dict[str, float]:
    """Return language → popularity ratio (share of all translations)."""
    total_translations = float(language_stats["totalWeight"].sum())
    if total_translations <= 0:
        return {lang: 0.0 for lang in language_stats.index}
    ratios: Dict[str, float] = {}
    for lang in language_stats.index:
        total_weight = float(_as_int(language_stats.loc[lang, "totalWeight"]))
        ratios[str(lang)] = total_weight / total_translations
    return ratios


def _compute_author_centralization(
    breakdown: Dict[str, Dict[str, int]],
    language_ratios: Dict[str, float],
) -> Tuple[Dict[str, float], Dict[str, float]]:
    """Compute weighted + normalized centralization score per author."""
    weighted_scores: Dict[str, float] = {}
    normalized_scores: Dict[str, float] = {}
    for author, langs in breakdown.items():
        weighted_sum = 0.0
        weight_total = 0.0
        for lang, weight in langs.items():
            lang_ratio = language_ratios.get(lang, 0.0)
            weighted_sum += (lang_ratio * 100.0) * float(weight)
            weight_total += float(weight)
        weighted_scores[author] = weighted_sum
        normalized_scores[author] = weighted_sum / weight_total if weight_total > 0 else 0.0
    return weighted_scores, normalized_scores


def _filter_top(index: Iterable[str], stats: pd.DataFrame, limit: int | None) -> List[str]:
    """Return sorted top-N keys by totalWeight (or all if limit<=0)."""
    if not limit or limit <= 0 or limit >= len(stats):
        return list(index)
    return (
        stats.sort_values("totalWeight", ascending=False)
        .head(limit)
        .index.tolist()
    )


def _parse_algorithms(
    raw_value: str | None,
    *,
    valid_options: Iterable[str] | None = None,
) -> List[str]:
    """Parse CLI string into ordered algorithm list, handling 'none' and missing flags."""
    options = list(valid_options or DEFAULT_COMMUNITY_ALGORITHMS)
    if raw_value is None:
        return []
    values = [part.strip().lower() for part in raw_value.split(",") if part.strip()]
    if not values:
        return []
    if any(value == "none" for value in values):
        return []
    sanitized = [val for val in values if val in options]
    return sanitized


def _parse_centrality_metrics(raw_value: str | None) -> List[str]:
    """Parse CLI string into requested centrality metrics, honoring 'none'."""
    if raw_value is None:
        return []
    values = [part.strip().lower() for part in raw_value.split(",") if part.strip()]
    if not values:
        return []
    if any(value == "none" for value in values):
        # Same pattern as community parsing: "none" short-circuits to no metrics.
        return []
    sanitized = [val for val in values if val in CENTRALITY_METRICS]
    return sanitized


def _parse_targets(raw_value: str | None) -> Set[str]:
    """Parse comma-separated graph targets (author-language, author-author, language-language)."""
    if raw_value is None:
        return set()
    values = {part.strip().lower() for part in raw_value.split(",") if part.strip()}
    if not values:
        return set()
    if "all" in values:
        return set(GRAPH_TARGETS)
    return {value for value in values if value in GRAPH_TARGETS}


def _graph_logger(graph_label: str):
    return lambda message: _log_progress(f"[{graph_label}] {message}")


def _nx_to_igraph(graph: nx.Graph):
    """Convert a NetworkX graph into igraph plus a node index mapping."""
    if ig is None:
        return None, None
    nodes = list(graph.nodes())
    node_index = {node: idx for idx, node in enumerate(nodes)}
    g = ig.Graph()
    g.add_vertices(len(nodes))
    g.vs["name"] = nodes
    edges = [(node_index[u], node_index[v]) for u, v in graph.edges()]
    g.add_edges(edges)
    g.es["weight"] = [graph.edges[u, v].get("weight", 1) for u, v in graph.edges()]
    return g, node_index


def _run_leiden(graph: nx.Graph) -> Dict[str, int]:
    """Run Leiden via igraph, returning node→community id mapping."""
    if ig is None or leidenalg is None:
        return {}
    g, node_index = _nx_to_igraph(graph)
    if g is None:
        return {}
    partition = leidenalg.find_partition(
        g,
        leidenalg.RBConfigurationVertexPartition,
        weights=g.es["weight"],
    )
    assignments = {}
    for community_id, community in enumerate(partition):
        for vertex_idx in community:
            name = g.vs[vertex_idx]["name"]
            assignments[name] = community_id
    return assignments


def _run_infomap(graph: nx.Graph) -> Dict[str, int]:
    """Run Infomap if available, returning node→module id mapping."""
    if Infomap is None:
        return {}
    if graph.number_of_edges() == 0:
        return {}

    node_ids = {node: idx + 1 for idx, node in enumerate(graph.nodes())}
    id_to_node = {idx: node for node, idx in node_ids.items()}

    im = Infomap("--two-level --silent")
    for u, v, data in graph.edges(data=True):
        weight = data.get("weight", 1)
        im.addLink(node_ids[u], node_ids[v], weight)

    im.run()

    assignments = {}
    for node in im.nodes:
        name = id_to_node.get(node.node_id)
        if name is not None:
            assignments[name] = node.module_id
    return assignments


def _compute_centrality_scores(
    graph: nx.Graph,
    metrics: Iterable[str] | None = None,
    log_func=_log_progress,
) -> Dict[str, Dict[str, float]]:
    """Compute requested centrality metrics, returning metric→{node: score}."""
    metrics = list(metrics or CENTRALITY_METRICS)
    if graph.number_of_nodes() == 0 or graph.number_of_edges() == 0:
        log_func("Centrality skipped (graph too small)")
        return {}

    log_func(f"Centrality metrics requested: {', '.join(metrics)}")
    scores: Dict[str, Dict[str, float]] = {}

    for metric in metrics:
        start = perf_counter()
        if metric == "degree":
            scores[metric] = nx.degree_centrality(graph)
        elif metric == "betweenness":
            scores[metric] = nx.betweenness_centrality(graph, weight="weight", normalized=True)
        elif metric == "closeness":
            distance_graph = graph.copy()
            for _, _, data in distance_graph.edges(data=True):
                weight = data.get("weight", 1) or 1
                data["distance"] = 1.0 / float(weight)
            scores[metric] = nx.closeness_centrality(distance_graph, distance="distance")
        elif metric == "eigenvector":
            try:
                scores[metric] = nx.eigenvector_centrality(
                    graph,
                    max_iter=5000,
                    tol=1e-4,
                    weight="weight",
                )
            except nx.NetworkXException as exc:  # pragma: no cover - rare convergence failure
                log_func(f"Eigenvector centrality failed to converge: {exc}")
                log_func("Skipping eigenvector - try using degree or closeness instead for this network.")
                continue
        else:
            log_func(f"Unknown centrality metric '{metric}' - skipping")
            continue

        elapsed = perf_counter() - start
        log_func(f"Computed {metric} centrality in {elapsed:.2f}s")

    return scores


def _assign_centrality_tiers(centrality_scores: Dict[str, Dict[str, float]]) -> Dict[str, Dict[str, str]]:
    """Bucket each metric's scores into outer/periphery/central quantile tiers."""
    tiers: Dict[str, Dict[str, str]] = {}
    for metric, values in centrality_scores.items():
        if not values:
            continue
        series = pd.Series(values)
        lower = series.quantile(0.34)
        upper = series.quantile(0.67)
        metric_tiers: Dict[str, str] = {}
        for node, score in values.items():
            if score >= upper:
                metric_tiers[node] = "central"
            elif score <= lower:
                metric_tiers[node] = "outer"
            else:
                metric_tiers[node] = "periphery"
        tiers[metric] = metric_tiers
    return tiers


def _build_bipartite_graph(
    counts: pd.DataFrame,
    author_stats: pd.DataFrame,
    language_stats: pd.DataFrame,
    min_edge_weight: int,
    top_authors: int | None,
    top_languages: int | None,
    centrality_metrics: List[str] | None,
    centralization_scores: Dict[str, float] | None,
    centralization_scores_normalized: Dict[str, float] | None,
    *,
    enable_centrality: bool,
    graph_label: str = "author-language",
) -> Dict:
    """Create author↔language graph JSON (nodes+links+meta) applying filters."""
    log = _graph_logger(graph_label)
    log("Building graph topology from author-language counts…")
    # Raising min_edge_weight prunes weaker author-language links before graphing.
    edges = counts[counts["weight"] >= min_edge_weight].copy()

    author_keep = set(_filter_top(author_stats.index, author_stats, top_authors))
    language_keep = set(_filter_top(language_stats.index, language_stats, top_languages))

    # top_* == 0 keeps everyone because _filter_top returns the full index in that case.
    edges = edges[edges["author"].isin(author_keep) & edges["language"].isin(language_keep)]

    # Build NetworkX bipartite graph for centrality computation
    graph = nx.Graph()
    graph.add_nodes_from(edges["author"].unique(), bipartite=0)
    graph.add_nodes_from(edges["language"].unique(), bipartite=1)
    graph.add_weighted_edges_from(
        [(row.author, row.language, _as_int(row.weight)) for row in edges.itertuples(index=False)]
    )

    # Compute centrality for language nodes if requested
    language_centrality_scores: Dict[str, Dict[str, float]] = {}
    language_centrality_tiers: Dict[str, Dict[str, str]] = {}
    metrics = list(centrality_metrics or [])
    if enable_centrality:
        if not metrics:
            log("Skipping centrality metrics (no metrics specified for this run).")
        elif graph.number_of_edges() == 0:
            log("Skipping centrality metrics (graph has no edges).")
        else:
            log("Computing centrality metrics for language nodes…")
            language_centrality_scores = _compute_centrality_scores(graph, metrics, log_func=log)
            if language_centrality_scores:
                log("Language centrality metrics ready: " + ", ".join(sorted(language_centrality_scores.keys())))
            language_centrality_tiers = _assign_centrality_tiers(language_centrality_scores)
    else:
        log("Skipping centrality metrics (graph not targeted).")

    nodes = []
    seen_authors = set(edges["author"].unique())
    for author in seen_authors:
        stats = author_stats.loc[author]
        nodes.append(
            {
                "id": author,
                "label": author,
                "type": "author",
                "totalWeight": _as_int(stats["totalWeight"]),
                "languageCount": _as_int(stats["languageCount"]),
                "centralizationScore": float((centralization_scores or {}).get(author, 0.0)),
                "centralizationScoreNormalized": float(
                    (centralization_scores_normalized or {}).get(author, 0.0)
                ),
            }
        )

    seen_languages = set(edges["language"].unique())
    for lang in seen_languages:
        stats = language_stats.loc[lang]
        node_data = {
            "id": lang,
            "label": lang,
            "type": "language",
            "totalWeight": _as_int(stats["totalWeight"]),
            "authorCount": _as_int(stats["authorCount"]),
        }
        # Add centrality data if computed
        if language_centrality_scores:
            node_data["centrality"] = {
                metric: value
                for metric, value in (
                    (metric, language_centrality_scores.get(metric, {}).get(lang))
                    for metric in language_centrality_scores.keys()
                )
                if value is not None
            }
            node_data["centralityTier"] = {
                metric: tier
                for metric, tier in (
                    (metric, language_centrality_tiers.get(metric, {}).get(lang))
                    for metric in language_centrality_tiers.keys()
                )
                if tier is not None
            }
        nodes.append(node_data)

    links = [
        {"source": row.author, "target": row.language, "weight": _as_int(row.weight)}
        for row in edges.itertuples(index=False)
    ]

    result = {
        "meta": {
            "minEdgeWeight": min_edge_weight,
            "topAuthors": top_authors,
            "topLanguages": top_languages,
            "edgeCount": len(links),
            "nodeCount": len(nodes),
            "centralityMetrics": sorted(language_centrality_scores.keys()) if language_centrality_scores else [],
        },
        "nodes": nodes,
        "links": links,
    }
    log(f"Graph ready with {len(nodes)} nodes and {len(links)} edges.")
    return result


def _build_author_author_graph(
    counts: pd.DataFrame,
    author_stats: pd.DataFrame,
    author_language_breakdown: Dict[str, Dict[str, int]],
    min_edge_weight: int,
    community_algorithms: List[str],
    centrality_metrics: List[str] | None,
    centralization_scores: Dict[str, float] | None,
    centralization_scores_normalized: Dict[str, float] | None,
    language_popularity: Dict[str, float] | None,
    *,
    enable_communities: bool,
    enable_centrality: bool,
    graph_label: str = "author-author",
) -> Dict:
    """Return author↔author graph JSON including optional community/centrality data."""
    log = _graph_logger(graph_label)
    log("Deriving author overlap weights…")
    language_overlap_weights: Dict[Tuple[str, str], int] = defaultdict(int)
    translation_overlap_weights: Dict[Tuple[str, str], int] = defaultdict(int)

    for _, group in counts.groupby("language"):
        rows = list(group[["author", "weight"]].itertuples(index=False, name="LangRow"))
        for row_a, row_b in combinations(rows, 2):
            author_a = str(row_a.author)
            author_b = str(row_b.author)
            key = (author_a, author_b) if author_a <= author_b else (author_b, author_a)
            # Track how many destination languages they share.
            language_overlap_weights[key] += 1
            # Approximate shared translations via the overlapping volume for that language.
            shared_translations = min(_as_int(row_a.weight), _as_int(row_b.weight))
            translation_overlap_weights[key] += shared_translations

    edge_list = []
    for (a, b), language_weight in language_overlap_weights.items():
        if language_weight < min_edge_weight:
            continue
        edge_list.append(
            {
                "source": a,
                "target": b,
                "weight": language_weight,
                "sharedLanguageCount": language_weight,
                "sharedTranslationCount": translation_overlap_weights.get((a, b), 0),
            }
        )

    seen_authors = {edge["source"] for edge in edge_list} | {
        edge["target"] for edge in edge_list
    }
    graph = nx.Graph()
    graph.add_nodes_from(seen_authors)
    graph.add_weighted_edges_from(
        [(edge["source"], edge["target"], edge["weight"]) for edge in edge_list]
    )

    communities_summary: Dict[str, List[List[str]]] = {}
    community_assignments: Dict[str, Dict[str, int]] = {}
    centrality_scores: Dict[str, Dict[str, float]] = {}
    centrality_tiers: Dict[str, Dict[str, str]] = {}

    if graph.number_of_edges() > 0 and graph.number_of_nodes() > 0:
        if enable_communities:
            if not community_algorithms:
                log("Skipping community detection (no algorithms specified).")
            else:
                if "louvain" in community_algorithms:
                    log("Running Louvain community detection…")
                    start = perf_counter()
                    louvain_parts = louvain_communities(graph, weight="weight")
                    elapsed = perf_counter() - start
                    communities_summary["louvain"] = [sorted(list(c)) for c in louvain_parts]
                    community_assignments["louvain"] = {}
                    for idx, community_nodes in enumerate(louvain_parts):
                        for node in community_nodes:
                            community_assignments["louvain"][node] = idx
                    log(f"Louvain detected {len(louvain_parts)} communities in {elapsed:.2f}s")

                if "leiden" in community_algorithms:
                    log("Running Leiden community detection…")
                    start = perf_counter()
                    leiden_map = _run_leiden(graph)
                    elapsed = perf_counter() - start
                    if leiden_map:
                        community_assignments["leiden"] = leiden_map
                        summary: Dict[int, List[str]] = defaultdict(list)
                        for node, community_id in leiden_map.items():
                            summary[community_id].append(node)
                        communities_summary["leiden"] = [sorted(nodes) for nodes in summary.values()]
                        log(f"Leiden detected {len(summary)} communities in {elapsed:.2f}s")
                    else:
                        log("Leiden community detection returned no assignments.")

                if "infomap" in community_algorithms:
                    log("Running Infomap community detection…")
                    start = perf_counter()
                    infomap_map = _run_infomap(graph)
                    elapsed = perf_counter() - start
                    if infomap_map:
                        community_assignments["infomap"] = infomap_map
                        summary: Dict[int, List[str]] = defaultdict(list)
                        for node, community_id in infomap_map.items():
                            summary[community_id].append(node)
                        communities_summary["infomap"] = [sorted(nodes) for nodes in summary.values()]
                        log(f"Infomap detected {len(summary)} communities in {elapsed:.2f}s")
                    else:
                        log("Infomap community detection returned no assignments.")
        else:
            log("Skipping community detection (graph not targeted).")

        requested_metrics = list(centrality_metrics or [])
        custom_language_metric = "languagecentral" in requested_metrics
        metrics = [metric for metric in requested_metrics if metric != "languagecentral"]
        if enable_centrality:
            if not metrics and not custom_language_metric:
                log("Skipping centrality metrics (no metrics specified).")
            else:
                if metrics:
                    log("Computing centrality metrics for author-author graph…")
                    centrality_scores = _compute_centrality_scores(graph, metrics, log_func=log)
                    if centrality_scores:
                        log("Centrality metrics ready: " + ", ".join(sorted(centrality_scores.keys())))
                else:
                    log("No standard centrality metrics requested (languageCentral only).")
                if custom_language_metric:
                    log("Injecting languageCentral metric from percentage-weighted language mixes…")
                    lc_scores = {
                        author: float((centralization_scores or {}).get(author, 0.0))
                        for author in seen_authors
                    }
                    centrality_scores["languagecentral"] = lc_scores
                if centrality_scores:
                    centrality_tiers = _assign_centrality_tiers(centrality_scores)
                    if centrality_tiers:
                        log(
                            "Centrality tiers assigned for metrics: "
                            + ", ".join(sorted(centrality_tiers.keys()))
                        )
        else:
            log("Skipping centrality metrics (graph not targeted).")
    else:
        # Graphs with zero edges cannot produce communities/centrality; keep metadata empty.
        communities_summary = {alg: [] for alg in community_algorithms}
        centrality_scores = {}
        centrality_tiers = {}
        log("Skipping community and centrality metrics (graph too small).")

    for alg in community_algorithms:
        communities_summary.setdefault(alg, [])
        community_assignments.setdefault(alg, {})

    nodes = []
    for author in sorted(seen_authors):
        lang_breakdown = author_language_breakdown.get(author, {})
        languages = [
            {"language": lang, "weight": weight}
            for lang, weight in sorted(
                lang_breakdown.items(), key=lambda item: item[1], reverse=True
            )
        ]
        nodes.append(
            {
                "id": author,
                "label": author,
                "type": "author",
                "totalWeight": _as_int(author_stats.loc[author, "totalWeight"]),
                "languageCount": _as_int(author_stats.loc[author, "languageCount"]),
                "centralizationScore": float((centralization_scores or {}).get(author, 0.0)),
                "centralizationScoreNormalized": float(
                    (centralization_scores_normalized or {}).get(author, 0.0)
                ),
                "communities": {
                    alg: community_assignments.get(alg, {}).get(author, -1)
                    for alg in community_algorithms
                },
                "languages": languages,
                "centrality": {
                    metric: value
                    for metric, value in (
                        (metric, centrality_scores.get(metric, {}).get(author))
                        for metric in centrality_scores.keys()
                    )
                    if value is not None
                },
                "centralityTier": {
                    metric: tier
                    for metric, tier in (
                        (metric, centrality_tiers.get(metric, {}).get(author))
                        for metric in centrality_tiers.keys()
                    )
                    if tier is not None
                },
            }
        )

    meta: Dict[str, Any] = {
        "minEdgeWeight": min_edge_weight,
        "edgeCount": len(edge_list),
        "nodeCount": len(nodes),
        "communities": {
            alg: len(groups)
            for alg, groups in communities_summary.items()
        },
        "communityAlgorithms": community_algorithms,
        "centralityMetrics": sorted(centrality_scores.keys()),
    }
    if language_popularity:
        meta["languagePopularity"] = {
            "ratios": language_popularity,
            "languageCount": len(language_popularity),
        }

    result = {
        "meta": meta,
        "nodes": nodes,
        "links": edge_list,
    }
    log(f"Graph ready with {len(nodes)} nodes and {len(edge_list)} edges.")
    return result


def _build_language_language_graph(
    counts: pd.DataFrame,
    language_stats: pd.DataFrame,
    min_edge_weight: int,
    centrality_metrics: List[str] | None,
    community_algorithms: List[str] | None,
    *,
    enable_communities: bool,
    enable_centrality: bool,
    graph_label: str = "language-language",
) -> Dict:
    """Create language↔language graph JSON derived from shared authors.

    In addition to centrality metrics, this graph also includes a community
    assignment computed with NetworkX's greedy modularity maximization
    algorithm ("greedy" in the exported JSON).
    """
    log = _graph_logger(graph_label)
    log("Deriving language overlap counts…")
    edges: Dict[Tuple[str, str], set[str]] = defaultdict(set)
    for author, group in counts.groupby("author"):
        languages = sorted(group["language"].unique())
        for lang_a, lang_b in combinations(languages, 2):
            key = tuple(sorted((lang_a, lang_b)))
            edges[key].add(str(author))

    edge_list = []
    for (a, b), authors in edges.items():
        weight = len(authors)
        if weight >= min_edge_weight:
            edge_list.append({"source": a, "target": b, "weight": weight})

    seen_languages = {edge["source"] for edge in edge_list} | {
        edge["target"] for edge in edge_list
    }

    # Build NetworkX graph for centrality & community computation
    graph = nx.Graph()
    graph.add_nodes_from(seen_languages)
    graph.add_weighted_edges_from(
        [(edge["source"], edge["target"], edge["weight"]) for edge in edge_list]
    )

    # Compute community detection for language-language graph (controlled by CLI)
    communities_summary: Dict[str, List[List[str]]] = {}
    community_assignments: Dict[str, Dict[str, int]] = {}
    language_community_algorithms = [
        alg for alg in (community_algorithms or []) if alg == "greedy"
    ]
    if graph.number_of_edges() > 0 and graph.number_of_nodes() > 0 and enable_communities:
        if "greedy" in language_community_algorithms:
            log("Running greedy modularity community detection for language-language graph…")
            start = perf_counter()
            greedy_parts = greedy_modularity_communities(graph, weight="weight")
            elapsed = perf_counter() - start
            communities_summary["greedy"] = [sorted(list(c)) for c in greedy_parts]
            community_assignments["greedy"] = {}
            for idx, community_nodes in enumerate(greedy_parts):
                for node in community_nodes:
                    community_assignments["greedy"][node] = idx
            log(f"Greedy modularity detected {len(greedy_parts)} communities in {elapsed:.2f}s")
        elif language_community_algorithms:
            log("Skipping language-language community detection (unsupported algorithm requested).")
        else:
            log("Skipping language-language community detection (no algorithms specified).")
    else:
        if graph.number_of_edges() == 0 or graph.number_of_nodes() == 0:
            log("Skipping language-language community detection (graph too small).")
        elif not enable_communities:
            log("Skipping language-language community detection (graph not targeted).")
        else:
            log("Skipping language-language community detection (no algorithms specified).")
        communities_summary["greedy"] = []
        community_assignments["greedy"] = {}

    # Compute centrality metrics if requested
    centrality_scores: Dict[str, Dict[str, float]] = {}
    centrality_tiers: Dict[str, Dict[str, str]] = {}
    metrics = list(centrality_metrics or [])
    if enable_centrality and metrics and graph.number_of_edges() > 0 and graph.number_of_nodes() > 0:
        log("Computing centrality metrics for language-language graph…")
        centrality_scores = _compute_centrality_scores(graph, metrics, log_func=log)
        if centrality_scores:
            log("Language-language centrality metrics ready: " + ", ".join(sorted(centrality_scores.keys())))
        centrality_tiers = _assign_centrality_tiers(centrality_scores)
        if centrality_tiers:
            log("Centrality tiers assigned for metrics: " + ", ".join(sorted(centrality_tiers.keys())))
    elif enable_centrality and not metrics:
        log("Skipping language-language centrality metrics (no metrics specified).")
    elif enable_centrality:
        log("Skipping language-language centrality metrics (graph too small).")
    else:
        log("Skipping language-language centrality metrics (graph not targeted).")

    nodes = []
    for lang in sorted(seen_languages):
        node_data = {
            "id": lang,
            "label": lang,
            "type": "language",
            "totalWeight": _as_int(language_stats.loc[lang, "totalWeight"]),
            "authorCount": _as_int(language_stats.loc[lang, "authorCount"]),
        }
        if language_community_algorithms:
            node_data["communities"] = {
                "greedy": community_assignments.get("greedy", {}).get(lang, -1)
            }
        # Add centrality data if computed
        if centrality_scores:
            node_data["centrality"] = {
                metric: value
                for metric, value in (
                    (metric, centrality_scores.get(metric, {}).get(lang))
                    for metric in centrality_scores.keys()
                )
                if value is not None
            }
            node_data["centralityTier"] = {
                metric: tier
                for metric, tier in (
                    (metric, centrality_tiers.get(metric, {}).get(lang))
                    for metric in centrality_tiers.keys()
                )
                if tier is not None
            }
        nodes.append(node_data)

    meta: Dict[str, Any] = {
        "minEdgeWeight": min_edge_weight,
        "edgeCount": len(edge_list),
        "nodeCount": len(nodes),
        "centralityMetrics": sorted(centrality_scores.keys()) if centrality_scores else [],
    }
    if language_community_algorithms:
        meta["communityAlgorithms"] = language_community_algorithms
        meta["communities"] = {
            alg: len(groups)
            for alg, groups in communities_summary.items()
        }

    result = {
        "meta": meta,
        "nodes": nodes,
        "links": edge_list,
    }
    log(f"Graph ready with {len(nodes)} nodes and {len(edge_list)} edges.")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare JSON networks for D3 views.")
    parser.add_argument(
        "--input-csv",
        type=Path,
        default=DATA_CSV,
        help="Path to the cleaned CSV export (default: %(default)s).",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=OUTPUT_DIR,
        help="Directory for the generated JSON files (default: %(default)s).",
    )
    parser.add_argument(
        "--min-author-language-weight",
        type=int,
        default=0,
        help="Minimum translations to keep an author→language edge (0 keeps all, default: %(default)s).",
    )
    parser.add_argument(
        "--min-author-author-weight",
        type=int,
        default=1,
        help="Minimum shared-language count to keep an author↔author edge (default: %(default)s).",
    )
    parser.add_argument(
        "--min-language-language-weight",
        type=int,
        default=0,
        help="Minimum shared-author weight to keep a language↔language edge (0 keeps all, default: %(default)s).",
    )
    parser.add_argument(
        "--top-authors",
        type=int,
        default=0,
        help="Limit to the most translated authors (0 keeps all, default: %(default)s).",
    )
    parser.add_argument(
        "--top-languages",
        type=int,
        default=0,
        help="Limit to the most translated target languages (0 keeps all, default: %(default)s).",
    )
    parser.add_argument(
        "--community-algorithms",
        type=str,
        default=None,
        help="Comma-separated community algorithms (louvain, leiden, infomap); omit or use 'none' to skip.",
    )
    parser.add_argument(
        "--language-community-algorithms",
        type=str,
        default=None,
        help=(
            "Comma-separated community algorithms for the language-language graph "
            "(currently supported: greedy) or 'none' (default)."
        ),
    )
    parser.add_argument(
        "--centrality-metrics",
        type=str,
        default=None,
        help=(
            "Comma-separated centrality metrics (degree, closeness, betweenness, eigenvector, "
            "languageCentral[author-author only]); omit to skip."
        ),
    )
    parser.add_argument(
        "--centrality-targets",
        type=str,
        default=None,
        help=(
            "Graphs that should receive centrality metrics (author-language, author-author, language-language, "
            "or 'all')."
        ),
    )
    parser.add_argument(
        "--community-targets",
        type=str,
        default=None,
        help=(
            "Graphs that should receive community detection (author-language, author-author, language-language, "
            "or 'all')."
        ),
    )

    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    _log_progress(f"Loading records from {args.input_csv}…")
    records = _load_records(args.input_csv)
    _log_progress(f"Loaded {len(records):,} translation rows after cleaning.")
    counts = _author_language_counts(records)
    _log_progress(f"Computed {len(counts):,} author-language pairs.")

    ## TODO: Language-Language graph: edge weight = number of shared authors
    ## TODO: Check out https://networkx.org/documentation/stable/reference/algorithms/generated/networkx.algorithms.community.modularity_max.greedy_modularity_communities.html
    author_stats = _author_stats(counts)
    language_stats = _language_stats(counts)
    author_language_breakdown = _author_language_breakdown(counts)
    language_popularity = _language_popularity_ratios(language_stats)
    centralization_scores, centralization_scores_normalized = _compute_author_centralization(
        author_language_breakdown,
        language_popularity,
    )
    _log_progress(f"Computed centralization scores for {len(centralization_scores):,} authors.")
    community_algorithms = _parse_algorithms(args.community_algorithms)
    language_community_algorithms = _parse_algorithms(
        args.language_community_algorithms,
        valid_options=("greedy",),
    )
    centrality_metrics = _parse_centrality_metrics(args.centrality_metrics)
    centrality_targets = _parse_targets(args.centrality_targets)
    community_targets = _parse_targets(args.community_targets)
    unsupported_community_targets = {target for target in community_targets if target == "author-language"}
    if unsupported_community_targets:
        _log_progress(
            "Community detection is not available for the author-language graph; ignoring that target."
        )
        community_targets -= unsupported_community_targets

    author_language_centrality = "author-language" in centrality_targets
    author_author_centrality = "author-author" in centrality_targets
    language_language_centrality = "language-language" in centrality_targets

    author_author_communities = "author-author" in community_targets
    language_language_communities = "language-language" in community_targets

    metrics_without_custom = [metric for metric in centrality_metrics if metric != "languagecentral"]

    bipartite = _build_bipartite_graph(
        counts,
        author_stats,
        language_stats,
        min_edge_weight=args.min_author_language_weight,
        top_authors=args.top_authors,
        top_languages=args.top_languages,
        centrality_metrics=metrics_without_custom,
        centralization_scores=centralization_scores,
        centralization_scores_normalized=centralization_scores_normalized,
        enable_centrality=author_language_centrality,
        graph_label="author-language",
    )

    author_graph = _build_author_author_graph(
        counts,
        author_stats,
        author_language_breakdown,
        min_edge_weight=args.min_author_author_weight,
        community_algorithms=community_algorithms,
        centrality_metrics=centrality_metrics,
        centralization_scores=centralization_scores,
        centralization_scores_normalized=centralization_scores_normalized,
        language_popularity=language_popularity,
        enable_communities=author_author_communities,
        enable_centrality=author_author_centrality,
        graph_label="author-author",
    )

    language_graph = _build_language_language_graph(
        counts,
        language_stats,
        min_edge_weight=args.min_language_language_weight,
        centrality_metrics=metrics_without_custom,
        community_algorithms=language_community_algorithms,
        enable_communities=language_language_communities,
        enable_centrality=language_language_centrality,
        graph_label="language-language",
    )

    author_lang_path = args.output_dir / "author_language_graph.json"
    author_author_path = args.output_dir / "author_author_graph.json"
    language_lang_path = args.output_dir / "language_language_graph.json"

    # Merge existing centrality data for all three graphs
    _merge_existing_graph_data(bipartite, author_lang_path)
    _merge_existing_graph_data(author_graph, author_author_path)
    _merge_existing_graph_data(language_graph, language_lang_path)

    author_lang_path.write_text(json.dumps(bipartite, indent=2))
    author_author_path.write_text(json.dumps(author_graph, indent=2))
    language_lang_path.write_text(json.dumps(language_graph, indent=2))

    _log_progress(f"Wrote {author_lang_path}")
    _log_progress(f"Wrote {author_author_path}")
    _log_progress(f"Wrote {language_lang_path}")


if __name__ == "__main__":
    main()
