/**
 * `[e12]` anchors in assistant text become chips. Streamdown renders markdown
 * from HAST (not an HTML string), so the replacement happens in the tree before
 * sanitization: the markdown source is untouched and no HTML is injected.
 */

/** Anchors carry their `e` prefix; the digits are only used to group matches. */
const CITATION_PATTERN = /\[e(\d+)\]/g;

/** Content that must stay literal — a citation inside code is not a citation. */
const LITERAL_TAGS: Record<string, true> = {
  code: true,
  pre: true,
  script: true,
  style: true,
};

export type CitationSegment = { kind: 'text'; text: string } | { kind: 'citation'; id: string };

/** Split `"依据 [e1]，但也 [e2]。"` into text runs and citation anchors. */
export function splitCitations(text: string): CitationSegment[] {
  const segments: CitationSegment[] = [];
  let last = 0;

  for (const match of text.matchAll(CITATION_PATTERN)) {
    const start = match.index ?? 0;
    if (start > last) segments.push({ kind: 'text', text: text.slice(last, start) });
    segments.push({ kind: 'citation', id: `e${match[1] ?? ''}` });
    last = start + match[0].length;
  }

  if (last < text.length) segments.push({ kind: 'text', text: text.slice(last) });
  return segments;
}

type HastNode = Record<string, unknown>;

function isParent(node: HastNode): node is HastNode & { children: HastNode[] } {
  return Array.isArray(node.children);
}

function isText(node: HastNode): node is HastNode & { value: string } {
  return node.type === 'text' && typeof node.value === 'string';
}

function citationNodes(text: string): HastNode[] {
  return splitCitations(text).map((segment) =>
    segment.kind === 'text'
      ? { type: 'text', value: segment.text }
      : {
          type: 'element',
          tagName: 'citation-chip',
          // Declared in `allowedTags` so rehype-sanitize keeps the element and
          // its attribute; `components` maps it to the real chip button.
          properties: { 'data-id': segment.id },
          children: [{ type: 'text', value: segment.id }],
        },
  );
}

function visit(node: HastNode): void {
  if (!isParent(node)) return;
  if (typeof node.tagName === 'string' && LITERAL_TAGS[node.tagName] === true) return;

  const next: HastNode[] = [];
  for (const child of node.children) {
    if (isText(child)) {
      next.push(...citationNodes(child.value));
      continue;
    }
    visit(child);
    next.push(child);
  }
  node.children = next;
}

/** Rehype plugin; pass it to `<Streamdown rehypePlugins={[...]}>`. */
export function citationRehypePlugin() {
  return (tree: HastNode): void => {
    visit(tree);
  };
}
