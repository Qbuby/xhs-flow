import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  exportCorpus,
  importCorpus,
  describeImport,
  type CorpusOverview,
  type CorpusImportSummary,
  type Source,
} from '../api';
import { Card, SectionTitle, StatusBadge, Spinner, Empty, ErrorBox } from '../components';
import { toast } from '../store';

export function Sources() {
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [url, setUrl] = useState('');
  const [maxNotes, setMaxNotes] = useState(200);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overview, setOverview] = useState<CorpusOverview | null>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function load() {
    try {
      const [list, ov] = await Promise.all([
        api.get<Source[]>('/api/sources'),
        api.get<CorpusOverview>('/api/corpus/overview'),
      ]);
      setSources(list);
      setOverview(ov);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  async function add() {
    if (!url.trim()) return;
    setBusy(true);
    try {
      await api.post('/api/sources', { profileUrl: url.trim(), maxNotes, downloadImages: true });
      toast('已加入抓取队列，稍后自动开始');
      setUrl('');
      void load();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    if (!confirm('删除这个语料源及其全部笔记？此操作不可撤销。')) return;
    try {
      await api.post(`/api/sources/${id}/delete`);
      toast('已删除');
      void load();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    }
  }

  /** 导出全部语料源。带图片，几十 MB 量级，本地生成通常几秒。 */
  async function doExport() {
    setExporting(true);
    try {
      await exportCorpus('all');
      toast('已导出并开始下载');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setExporting(false);
    }
  }

  async function onImportFile(file: File) {
    if (!file.name.toLowerCase().endsWith('.zip')) {
      toast('请选择导出生成的 .zip 语料包', 'err');
      return;
    }
    setImporting(true);
    try {
      const s = await importCorpus(file);
      toast(`导入完成：${describeImport(s)}`);
      void load();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div>
      <SectionTitle
        title="语料库"
        desc={
          overview
            ? `${overview.sources} 个作者 · ${overview.notes} 篇笔记 · ${overview.images} 张图片`
            : '添加要模仿的小红书作者主页，抓取其全部图文作品'
        }
        action={
          <div className="flex gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".zip,application/zip,application/x-zip-compressed"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onImportFile(f);
              }}
            />
            <button
              className="btn-ghost"
              disabled={importing}
              onClick={() => fileRef.current?.click()}
            >
              {importing ? '导入中…' : '导入'}
            </button>
            <button
              className="btn-ghost"
              disabled={exporting || !overview || overview.sources === 0}
              onClick={() => void doExport()}
              title={
                overview && overview.sources > 0
                  ? `导出 ${overview.sources} 个来源 / ${overview.notes} 篇笔记（含图片）`
                  : undefined
              }
            >
              {exporting ? '打包中…' : '导出全部'}
            </button>
          </div>
        }
      />

      {importing && (
        <div className="mb-4 rounded-lg bg-ink-50 border border-ink-200 px-4 py-3 text-sm text-ink-600">
          正在导入语料包…包里带着全部笔记图片，大的可能要等十几秒，别关页面。
        </div>
      )}

      <ErrorBox error={error} />

      <Card className="mb-5">
        <label className="label">作者主页链接</label>
        <div className="flex gap-2">
          <input
            className="input flex-1"
            placeholder="https://www.xiaohongshu.com/user/profile/xxxxxxxx"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void add()}
          />
          <select
            className="input w-28"
            value={maxNotes}
            onChange={(e) => setMaxNotes(Number(e.target.value))}
          >
            <option value={50}>最多 50</option>
            <option value={200}>最多 200</option>
            <option value={500}>最多 500</option>
          </select>
          <button className="btn-primary" disabled={busy || !url.trim()} onClick={() => void add()}>
            {busy ? '提交中…' : '抓取'}
          </button>
        </div>
        <p className="text-[11px] text-ink-400 mt-2">
          建议用小号抓取。全量扫描有触发风控的可能，系统已内置对数正态请求节流，
          但仍建议控制抓取频率。换设备时用右上角「导出 / 导入」整包搬走，草稿不包含在内。
        </p>
      </Card>

      {loading ? (
        <Spinner />
      ) : sources.length === 0 ? (
        <Empty>还没有语料源。粘贴一个作者主页链接开始。</Empty>
      ) : (
        <div className="card p-0 overflow-hidden">
          <table className="w-full">
            <thead className="bg-ink-50">
              <tr>
                <th className="th">作者</th>
                <th className="th">作品数</th>
                <th className="th">已蒸馏</th>
                <th className="th">状态</th>
                <th className="th">最近抓取</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id} className="hover:bg-ink-50/60">
                  <td className="td">
                    <Link to={`/sources/${s.id}`} className="font-medium hover:text-accent-500">
                      {s.nickname ?? '（未知作者）'}
                    </Link>
                    {s.last_error && (
                      <div className="text-[11px] text-rose-500 mt-0.5 max-w-xs truncate" title={s.last_error}>
                        {s.last_error}
                      </div>
                    )}
                  </td>
                  <td className="td tabular-nums">{s.note_count}</td>
                  <td className="td tabular-nums">
                    {s.styled}
                    <span className="text-ink-400"> / {s.note_count}</span>
                  </td>
                  <td className="td">
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="td text-ink-500 text-xs">{s.last_scraped_at ?? '—'}</td>
                  <td className="td text-right">
                    <button
                      className="text-xs text-ink-400 hover:text-rose-600"
                      onClick={() => void remove(s.id)}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}