import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  api,
  type BrandKitChatResult,
  type BrandKitDiff,
  type BrandKitLogoResult,
  type BrandKitPreviewResult,
  type BrandKitState,
  type Source,
} from '../api';
import { Card, SectionTitle, Spinner, Empty, ErrorBox } from '../components';
import { toast, useUi } from '../store';

/** 把 api 抛出来的错误（含服务端附带的 hint）压成一行能直接给人看的话。 */
function errText(err: unknown): string {
  const e = err as { message?: string; hint?: string };
  const msg = e?.message ?? String(err);
  return e?.hint ? `${msg}：${e.hint}` : msg;
}

/**
 * FileReader 读成 data URL。
 *
 * 服务端收的是 base64（不是 multipart），所以前端必须自己转；
 * data URL 里带 MIME，正好省掉后端猜格式。
 */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result ?? ''));
    fr.onerror = () => reject(new Error('读取文件失败'));
    fr.readAsDataURL(file);
  });
}

/** 「还原」指令涉及的字段名 → 中文。 */
const CLEAR_LABELS: Record<string, string> = {
  brandName: '品牌署名',
  brandTagline: '副行文案',
  logo: '图形 Logo',
  accent: '强调色',
};

/**
 * 一条「原值 → 新值」的对照表。
 *
 * 注意：服务端的 diff 永远是**相对模板基线**算的（不是相对当前已保存的套件），
 * 所以「原值」那一列写的是模板原样，不是改之前的值。
 */
