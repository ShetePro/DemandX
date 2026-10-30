'use client';

import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { useForm, type FieldErrors, type Resolver } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { crawlSettingsSchema, type CrawlSettings } from '@/lib/settings/crawl-settings';
import { cn } from '@/lib/utils/cn';

import { saveCrawlSettingsAction } from './actions';

type NumericField =
  'perHostConcurrency' | 'minDelayMs' | 'maxDelayMs' | 'maxPagesPerRun' | 'deadlineMinutes';

const NUMBER_FIELDS: ReadonlyArray<{
  name: NumericField;
  label: string;
  hint: string;
  min: number;
  max: number;
}> = [
  {
    name: 'perHostConcurrency',
    label: '每主机并发',
    hint: '1–3。当前 S1 串行采集，该项仅为后续并发池保留。',
    min: 1,
    max: 3,
  },
  { name: 'minDelayMs', label: '最小间隔（ms）', hint: '1000–30000', min: 1000, max: 30000 },
  { name: 'maxDelayMs', label: '最大间隔（ms）', hint: '1000–60000', min: 1000, max: 60000 },
  { name: 'maxPagesPerRun', label: '单次最多页数', hint: '10–200', min: 10, max: 200 },
  { name: 'deadlineMinutes', label: '单次超时（分钟）', hint: '10–180', min: 10, max: 180 },
];

/**
 * The zod schema is the single source of truth: the resolver runs it, so the
 * form cannot save a value the worker would later reject. `maxDelayMs` carries
 * the min/max ordering issue because that is the field the operator must raise.
 */
const resolver: Resolver<CrawlSettings> = (values) => {
  const parsed = crawlSettingsSchema.safeParse(values);
  if (parsed.success) return { values: parsed.data, errors: {} };

  const errors: Record<string, { type: string; message: string }> = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && key in values)
      errors[key] ??= { type: 'validation', message: issue.message };
  }
  return { values: {}, errors: errors as FieldErrors<CrawlSettings> };
};

export interface LimitsFormProps {
  defaults: CrawlSettings;
}

export function LimitsForm({ defaults }: LimitsFormProps) {
  const router = useRouter();
  const formId = useId();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<CrawlSettings>({ defaultValues: defaults, resolver });

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);

    const result = await saveCrawlSettingsAction(values);
    if (!result.ok) {
      setServerError(result.message);
      toast.error(result.message);
      return;
    }

    toast.success('已保存采集设置');
    router.refresh();
  });

  function errorText(name: keyof CrawlSettings): string | undefined {
    const message = errors[name]?.message;
    return typeof message === 'string' ? message : undefined;
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-sm"
      noValidate
    >
      <div>
        <h2 className="text-sm font-semibold text-fg">采集限速</h2>
        <p className="mt-0.5 text-[11px] text-muted">
          每次运行读取一次；改动从下一次 worker 任务开始生效。
        </p>
      </div>

      {serverError ? (
        <p
          role="alert"
          className="rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger"
        >
          {serverError}
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm text-fg">
          <input type="checkbox" className="size-4 accent-accent" {...register('enabled')} />
          启用浏览器采集（关闭后仅静态抓取）
        </label>
        <label className="flex items-center gap-2 text-sm text-fg">
          <input type="checkbox" className="size-4 accent-accent" {...register('respectRobots')} />
          遵守 robots.txt
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {NUMBER_FIELDS.map((field) => {
          const id = `${formId}-${field.name}`;
          const error = errorText(field.name);
          return (
            <div key={field.name} className="flex flex-col gap-1.5">
              <label htmlFor={id} className="text-xs font-medium text-muted">
                {field.label}
              </label>
              <Input
                id={id}
                type="number"
                min={field.min}
                max={field.max}
                step={1}
                aria-invalid={error ? true : undefined}
                {...register(field.name, { valueAsNumber: true })}
              />
              {error ? (
                <p className="text-xs text-danger">{error}</p>
              ) : (
                <p className="text-[11px] text-faint">{field.hint}</p>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex justify-end">
        <Button type="submit" disabled={isSubmitting} className={cn(isSubmitting && 'opacity-80')}>
          {isSubmitting ? '保存中…' : '保存设置'}
        </Button>
      </div>
    </form>
  );
}
