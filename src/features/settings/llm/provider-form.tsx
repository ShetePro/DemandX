'use client';

import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { useForm, useWatch, type FieldErrors, type Resolver } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils/cn';
import type { ProviderKind, ProviderRow } from '@/lib/llm/types';

import { createProviderAction, updateProviderAction } from './actions';
import { isPaygBaseUrl, providerFormSchema, providerUpdateFormSchema } from './schema';

const KIND_OPTIONS: ReadonlyArray<{ value: ProviderKind; label: string }> = [
  { value: 'openai-compatible', label: 'OpenAI 兼容' },
  { value: 'anthropic-compatible', label: 'Anthropic 兼容' },
  { value: 'google', label: 'Google' },
  { value: 'ollama', label: 'Ollama（本地）' },
];

type FormValues = {
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  headersText: string;
  monthlyAllowanceUsd: string;
  enabled: boolean;
  acknowledgePayg: boolean;
};

type ParsedHeaders = { ok: true; value: Record<string, string> } | { ok: false; message: string };

/**
 * Extra headers are edited as JSON text (a key/value grid is more clicks than
 * operators want). An empty box means "no extra headers"; malformed JSON is a
 * field error, never a silent `{}`.
 */
export function parseHeadersText(text: string): ParsedHeaders {
  // Clearing the box clears the headers; `undefined` would mean "keep the
  // stored ones" on update, which contradicts what the operator sees.
  if (text.trim() === '') return { ok: true, value: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: 'headers 必须是合法的 JSON 对象' };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: 'headers 必须是 JSON 对象' };
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.some(([, value]) => typeof value !== 'string')) {
    return { ok: false, message: 'headers 的每个值都必须是字符串' };
  }

  return { ok: true, value: Object.fromEntries(entries) as Record<string, string> };
}

/** Values a directory selection hands to the manual form. */
export type ProviderFormDefaults = {
  name?: string;
  kind?: ProviderKind;
  baseUrl?: string;
};

function defaultValues(provider?: ProviderRow, initial?: ProviderFormDefaults): FormValues {
  return {
    name: provider?.name ?? initial?.name ?? '',
    kind: provider?.kind ?? initial?.kind ?? 'openai-compatible',
    baseUrl: provider?.baseUrl ?? initial?.baseUrl ?? '',
    apiKey: '',
    headersText:
      provider && Object.keys(provider.headers).length > 0
        ? JSON.stringify(provider.headers, null, 2)
        : '',
    monthlyAllowanceUsd:
      provider?.monthlyAllowanceUsd === null || provider?.monthlyAllowanceUsd === undefined
        ? ''
        : String(provider.monthlyAllowanceUsd),
    enabled: provider?.enabled ?? true,
    acknowledgePayg: false,
  };
}

function fieldErrorsFrom(error: {
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>;
}): Record<string, { type: string; message: string }> {
  const errors: Record<string, { type: string; message: string }> = {};

  for (const issue of error.issues) {
    const key = issue.path[0];
    if (key === 'headers') {
      errors.headersText ??= { type: 'validation', message: issue.message };
      continue;
    }
    if (typeof key === 'string' && key in defaultValues()) {
      errors[key] ??= { type: 'validation', message: issue.message };
    }
  }

  return errors;
}

export type ProviderFormProps = {
  /** Present when editing; absent when creating. */
  provider?: ProviderRow | undefined;
  /** Prefill for a new provider, e.g. a selection from the directory. */
  initialValues?: ProviderFormDefaults | undefined;
  /** Called after the action succeeds, so a wrapping dialog can close. */
  onSaved?: () => void;
  className?: string;
};

