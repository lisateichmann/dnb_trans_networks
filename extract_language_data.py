import json
import csv

# Read the language-language graph JSON file
with open('data/language_language_graph.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

# Extract nodes data: language, greedy (community id), authorCount
nodes_data = []
for node in data['nodes']:
    nodes_data.append({
        'language': node['id'],
        'greedy': node['communities']['greedy'],
        'authorCount': node['authorCount']
    })

# Write nodes data to CSV
with open('language_nodes.csv', 'w', newline='', encoding='utf-8') as csvfile:
    fieldnames = ['language', 'greedy', 'authorCount']
    writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(nodes_data)

print(f"Created language_nodes.csv with {len(nodes_data)} languages")

# Extract edges data: source language, target language, weight
edges_data = []
for edge in data['links']:
    edges_data.append({
        'source_language': edge['source'],
        'target_language': edge['target'],
        'weight': edge['weight']
    })

# Write edges data to CSV
with open('language_edges.csv', 'w', newline='', encoding='utf-8') as csvfile:
    fieldnames = ['source_language', 'target_language', 'weight']
    writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(edges_data)

print(f"Created language_edges.csv with {len(edges_data)} edges")
