export function formatNumber(value) {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return value.toString();
}

export function createTooltip() {
  return d3
    .select("body")
    .append("div")
    .attr("class", "tooltip")
    .style("opacity", 0);
}

export function showTooltip(tooltip, html, event) {
  tooltip
    .style("opacity", 1)
    .html(html)
    .style("left", `${event.pageX + 12}px`)
    .style("top", `${event.pageY + 12}px`);
}

export function hideTooltip(tooltip) {
  tooltip.style("opacity", 0);
}

export function downloadJSON(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function filterByWeight(data, minWeight) {
  const links = data.links.filter((link) => link.weight >= minWeight);
  const nodeIds = new Set();
  links.forEach((link) => {
    nodeIds.add(link.source);
    nodeIds.add(link.target);
  });
  const nodes = data.nodes.filter((node) => nodeIds.has(node.id));
  return { nodes, links };
}
