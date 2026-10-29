import { PageHeader } from '@/components/shell/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function WorkbenchPage() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-6.5">
      <PageHeader title="工作台" description="所有研究都在本机运行，数据不出机器" />

      <Card>
        <CardHeader>
          <CardTitle>下一步：接入研究流程</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted">
            当前只有导航外壳，工作台还没有数据。研究流程接入后，这里会展示最近的运行。
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
