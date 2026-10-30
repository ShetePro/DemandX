import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { loadReportPage, type ReportPageData } from '@/lib/report/read';
import { reportTitle } from '@/lib/report/sections';

import { ReportView } from './report-view';

/** Why the run has no report yet, in the run's own words. */
const STATUS_MESSAGE: Readonly<Record<string, string>> = {
  queued: '研究已排队，报告会在评分与校验完成后出现。',
  running: '研究仍在进行，S5 合成与 S6 校验完成后本页自动可用。',
  paused: '研究已暂停，恢复后会继续生成报告。',
  failed: '本轮研究失败，没有生成报告；已采集的证据仍可逐条核对。',
  cancelled: '本轮研究已取消，没有生成报告；已采集的证据仍可逐条核对。',
};

/**
 * The honest empty state: the current stage is the only progress claim made,
 * and no estimated conclusion is rendered in place of the missing report.
 */
function MissingReport({
  data,
  title,
  embedded,
}: {
  data: ReportPageData;
  title: string;
  embedded: boolean;
}) {
  const stage = data.stage === null ? '尚未开始' : data.stage;
  const backHref = data.threadId === null ? '/threads/new' : `/threads/${data.threadId}`;
  const backLabel = data.threadId === null ? '开始新研究' : '返回对话';

  return (
    <div className="mx-auto w-full max-w-[900px] p-4 md:p-6">
      <PageHeader
        title={`报告 · ${title}`}
        description={`run #${data.runId} · 状态 ${data.status} · 阶段 ${stage}`}
      />

      <Card>
        <CardHeader>
          <CardTitle>报告尚未生成，当前阶段 {stage}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            {STATUS_MESSAGE[data.status] ?? '本轮研究还没有发布报告。'}
          </p>
          {embedded ? null : (
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild>
                <Link href={`/runs/${data.runId}/evidence`}>查看已采集证据</Link>
              </Button>
              <Button variant="ghost" asChild>
                <Link href={`/runs/${data.runId}`}>运行监控</Link>
              </Button>
              <Button variant="ghost" asChild>
                <Link href={backHref}>{backLabel}</Link>
              </Button>
            </div>
          )}
          <p className="text-xs text-muted">
            报告只呈现经过引文校验的论断；在此之前不会展示任何估算或占位内容。
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export interface ReportPanelProps {
  runId: number;
  /**
   * The conversation page already frames the view, so the standalone header
   * and its links to other routes are dropped there. The tab itself stays.
   */
  embedded?: boolean;
}

/**
 * The report of one run, or the reason it does not exist yet. Shared by
 * `/runs/[runId]/report` and the conversation's 报告 tab; the read model is
 * `loadReportPage`, so neither route re-assembles the data.
 */
export async function ReportPanel({ runId, embedded = false }: ReportPanelProps) {
  const loaded = await loadReportPage(runId);
  if (!loaded.ok) throw new Error(loaded.message);
  if (loaded.value === null) notFound();

  const data = loaded.value;
  const title = reportTitle(data.idea);

  if (data.report === null) {
    return <MissingReport data={data} title={title} embedded={embedded} />;
  }

  return (
    <ReportView
      runId={data.runId}
      ideaTitle={title}
      report={data.report}
      scores={data.scores}
      evidenceMap={data.evidenceMap}
    />
  );
}
