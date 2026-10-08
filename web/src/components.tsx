import type { ReactNode } from 'react';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>;
}

export function SectionTitle({
  title,
  desc,
  action,
}: {
  title: string;
  desc?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 mb-4">
      <div>
        <h2 className="text-lg font-semibold text-ink-900">{title}</h2>
        {desc && <p className="text-sm text-ink-500 mt-0.5">{desc}</p>}
      </div>
      {action}
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-700',
  approved: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-rose-100 text-rose-700',
  published: 'bg-sky-100 text-sky-700',
  publishing: 'bg-violet-100 text-violet-700',
  failed: 'bg-rose-100 text-rose-700',
  draft: 'bg-ink-100 text-ink-600',
  active: 'bg-emerald-100 text-emerald-700',
  scraping: 'bg-amber-100 text-amber-700',
  error: 'bg-rose-100 text-rose-700',
  open: 'bg-ink-100 text-ink-600',
  used: 'bg-emerald-100 text-emerald-700',
  queued: 'bg-amber-100 text-amber-700',
  done: 'bg-emerald-100 text-emerald-700',
  running: 'bg-violet-100 text-violet-700',
  canceled: 'bg-ink-100 text-ink-500',
};

const STATUS_TEXT: Record<string, string> = {
  pending: '待审核',
  approved: '已通过',
  rejected: '已拒绝',
  published: '已发布',
  publishing: '发布中',
  failed: '失败',
  draft: '草稿',
  active: '正常',
  scraping: '抓取中',
  error: '错误',
  open: '待创作',
  used: '已创作',
  queued: '排队中',
  done: '完成',
  running: '运行中',
  canceled: '取消',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge ${STATUS_STYLES[status] ?? 'bg-ink-100 text-ink-600'}`}>
      {STATUS_TEXT[status] ?? status}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="py-12 text-center text-sm text-ink-400">{children}</div>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="rounded-lg bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-700 mb-4">
      {error}
    </div>
  );
}

export function Spinner({ text = '加载中…' }: { text?: string }) {
  return (
    <div className="py-12 text-center text-sm text-ink-400 flex items-center justify-center gap-2">
      <span className="w-3.5 h-3.5 border-2 border-ink-300 border-t-accent-500 rounded-full animate-spin" />
      {text}
    </div>
  );
}

export function Dot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${ok ? 'bg-emerald-500' : 'bg-rose-400'}`}
      title={ok ? '正常' : '异常'}
    />
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="card py-4">
      <div className="text-xs text-ink-500 mb-1">{label}</div>
      <div className="text-2xl font-semibold text-ink-900 tabular-nums">{value}</div>
      {hint && <div className="text-[11px] text-ink-400 mt-1">{hint}</div>}
    </div>
  );
}