export function ProviderForm({ provider, initialValues, onSaved, className }: ProviderFormProps) {
  const router = useRouter();
  const formId = useId();
  const [serverError, setServerError] = useState<string | null>(null);

  const schema = provider ? providerUpdateFormSchema : providerFormSchema;

  const resolver: Resolver<FormValues> = (values) => {
    const errors: Record<string, { type: string; message: string }> = {};

    const headers = parseHeadersText(values.headersText);
    if (!headers.ok) errors.headersText = { type: 'manual', message: headers.message };

    const allowanceText = values.monthlyAllowanceUsd.trim();
    const allowance = allowanceText === '' ? undefined : Number(allowanceText);
    if (allowance !== undefined && !Number.isFinite(allowance)) {
      errors.monthlyAllowanceUsd = { type: 'manual', message: '额度必须是数字' };
    }

    const parsed = schema.safeParse({
      name: values.name,
      kind: values.kind,
      baseUrl: values.baseUrl,
      // Creating treats an empty box as "no key"; editing keeps `''`, which the
      // action understands as "leave the stored key alone".
      apiKey: provider ? values.apiKey : values.apiKey.trim() === '' ? undefined : values.apiKey,
      headers: headers.ok ? headers.value : undefined,
      monthlyAllowanceUsd: allowance,
      enabled: values.enabled,
      acknowledgePayg: values.acknowledgePayg,
    });

    if (!parsed.success) {
      for (const [key, value] of Object.entries(fieldErrorsFrom(parsed.error))) {
        if (value) errors[key] ??= value;
      }
    }

    if (Object.keys(errors).length > 0) {
      return { values: {}, errors: errors as FieldErrors<FormValues> };
    }
    return { values, errors: {} };
  };

  const {
    register,
    handleSubmit,
    setError,
    control,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    defaultValues: defaultValues(provider, initialValues),
    resolver,
  });

  // The acknowledgement only exists for metered endpoints; hiding it otherwise
  // keeps the ordinary form short.
  const baseUrl = useWatch({ control, name: 'baseUrl' }) ?? '';
  const payg = isPaygBaseUrl(baseUrl);

  const onSubmit = handleSubmit(
    async (values) => {
      setServerError(null);
      const headers = parseHeadersText(values.headersText);
      if (!headers.ok) {
        setError('headersText', { type: 'manual', message: headers.message });
        return;
      }

      const allowanceText = values.monthlyAllowanceUsd.trim();
      const payload = {
        name: values.name,
        kind: values.kind,
        baseUrl: values.baseUrl,
        apiKey: provider ? values.apiKey : values.apiKey.trim() === '' ? undefined : values.apiKey,
        headers: headers.value,
        monthlyAllowanceUsd: allowanceText === '' ? undefined : Number(allowanceText),
        enabled: values.enabled,
        acknowledgePayg: values.acknowledgePayg,
      };

      const result = provider
        ? await updateProviderAction(provider.id, payload)
        : await createProviderAction(payload);

      if (!result.ok) {
        setServerError(result.message);
        if (result.code === 'PAYG_NOT_ACKNOWLEDGED') {
          setError('acknowledgePayg', { type: 'server', message: result.message });
        }
        return;
      }

      if (provider) {
        toast.success('已保存 provider 修改');
        router.refresh();
      } else {
        toast.success('已添加 provider');
        // Land on the new provider: its models, usage and chain entry are all
        // selected by id, so a bare refresh would keep the empty selection.
        router.push(`/settings/llm?provider=${result.value.id}`);
      }
      onSaved?.();
    },
    (formErrors) => {
      const first =
        formErrors.acknowledgePayg?.message ??
        formErrors.name?.message ??
        formErrors.baseUrl?.message ??
        formErrors.apiKey?.message ??
        formErrors.monthlyAllowanceUsd?.message ??
        formErrors.headersText?.message;
      if (typeof first === 'string') setServerError(first);
    },
  );

  function errorText(name: keyof FormValues): string | undefined {
    const message = errors[name]?.message;
    return typeof message === 'string' ? message : undefined;
  }

  const fieldClass = 'flex flex-col gap-1.5';

  return (
    <form onSubmit={onSubmit} className={cn('flex flex-col gap-4', className)} noValidate>
      {serverError ? (
        <p
          role="alert"
          className="rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger"
        >
          {serverError}
        </p>
      ) : null}

      <div className={fieldClass}>
        <label htmlFor={`${formId}-name`} className="text-xs font-medium text-muted">
          名称
        </label>
        <Input
          id={`${formId}-name`}
          placeholder="例如 本地 Ollama"
          aria-invalid={errorText('name') ? true : undefined}
          {...register('name')}
        />
        {errorText('name') ? <p className="text-xs text-danger">{errorText('name')}</p> : null}
      </div>

      <div className={fieldClass}>
        <label htmlFor={`${formId}-kind`} className="text-xs font-medium text-muted">
          类型
        </label>
        <select
          id={`${formId}-kind`}
          className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg focus-visible:outline-2 focus-visible:outline-accent"
          {...register('kind')}
        >
          {KIND_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className={fieldClass}>
        <label htmlFor={`${formId}-base-url`} className="text-xs font-medium text-muted">
          Base URL
        </label>
        <Input
          id={`${formId}-base-url`}
          placeholder="https://api.example.com/v1"
          aria-invalid={errorText('baseUrl') ? true : undefined}
          {...register('baseUrl')}
        />
        {errorText('baseUrl') ? (
          <p className="text-xs text-danger">{errorText('baseUrl')}</p>
        ) : null}
      </div>

      <div className={fieldClass}>
        <label htmlFor={`${formId}-api-key`} className="text-xs font-medium text-muted">
          API Key
        </label>
        <Input
          id={`${formId}-api-key`}
          type="password"
          autoComplete="off"
          placeholder={provider ? '留空不修改' : 'sk-…（Ollama 可留空）'}
          aria-invalid={errorText('apiKey') ? true : undefined}
          {...register('apiKey')}
        />
        {errorText('apiKey') ? <p className="text-xs text-danger">{errorText('apiKey')}</p> : null}
      </div>

      <div className={fieldClass}>
        <label htmlFor={`${formId}-headers`} className="text-xs font-medium text-muted">
          Headers（JSON，可留空）
        </label>
        <Textarea
          id={`${formId}-headers`}
          rows={3}
          placeholder={'{"HTTP-Referer": "https://example.com"}'}
          aria-invalid={errorText('headersText') ? true : undefined}
          {...register('headersText')}
        />
        {errorText('headersText') ? (
          <p className="text-xs text-danger">{errorText('headersText')}</p>
        ) : null}
      </div>

      <div className={fieldClass}>
        <label htmlFor={`${formId}-allowance`} className="text-xs font-medium text-muted">
          月额度（USD，可选）
        </label>
        <Input
          id={`${formId}-allowance`}
          type="number"
          min={0}
          step="0.01"
          placeholder="80"
          aria-invalid={errorText('monthlyAllowanceUsd') ? true : undefined}
          {...register('monthlyAllowanceUsd')}
        />
        {errorText('monthlyAllowanceUsd') ? (
          <p className="text-xs text-danger">{errorText('monthlyAllowanceUsd')}</p>
        ) : null}
      </div>

      <label className="flex items-center gap-2 text-sm text-fg">
        <input type="checkbox" className="size-4 accent-accent" {...register('enabled')} />
        启用（停用后不会出现在链路里）
      </label>

      {payg ? (
        <div className="rounded-lg border border-warning/40 bg-warning-soft px-3 py-2">
          <label className="flex items-start gap-2 text-sm text-warning">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-warning"
              aria-invalid={errorText('acknowledgePayg') ? true : undefined}
              {...register('acknowledgePayg', {
                // Ticking the box invalidates the refusal that is shown above.
                onChange: () => setServerError(null),
              })}
            />
            我知道这是按量计费
          </label>
          <p className="mt-1 text-xs text-warning/90">
            该 endpoint 每次调用都会真实扣费，请确认余额与自动化调用量。
          </p>
          {errorText('acknowledgePayg') ? (
            <p className="mt-1 text-xs text-danger">{errorText('acknowledgePayg')}</p>
          ) : null}
        </div>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? '保存中…' : provider ? '保存修改' : '添加 provider'}
        </Button>
      </div>
    </form>
  );
}
