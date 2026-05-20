/**
 * `/ask` interactive surface.
 *
 * Client component because the chip strip, SQL-line animation, and result
 * table are all driven by local React state. All data fetching happens via
 * `POST /api/queries/natural-language`.
 *
 * The chips strip is the demo's keystone — each chip pre-executes a fixed
 * SQL string server-side (cached after first run) and renders inside ~100ms
 * on click. Free-form input takes the LLM path: 1–2s end-to-end.
 */
'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import type { AskResponse, ChipDef } from '@atlas/api-ask-anything';

type Status = 'idle' | 'thinking' | 'ready' | 'error';

interface AskClientProps {
  chips: ChipDef[];
}

export function AskClient({ chips }: AskClientProps): JSX.Element {
  const [question, setQuestion] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [response, setResponse] = useState<AskResponse | null>(null);
  const [sqlLines, setSqlLines] = useState<string[]>([]);
  const [activeChipId, setActiveChipId] = useState<string | null>(null);
  const animTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearAnim = useCallback(() => {
    for (const t of animTimers.current) clearTimeout(t);
    animTimers.current = [];
  }, []);

  /** Type the SQL out line-by-line for the demo effect. */
  const animateSql = useCallback(
    (sql: string) => {
      clearAnim();
      const lines = sql.split('\n');
      setSqlLines([]);
      lines.forEach((_, i) => {
        const handle = setTimeout(() => {
          setSqlLines(lines.slice(0, i + 1));
        }, 60 * i);
        animTimers.current.push(handle);
      });
    },
    [clearAnim],
  );

  const submit = useCallback(
    async (req: { chipId?: string; question?: string }) => {
      clearAnim();
      setStatus('thinking');
      setActiveChipId(req.chipId ?? null);
      try {
        const res = await fetch('/api/queries/natural-language', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(req),
        });
        const data = (await res.json()) as AskResponse;
        setResponse(data);
        if (data.sql) animateSql(data.sql);
        setStatus(data.ok ? 'ready' : 'error');
      } catch (cause) {
        setResponse({
          ok: false,
          sql: '',
          question: req.question ?? '',
          cached: false,
          rows: [],
          columns: [],
          rowCount: 0,
          executionMs: 0,
          errorMessage:
            cause instanceof Error ? cause.message : 'Network error — try again.',
        });
        setStatus('error');
      }
    },
    [animateSql, clearAnim],
  );

  const onChipClick = useCallback(
    (chip: ChipDef) => {
      void submit({ chipId: chip.id });
    },
    [submit],
  );

  const onSubmitForm = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!question.trim()) return;
      void submit({ question });
    },
    [question, submit],
  );

  const onCsvDownload = useCallback(() => {
    if (!response || response.rows.length === 0) return;
    const blob = new Blob([toCsv(response)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    a.href = url;
    a.download = `atlas-ask-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [response]);

  const statusBadge = useMemo(() => {
    if (status === 'thinking') return 'translating…';
    if (status === 'error') return 'error';
    if (status === 'ready' && response) {
      const wall = response.translationMs
        ? `${response.translationMs + response.executionMs}ms`
        : `${response.executionMs}ms`;
      const cached = response.cached ? ' · cached' : '';
      return `${response.rowCount} rows · ${wall}${cached}`;
    }
    return 'idle';
  }, [response, status]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-6">
        <h1 className="font-mono text-xs uppercase tracking-[0.3em] text-neutral-500">
          ask anything
        </h1>
        <p className="mt-2 text-2xl font-medium text-neutral-100">
          Query the Cursor Community Atlas in plain English.
        </p>
        <p className="mt-1 text-sm text-neutral-500">
          The chips below pre-cache surprising findings. The box translates
          free-form questions through Claude.
        </p>
      </header>

      <form onSubmit={onSubmitForm} className="mb-4">
        <div className="flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-3 focus-within:border-amber-500/50">
          <span className="font-mono text-xs uppercase tracking-widest text-amber-500">{'>'}</span>
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="ask anything about the community"
            className="flex-1 bg-transparent text-base text-neutral-100 placeholder:text-neutral-600 focus:outline-none"
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="submit"
            disabled={status === 'thinking' || question.trim().length === 0}
            className="rounded bg-amber-500/90 px-3 py-1 font-mono text-xs uppercase tracking-widest text-neutral-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-30"
          >
            ask
          </button>
        </div>
      </form>

      <div className="mb-8 flex flex-wrap gap-2">
        {chips.map((chip) => (
          <button
            key={chip.id}
            onClick={() => onChipClick(chip)}
            disabled={status === 'thinking'}
            className={`rounded-full border px-3 py-1.5 text-xs transition ${
              activeChipId === chip.id
                ? 'border-amber-500/70 bg-amber-500/10 text-amber-200'
                : 'border-neutral-800 bg-neutral-900/30 text-neutral-300 hover:border-neutral-700 hover:text-neutral-100'
            } disabled:cursor-not-allowed disabled:opacity-40`}
          >
            {chip.label}
          </button>
        ))}
      </div>

      <section className="rounded-lg border border-neutral-800 bg-neutral-950">
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2">
          <div className="font-mono text-xs uppercase tracking-widest text-neutral-500">
            {response ? `translated to sql · ${sqlLines.length} lines` : 'translated to sql'}
          </div>
          <div className="font-mono text-xs text-neutral-400">{statusBadge}</div>
        </div>
        <pre className="max-h-72 overflow-auto p-4 font-mono text-xs leading-relaxed text-amber-100">
          {sqlLines.length > 0 ? sqlLines.join('\n') : <span className="text-neutral-700">{status === 'thinking' ? '⏳' : '—'}</span>}
        </pre>
      </section>

      <section className="mt-4 rounded-lg border border-neutral-800 bg-neutral-950">
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2">
          <div className="font-mono text-xs uppercase tracking-widest text-neutral-500">
            {response?.ok ? `result · ${response.rowCount} rows` : 'result'}
          </div>
          {response?.ok && response.rows.length > 0 && (
            <button
              onClick={onCsvDownload}
              className="rounded border border-neutral-800 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-neutral-400 transition hover:border-amber-500/50 hover:text-amber-300"
            >
              export csv
            </button>
          )}
        </div>
        <div className="overflow-auto">
          {response && !response.ok ? (
            <div className="p-4 font-mono text-xs text-rose-300">{response.errorMessage}</div>
          ) : response && response.ok ? (
            <ResultTable response={response} />
          ) : (
            <div className="p-4 font-mono text-xs text-neutral-700">
              {status === 'thinking' ? 'running query…' : 'pick a chip or ask a question above.'}
            </div>
          )}
        </div>
        {response?.demoCallout ? (
          <div className="border-t border-neutral-800 px-4 py-3 font-mono text-xs text-amber-300/90">
            <span className="text-amber-500">★ </span>
            {response.demoCallout}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function ResultTable({ response }: { response: AskResponse }): JSX.Element {
  const { columns, rows } = response;
  if (columns.length === 0 || rows.length === 0) {
    return (
      <div className="p-4 font-mono text-xs text-neutral-600">no rows returned</div>
    );
  }
  return (
    <table className="w-full text-left text-xs">
      <thead className="border-b border-neutral-800 bg-neutral-900/40 text-neutral-400">
        <tr>
          {columns.map((c) => (
            <th key={c.name} className="px-3 py-2 font-mono uppercase tracking-widest">
              {c.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr
            key={i}
            className="border-b border-neutral-900/60 align-top text-neutral-200 last:border-none"
          >
            {columns.map((c) => (
              <td key={c.name} className="px-3 py-2 font-mono">
                {formatCell(row[c.name], c.type)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatCell(value: unknown, type: string): React.ReactNode {
  if (value === null || value === undefined) {
    return <span className="text-neutral-700">—</span>;
  }
  if (type === 'number' && typeof value === 'number') {
    return <span className="tabular-nums">{value.toLocaleString()}</span>;
  }
  if (type === 'date' && typeof value === 'string') {
    return <span className="text-neutral-400">{value.slice(0, 19).replace('T', ' ')}</span>;
  }
  if (typeof value === 'string') {
    if (/^https?:\/\//.test(value)) {
      return (
        <a
          href={value}
          target="_blank"
          rel="noopener noreferrer"
          className="text-amber-300 hover:text-amber-200 hover:underline"
        >
          {truncate(value, 60)}
        </a>
      );
    }
    return truncate(value, 200);
  }
  if (typeof value === 'object') {
    return <code className="text-neutral-400">{JSON.stringify(value).slice(0, 80)}</code>;
  }
  return String(value);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function toCsv(response: AskResponse): string {
  const cols = response.columns.map((c) => c.name);
  const lines = [cols.join(',')];
  for (const row of response.rows) {
    lines.push(
      cols.map((c) => csvEscape(row[c])).join(','),
    );
  }
  return lines.join('\n');
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
