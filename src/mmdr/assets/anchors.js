const primitives = "path,rect,circle,ellipse,polygon,polyline,line,text,foreignObject";

export function selectableElements(svg) {
  return [...svg.querySelectorAll(primitives)].filter((element) =>
    !element.closest("defs,marker,clipPath,mask,pattern") &&
    element.getBoundingClientRect().width + element.getBoundingClientRect().height > 0
  );
}

export function indexElements(svg, revision) {
  const anchors = [];
  const groups = new Map();
  const stableKeys = new Map();
  const elements = selectableElements(svg);
  for (const element of elements) {
    const owner = element.closest("g.node,g.cluster") || element;
    if (groups.has(owner)) {
      element.dataset.anchor = groups.get(owner).key;
      continue;
    }
    // Only source-defined flowchart IDs have a proven renderer mapping.
    const localId = owner.id.startsWith(svg.id + "-") ? owner.id.slice(svg.id.length + 1) : owner.id;
    const match = localId.match(/^flowchart-(.+)-\d+$/);
    const semantic = match ? `flowchart:${match[1]}` : null;
    const classId = localId.match(/^classId-(.+)-\d+$/);
    const title = classId ? owner.querySelector(".label-group")?.textContent.trim() || classId[1] : null;
    const label = (title || owner.textContent.trim() || owner.id || element.tagName).replace(/\s+/g, " ").slice(0, 500);
    const anchor = {
      key: semantic || `revision:${revision}:${anchors.length}`,
      label,
      stable: !!semantic,
    };
    if (semantic && stableKeys.has(semantic)) {
      const prior = stableKeys.get(semantic);
      prior.key = `revision:${revision}:${anchors.indexOf(prior)}`;
      prior.stable = false;
      for (const tagged of svg.querySelectorAll("[data-anchor]")) {
        if (tagged.dataset.anchor === semantic) tagged.dataset.anchor = prior.key;
      }
      anchor.key = `revision:${revision}:${anchors.length}`;
      anchor.stable = false;
    }
    if (semantic) stableKeys.set(semantic, anchor);
    groups.set(owner, anchor);
    anchors.push(anchor);
    owner.dataset.anchor = anchor.key;
    element.dataset.anchor = anchor.key;
    owner.setAttribute("tabindex", "0");
    owner.setAttribute("role", "button");
    owner.setAttribute("aria-label", `Comment on ${label}`);
  }
  return anchors;
}
