export interface QueryTableRow {
  id: number;
  angle: string | null;
  provider: string | null;
  text: string | null;
  resultCount: number;
}

export interface QueryTableProps {
  rows: readonly QueryTableRow[];
}

/**
 * The search log S1 wrote, kept for auditability. It is historical data, not a
 * live view: SSE carries stage and source events, not query inserts.
 */
export function QueryTable({ rows }: QueryTableProps) {
  return (
    <section
      aria-labelledby="query-table-heading"
      className="rounded-xl border border-border bg-surface shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-4">
        <div>
          <h2 id="query-table-heading" className="text-sm font-semibold text-fg">
            检索查询
          </h2>
          <p className="mt-0.5 text-xs text-muted">S1 实际发出的搜索请求，按发出顺序排列。</p>
        </div>
        <span className="text-xs text-muted tabular-nums">共 {rows.length} 条</span>
      </div>

      {rows.length === 0 ? (
        <p className="p-4 text-sm text-muted">本次运行还没有记录检索查询。</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <caption className="sr-only">本次运行的检索查询</caption>
            <thead>
              <tr className="border-b border-border text-[11px] font-medium text-muted">
                <th scope="col" className="px-4 py-2.5">
                  角度
                </th>
                <th scope="col" className="px-4 py-2.5">
                  查询
                </th>
                <th scope="col" className="px-4 py-2.5 text-right">
                  结果数
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-2.5 whitespace-nowrap text-muted">{row.angle ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    <p className="text-fg">{row.text ?? '—'}</p>
                    {row.provider === null ? null : (
                      <p className="mt-0.5 text-[11px] text-faint">{row.provider}</p>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right text-fg tabular-nums">{row.resultCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