function DiffTable({ diff }: { diff: BrandKitDiff[] }) {
  if (diff.length === 0) {
    return <Empty>没有覆盖任何项，全部沿用模板族原样</Empty>;
  }
  return (
    <div className="card p-0 overflow-hidden">
      <table className="w-full">
        <thead className="bg-ink-50">
          <tr>
            <th className="th">项目</th>
            <th className="th">模板原样</th>
            <th className="th">改成</th>
          </tr>
        </thead>
        <tbody>
          {diff.map((d) => (
            <tr key={d.field}>
              <td className="td whitespace-nowrap">{d.label}</td>
              <td className="td text-ink-500">{d.from}</td>
              <td className="td">
                <span className="inline-flex items-center gap-1.5">
                  {d.field === 'accent' && (
                    <span
                      className="inline-block w-3 h-3 rounded-full border border-ink-200"
                      style={{ background: d.to }}
                    />
                  )}
                  {d.to}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BrandKit() {
  const { id } = useParams<{ id: string }>();
  const sourceId = Number(id);
  // 记住这个源：侧栏「模板调整」入口要指向当前正在调的源
  const rememberSource = useUi((s) => s.rememberSource);

  const [data, setData] = useState<BrandKitState | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 当前正在跑的动作（chat / upload / preview / apply / reset） */
  const [busy, setBusy] = useState('');

  // 自然语言
  const [instruction, setInstruction] = useState('');
  /** 模型解析出来的待应用修改（还没落库） */
  const [pending, setPending] = useState<BrandKitChatResult | null>(null);

  // 上传
  const [thumb, setThumb] = useState<string | null>(null);
  const [thumbName, setThumbName] = useState('');
  const [prepared, setPrepared] = useState<{ width: number; height: number; inkRatio: number } | null>(
    null,
  );
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // 预览
  const [files, setFiles] = useState<BrandKitPreviewResult['files'] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  /** 预览未落库的草稿，而不是当前已保存的套件 */
  const [previewDraft, setPreviewDraft] = useState(false);

  // 手动微调
  const [manual, setManual] = useState({ brandName: '', brandTagline: '', accent: '' });

  const load = useCallback(async () => {
    if (!Number.isFinite(sourceId)) return;
    try {
      const d = await api.get<BrandKitState>(`/api/sources/${sourceId}/brand-kit`);
      setData(d);
      setError(null);
    } catch (err) {
      setError(errText(err));
    } finally {
      setLoading(false);
    }
  }, [sourceId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 作者昵称只为了页头好看，单独取一次；取不到也不影响主流程
  useEffect(() => {
    let alive = true;
    void api
      .get<Source[]>('/api/sources')
      .then((list) => {
        if (alive) setSource(list.find((s) => s.id === sourceId) ?? null);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [sourceId]);

  useEffect(() => {
    if (Number.isFinite(sourceId)) rememberSource(sourceId);
  }, [sourceId, rememberSource]);

  // objectURL 是手动创建的，不 revoke 会一直占着内存
  useEffect(() => {
    return () => {
      if (thumb) URL.revokeObjectURL(thumb);
    };
  }, [thumb]);

  // 手动编辑框跟着已保存的套件走
  useEffect(() => {
    if (!data) return;
    setManual({
      brandName: data.kit.brandName ?? '',
      brandTagline: data.kit.brandTagline ?? '',
      accent: data.kit.accent ?? '',
    });
  }, [data]);

  /* ---------- 自然语言调整 ---------- */

  async function send() {
    const text = instruction.trim();
    if (!text || busy) return;
    setBusy('chat');
    setError(null);
    try {
      const r = await api.post<BrandKitChatResult>(`/api/sources/${sourceId}/brand-kit/chat`, {
        instruction: text,
      });
      setPending(r);
      setInstruction('');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy('');
    }
  }

  async function applyPending() {
    if (!pending || busy) return;
    setBusy('apply');
    setError(null);
    try {
      await api.post(`/api/sources/${sourceId}/brand-kit/apply`, { patch: pending.patch });
      setPending(null);
      setPreviewDraft(false);
      setFiles(null);
      await load();
      toast('修改已应用');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy('');
    }
  }

  /**
   * 手动微调。
   *
   * 三个字段**全部**提交：清空 = 撤销这一项的覆盖（回到模板原样）。
   * 服务端那边空串同样算「没有覆盖」（overlay 只看 trim 后的非空），
   * 所以直接传空串就能撤销，不用另开一个 clear 通道。
   */
  async function applyManual() {
    if (busy) return;
    const accent = manual.accent.trim();
    if (accent && !/^#[0-9a-fA-F]{6}$/.test(accent)) {
      // 强调色必须是 #RRGGBB：写错的话渲染时整套模板会被 schema 校验打回，
      // 结果是「保存成功了但什么都没变」，所以这里先拦一道
      toast('强调色格式不对，应该是 #RRGGBB', 'err');
      return;
    }
    setBusy('manual');
    setError(null);
    try {
      await api.post(`/api/sources/${sourceId}/brand-kit/apply`, {
        kit: {
          brandName: manual.brandName.trim(),
          brandTagline: manual.brandTagline.trim(),
          accent: accent.toUpperCase(),
        },
      });
      await load();
      toast('已保存');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy('');
    }
  }

  /* ---------- 素材上传 ---------- */

  async function upload(file: File) {
    if (busy) return;
    if (!/^image\/(png|jpeg|jpg|webp)$/.test(file.type)) {
      setUploadError('只支持 PNG / JPG / WEBP 图片');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setUploadError('图片超过 8MB，请压缩后再上传');
      return;
    }
    setUploadError(null);
    setBusy('upload');
    // 缩略图用 objectURL：base64 要整个塞进 state，一张 8MB 的图就是十几 MB 的字符串
    const objectUrl = URL.createObjectURL(file);
    setThumb(objectUrl);
    setThumbName(file.name);
    try {
      const dataUrl = await readAsDataUrl(file);
      const r = await api.post<BrandKitLogoResult>(`/api/sources/${sourceId}/brand-kit/logo`, {
        dataUrl,
        fileName: file.name,
        mode: 'cutout',
      });
      setPrepared(r.prepared);
      await load();
      toast('Logo 已上传并生效');
    } catch (err) {
      setUploadError(errText(err));
    } finally {
      setBusy('');
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  /* ---------- 预览 ---------- */

  async function preview() {
    if (busy) return;
    setBusy('preview');
    setPreviewError(null);
    try {
      const body = previewDraft && pending ? { kit: pending.draftKit } : {};
      const r = await api.post<BrandKitPreviewResult>(
        `/api/sources/${sourceId}/brand-kit/preview`,
        body,
      );
      setFiles(r.files);
    } catch (err) {
      setPreviewError(errText(err));
    } finally {
      setBusy('');
    }
  }

  /* ---------- 还原 ---------- */

  async function resetKit() {
    if (busy) return;
    if (!confirm('还原成模板原样？品牌署名、副行文案、强调色和已上传的 Logo 都会被清掉。')) return;
    setBusy('reset');
    setError(null);
    try {
      await api.post(`/api/sources/${sourceId}/brand-kit/reset`);
      setPending(null);
      setPreviewDraft(false);
      setFiles(null);
      setPrepared(null);
      setThumb(null);
      setThumbName('');
      await load();
      toast('已还原为模板原样');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy('');
    }
  }

  if (loading) return <Spinner />;
  if (!data) return <Empty>加载失败</Empty>;

  const kit = data.kit;
  const logo = kit.logoDark ?? kit.logoLight;

  return (
    <div>
      <div className="mb-4">
        <Link to={`/sources/${sourceId}`} className="text-sm text-ink-500 hover:text-accent-500">
          ← {source?.nickname ?? `来源 #${sourceId}`}
        </Link>
      </div>

      <SectionTitle
        title="模板调整"
        desc={`${source?.nickname ?? `来源 #${sourceId}`} · 品牌套件`}
      />

      <ErrorBox error={error} />

      {/* 当前状态 */}
      <Card className="mb-5">
        <SectionTitle
          title="当前状态"
          desc="套件只改身份层（logo / 品牌署名 / 副行文案 / 强调色），版式几何仍取自语料实测"
          action={
            <span
              className={`badge ${
                data.active ? 'bg-emerald-100 text-emerald-700' : 'bg-ink-100 text-ink-600'
              }`}
            >
              {data.active ? `已启用 · 覆盖 ${data.overrideCount} 项` : '未启用'}
            </span>
          }
        />

        <div className="grid md:grid-cols-2 gap-5 mb-4">
          <div>
            <h4 className="text-xs font-semibold text-ink-500 mb-2">模板基线</h4>
            <div className="text-xs text-ink-600 leading-relaxed">
              模板族 {data.baseline.family}
              <br />
              品牌署名：{data.baseline.brandName || '（无）'}
              <br />
              副行文案：{data.baseline.brandTagline || '（无）'}
              <br />
              强调色：
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block w-3 h-3 rounded-full border border-ink-200"
                  style={{ background: data.baseline.accent || '#eee' }}
                />
                {data.baseline.accent || '（无）'}
              </span>
              <br />
              图形 Logo：{data.baseline.hasLogo ? '有' : '无'}
            </div>
          </div>
          <div>
            <h4 className="text-xs font-semibold text-ink-500 mb-2">当前套件</h4>
            <div className="text-xs text-ink-600 leading-relaxed">
              品牌署名：{kit.brandName || '（沿用模板）'}
              <br />
              副行文案：{kit.brandTagline || '（沿用模板）'}
              <br />
              强调色：
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block w-3 h-3 rounded-full border border-ink-200"
                  style={{ background: kit.accent || data.baseline.accent || '#eee' }}
                />
                {kit.accent || '（沿用模板）'}
              </span>
              <br />
              图形 Logo：{logo ? `已上传（${logo.originalName ?? logo.file}）` : '（沿用模板）'}
              <br />
              更新时间：{kit.updatedAt}
            </div>
          </div>
        </div>

        <h4 className="text-xs font-semibold text-ink-500 mb-2">模板原样 → 当前套件</h4>
        <DiffTable diff={data.diff} />

        <p className="mt-3 text-[11px] text-ink-400 leading-relaxed">{data.note}</p>
      </Card>

      {/* 自然语言调整 */}
      <Card className="mb-5">
        <SectionTitle
          title="自然语言调整"
          desc="用一句话说要改什么，先看改动清单，确认后再应用"
        />

        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="label">修改要求</label>
            <textarea
              className="input min-h-[72px] resize-y"
              placeholder="例如：品牌名换成 Chengwang，副行文案也改掉"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send();
              }}
            />
          </div>
          <button className="btn-primary" disabled={busy === 'chat' || !instruction.trim()} onClick={() => void send()}>
            {busy === 'chat' ? '解析中…' : '发送'}
          </button>
        </div>
        <p className="text-[11px] text-ink-400 mt-2">Ctrl/⌘ + Enter 也能发送。</p>

        {pending && (
          <div className="mt-4 pt-4 border-t border-ink-100">
            <div className="rounded-lg bg-accent-500/10 border border-accent-200/60 px-4 py-3 text-sm text-ink-800 mb-3">
              {pending.patch.reply || '（模型没有给出解释）'}
            </div>

            {pending.patch.clear && pending.patch.clear.length > 0 && (
              <div className="text-xs text-ink-600 mb-3">
                将还原为模板原样：
                <span className="text-ink-900">
                  {pending.patch.clear.map((c) => CLEAR_LABELS[c] ?? c).join('、')}
                </span>
              </div>
            )}

            <h4 className="text-xs font-semibold text-ink-500 mb-2">改完之后是这样</h4>
            <DiffTable diff={pending.diff} />

            {pending.needsUpload && (
              <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
                需要在下方上传新的 Logo 素材后生效。
              </div>
            )}

            <div className="flex gap-2 mt-4">
              <button className="btn-primary" disabled={busy === 'apply'} onClick={() => void applyPending()}>
                {busy === 'apply' ? '应用中…' : '应用修改'}
              </button>
              <button
                className="btn-ghost"
                disabled={busy === 'apply'}
                onClick={() => {
                  // 取消 = 丢弃这次草稿。已经按草稿渲染过的预览也得作废，
                  // 否则图还挂在页面上，用户会以为改动还在
                  setPending(null);
                  setPreviewDraft(false);
                  setFiles(null);
                }}
              >
                取消
              </button>
            </div>
          </div>
        )}
      </Card>

      {/* 素材上传 */}
      <Card className="mb-5">
        <SectionTitle
          title="素材上传"
          desc="上传图形 Logo，服务端自动抠底并派生深色/浅色两版；上传即生效"
        />

        <ErrorBox error={uploadError} />

        <div className="flex flex-wrap items-start gap-5">
          <div className="flex-1 min-w-[260px]">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
              }}
            />

            <div
              className="rounded-xl border-2 border-dashed border-ink-200 px-5 py-8 text-center cursor-pointer hover:border-accent-400 hover:bg-accent-500/5 transition-colors"
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                e.currentTarget.classList.add('border-accent-400', 'bg-accent-500/5');
              }}
              onDragLeave={(e) => {
                e.currentTarget.classList.remove('border-accent-400', 'bg-accent-500/5');
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.currentTarget.classList.remove('border-accent-400', 'bg-accent-500/5');
                const f = e.dataTransfer.files?.[0];
                if (f) void upload(f);
              }}
            >
              <div className="text-sm text-ink-700 mb-1">
                {busy === 'upload' ? '上传处理中…' : '把图片拖到这里，或点击选择'}
              </div>
              <div className="text-[11px] text-ink-400">PNG / JPG / WEBP，最大 8MB</div>
            </div>

            {thumb && (
              <div className="mt-3 flex items-center gap-3">
                <img
                  src={thumb}
                  alt="待上传的 Logo"
                  className="w-14 h-14 object-contain rounded-lg border border-ink-200 bg-white p-1"
                />
                <div className="text-xs text-ink-600">
                  <div className="text-ink-800 truncate max-w-[200px]">{thumbName}</div>
                  {prepared ? (
                    <div className="mt-0.5">
                      已处理为 {prepared.width}×{prepared.height}，主体占比{' '}
                      {Math.round(prepared.inkRatio * 100)}%
                    </div>
                  ) : (
                    <div className="mt-0.5 text-ink-400">等待上传完成</div>
                  )}
                </div>
              </div>
            )}

            {prepared && !thumb && (
              <div className="mt-3 text-xs text-ink-600">
                上次上传已处理为 {prepared.width}×{prepared.height}，主体占比{' '}
                {Math.round(prepared.inkRatio * 100)}%
              </div>
            )}
          </div>

          <div className="w-full sm:w-[280px]">
            <h4 className="text-xs font-semibold text-ink-500 mb-2">当前 Logo</h4>
            {logo ? (
              <div className="rounded-lg border border-ink-200 p-3">
                <div className="text-sm text-ink-800 truncate">{logo.originalName ?? logo.file}</div>
                <div className="text-[11px] text-ink-500 mt-1">
                  {logo.width}×{logo.height} · {logo.mode === 'cutout' ? '已抠底' : '原样'}
                </div>
                <div className="text-[11px] text-ink-400 mt-0.5">上传于 {logo.uploadedAt}</div>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-ink-200 px-3 py-4 text-xs text-ink-400">
                尚未安装自定义 Logo，沿用模板族原样
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* 预览效果 */}
      <Card className="mb-5">
        <SectionTitle
          title="预览效果"
          desc="用真实卡片渲染封面与内页，看看套件套上去是什么样"
          action={
            <div className="flex gap-2">
              <button className="btn-ghost" disabled={busy === 'reset'} onClick={() => void resetKit()}>
                {busy === 'reset' ? '还原中…' : '还原为模板原样'}
              </button>
              <button className="btn-primary" disabled={busy === 'preview'} onClick={() => void preview()}>
                {busy === 'preview' ? '渲染中…' : files ? '重新渲染' : '渲染预览'}
              </button>
            </div>
          }
        />

        {pending && (
          <label className="flex items-center gap-2 text-sm text-ink-700 mb-4">
            <input
              type="checkbox"
              checked={previewDraft}
              onChange={(e) => {
                setPreviewDraft(e.target.checked);
                setFiles(null);
              }}
            />
            预览未应用的修改
          </label>
        )}

        <ErrorBox error={previewError} />

        {files ? (
          <div className="grid sm:grid-cols-2 gap-4">
            {files.map((f) => (
              <div key={f.layout}>
                <div className="text-xs text-ink-500 mb-1.5">
                  {f.layout === 'cover' ? '封面' : f.layout === 'list' ? '内页' : f.layout} ·{' '}
                  {f.width}×{f.height}
                </div>
                <img
                  src={f.url}
                  alt={f.layout}
                  className="w-full rounded-lg border border-ink-200 bg-white"
                />
              </div>
            ))}
          </div>
        ) : (
          <Empty>
            {busy === 'preview' ? '正在渲染…' : '还没有渲染过预览，点「渲染预览」看效果'}
          </Empty>
        )}
      </Card>

      {/* 手动微调 */}
      <Card>
        <SectionTitle title="手动微调" desc="不用模型，直接改这三项。清空某一项 = 撤销该项的覆盖，回到模板原样" />

        <div className="grid md:grid-cols-3 gap-4 mb-4">
          <div>
            <label className="label">品牌署名</label>
            <input
              className="input"
              value={manual.brandName}
              onChange={(e) => setManual({ ...manual, brandName: e.target.value })}
              placeholder="沿用模板"
            />
          </div>
          <div>
            <label className="label">副行文案</label>
            <input
              className="input"
              value={manual.brandTagline}
              onChange={(e) => setManual({ ...manual, brandTagline: e.target.value })}
              placeholder="沿用模板"
            />
          </div>
          <div>
            <label className="label">强调色</label>
            <div className="flex gap-2">
              <input
                type="color"
                className="w-10 h-9 rounded-lg border border-ink-200 bg-white p-0.5 cursor-pointer"
                value={/^#[0-9a-f]{6}$/i.test(manual.accent) ? manual.accent : '#007CFE'}
                onChange={(e) => setManual({ ...manual, accent: e.target.value.toUpperCase() })}
              />
              <input
                className="input flex-1"
                value={manual.accent}
                onChange={(e) => setManual({ ...manual, accent: e.target.value })}
                placeholder="#0090F0"
              />
            </div>
          </div>
        </div>

        <button className="btn-primary" disabled={busy === 'manual'} onClick={() => void applyManual()}>
          {busy === 'manual' ? '保存中…' : '保存'}
        </button>
      </Card>
    </div>
  );
}
