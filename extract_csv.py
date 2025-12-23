import json
import csv
from pathlib import Path

# Output directory
output_dir = Path('extracted')
output_dir.mkdir(exist_ok=True)

# Read the author-author graph JSON file
with open('data/author_author_graph.json', 'r', encoding='utf-8') as f:
    author_data = json.load(f)

# Build author to community mapping
author_to_community = {}
for node in author_data['nodes']:
    author_id = node['id']
    author_to_community[author_id] = node.get('languageCommunity', -1)

# Extract author edges data with community information
all_edges = []
for edge in author_data['links']:
    source = edge['source']
    target = edge['target']
    weight = edge['weight']
    source_community = author_to_community.get(source, -1)
    target_community = author_to_community.get(target, -1)
    all_edges.append({
        'source': source,
        'target': target,
        'weight': weight,
        'source_community': source_community,
        'target_community': target_community
    })

# Helper: is single community (e.g. '0', '1', '2')
def is_single_community(val, comm):
    return str(val) == str(comm)

# Helper: is bridge (either source or target has a multi-community label)
def is_bridge(source, target):
    return (isinstance(source, str) and '->' in source) or (isinstance(target, str) and '->' in target)

# 1. Authors only in community 0
community_0_edges = [
    edge for edge in all_edges
    if is_single_community(edge['source_community'], 0) and is_single_community(edge['target_community'], 0)
]

# 2. Authors only in community 1
community_1_edges = [
    edge for edge in all_edges
    if is_single_community(edge['source_community'], 1) and is_single_community(edge['target_community'], 1)
]

# 3. Authors only in community 2
community_2_edges = [
    edge for edge in all_edges
    if is_single_community(edge['source_community'], 2) and is_single_community(edge['target_community'], 2)
]

# 4. Bridge edges (either source or target is a multi-community author)
bridge_edges = [
    edge for edge in all_edges
    if is_bridge(edge['source_community'], edge['target_community'])
]

# Write CSV files
fieldnames = ['source', 'target', 'weight', 'source_community', 'target_community']

author_edges_0_path = output_dir / 'author_edges_community_0.csv'
with author_edges_0_path.open('w', newline='', encoding='utf-8') as csvfile:
    writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(community_0_edges)
print(f"Created {author_edges_0_path} with {len(community_0_edges)} edges")

author_edges_1_path = output_dir / 'author_edges_community_1.csv'
with author_edges_1_path.open('w', newline='', encoding='utf-8') as csvfile:
    writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(community_1_edges)
print(f"Created {author_edges_1_path} with {len(community_1_edges)} edges")

author_edges_2_path = output_dir / 'author_edges_community_2.csv'
with author_edges_2_path.open('w', newline='', encoding='utf-8') as csvfile:
    writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(community_2_edges)
print(f"Created {author_edges_2_path} with {len(community_2_edges)} edges")

author_edges_bridge_path = output_dir / 'author_edges_community_bridges.csv'
with author_edges_bridge_path.open('w', newline='', encoding='utf-8') as csvfile:
    writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(bridge_edges)
print(f"Created {author_edges_bridge_path} with {len(bridge_edges)} edges")