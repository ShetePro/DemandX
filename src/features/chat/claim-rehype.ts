/**
 * Marks analyst paragraphs by the label they open with ("结论：", "事实：",
 * "推断：", "未知：", "风险："). The markdown renderer cannot tell these apart
 * from any other bold lead-in, and styling them all as the same callout is what
 * made conclusions and speculation look equally important.
 */
type HastNode = {
  type?: string | undefined;
  tagName?: string | undefined;
  properties?: Record<string, unknown> | undefined;
  children?: HastNode[] | undefined;
  value?: string | undefined;
};

const CLAIM_LABELS: readonly (readonly [RegExp, string])[] = [
  [/^(结论|总结|判断)/, 'conclusion'],
  [/^(事实|证据|已验证)/, 'fact'],
  [/^(推断|分析|推测|判断依据)/, 'inference'],
  [/^(未知|待验证|未验证|缺口|缺少)/, 'unknown'],
  [/^(风险|反方|负面证据|反对)/, 'risk'],
  [/^(实验|验证计划|下一步|行动)/, 'next'],
];

function textContent(node: HastNode): string {
  if (typeof node.value === 'string') return node.value;
  return (node.children ?? []).map((child) => textContent(child)).join('');
}

/** Streamdown may keep `<strong>` or rewrite it to `<span data-streamdown="strong">`. */
function isStrong(node: HastNode): boolean {
  if (node.type !== 'element') return false;
  if (node.tagName === 'strong' || node.tagName === 'b') return true;
  return (
    node.properties?.['data-streamdown'] === 'strong' ||
    node.properties?.['dataStreamdown'] === 'strong'
  );
}

function claimOf(label: string): string | null {
  const clean = label.replace(/[*：:\s]/g, '');
  for (const [pattern, kind] of CLAIM_LABELS) {
    if (pattern.test(clean)) return kind;
  }
  return null;
}

function annotateParagraph(node: HastNode): void {
  if (node.tagName !== 'p') return;

  const first = node.children?.find((child) => child.type === 'element');
  if (first === undefined || !isStrong(first)) return;

  const kind = claimOf(textContent(first));
  if (kind === null) return;
  node.properties = { ...node.properties, 'data-claim': kind };
}

/** Runs after sanitize so the derived attribute is not stripped as unknown. */
export function claimRehypePlugin() {
  return (tree: HastNode): void => {
    const walk = (node: HastNode): void => {
      if (!Array.isArray(node.children)) return;
      if (node.type === 'element') annotateParagraph(node);
      for (const child of node.children) walk(child);
    };
    walk(tree);
  };
}
