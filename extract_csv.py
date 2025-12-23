import json
import csv
from pathlib import Path

# Read the language-language graph JSON file
with open('data/language_language_graph.json', 'r', encoding='utf-8') as f:
    lang_data = json.load(f)

# Extract language nodes data: language, greedy (community id), authorCount
nodes_data = []
for node in lang_data['nodes']:
    nodes_data.append({
        'language': node['id'],
        'greedy': node['communities']['greedy'],
        'authorCount': node['authorCount']
    })

# Write language nodes data to CSV
with open('language_nodes.csv', 'w', newline='', encoding='utf-8') as csvfile:
    fieldnames = ['language', 'greedy', 'authorCount']
    writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(nodes_data)

print(f"Created language_nodes.csv with {len(nodes_data)} languages")

# Extract language edges data: source language, target language, weight
edges_data = []
for edge in lang_data['links']:
    edges_data.append({
        'source_language': edge['source'],
        'target_language': edge['target'],
        'weight': edge['weight']
    })

# Write language edges data to CSV
with open('language_edges.csv', 'w', newline='', encoding='utf-8') as csvfile:
    fieldnames = ['source_language', 'target_language', 'weight']
    writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(edges_data)

print(f"Created language_edges.csv with {len(edges_data)} edges")

# Read the author-author graph JSON file
with open('data/author_author_graph.json', 'r', encoding='utf-8') as f:
    author_data = json.load(f)

# Create a mapping of author to their language community
author_to_community = {}
for node in author_data['nodes']:
    author_id = node['id']
    language_community = node.get('languageCommunity', -1)
    author_to_community[author_id] = language_community

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

# Filter edges for different community combinations

# 1. Authors in all three communities (0, 1, and 2)
# For each edge, check if both source and target are in communities 0, 1, or 2
all_three_communities_edges = [
    edge for edge in all_edges 
    if edge['source_community'] in [0, 1, 2] and edge['target_community'] in [0, 1, 2]
]

# 2. Authors only in community 0
community_0_edges = [
    edge for edge in all_edges 
    if edge['source_community'] == 0 and edge['target_community'] == 0
]

# 3. Authors only in communities 1 or 2
community_1_2_edges = [
    edge for edge in all_edges 
    if edge['source_community'] in [1, 2] and edge['target_community'] in [1, 2]
]

# Write CSV files
fieldnames = ['source', 'target', 'weight', 'source_community', 'target_community']

# All three communities
with open('author_edges_all_communities.csv', 'w', newline='', encoding='utf-8') as csvfile:
    writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(all_three_communities_edges)

print(f"Created author_edges_all_communities.csv with {len(all_three_communities_edges)} edges")

# Community 0 only
with open('author_edges_community_0.csv', 'w', newline='', encoding='utf-8') as csvfile:
    writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(community_0_edges)

print(f"Created author_edges_community_0.csv with {len(community_0_edges)} edges")

# Communities 1 and 2 only
with open('author_edges_community_1_2.csv', 'w', newline='', encoding='utf-8') as csvfile:
    writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(community_1_2_edges)

print(f"Created author_edges_community_1_2.csv with {len(community_1_2_edges)} edges")
