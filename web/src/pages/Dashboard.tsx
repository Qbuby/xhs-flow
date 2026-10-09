import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Health, type Draft, type Source, type EventRow } from '../api';
import { Card, SectionTitle, StatusBadge, Stat, Dot, Spinner, Empty } from '../components';
import { toast } from '../store';

export function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [qr, setQr] = useState<string | null>(null);
  const [qrBusy, setQrBusy] = useState(false);
  const [cookieInput, setCookieInput] = useState('');
  const [ipBlock, setIpBlock] = useState<string | null>(null);
  const [status, setStatus] = useState<{
    hasSession: boolean;
    signer: { ready: boolean; diagnostic: string };
    browserRunning: boolean;
    ipBlocked?: { blocked: boolean; message: string };
  } | null>(null);

  async function load() {
    try {
      const [h, d, s, e, st] = await Promise.all([
        api.get<Health>('/api/health'),
        api.get<Draft[]>('/api/drafts'),
        api.get<Source[]>('/api/sources'),
        api.get<EventRow[]>('/api/events'),
        api.get<typeof status>('/api/login/status'),
      ]);
      setHealth(h);
      setDrafts(d);
      setSources(s);
      setEvents(e);
      setStatus(st);
      setIpBlock(st?.ipBlocked?.blocked ? st.ipBlocked.message : null);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);

  // 拿到二维码后轮询登录状态
  useEffect(() => {
    if (!qr) return;
    const t = setInterval(async () => {
      try {
        const st = await api.get<{ hasSession: boolean }>('/api/login/status');
        if (st.hasSession) {
          setQr(null);
          toast('扫码登录成功');
          void load();
        }
      } catch {
        /* 忽略 */
      }
    }, 3000);
    return () => clearInterval(t);
  }, [qr]);

  async function startLogin() {
    setQrBusy(true);
    try {
      const res = await fetch('/api/login/qr', { method: 'POST' });
      const ctype = res.headers.get('content-type') ?? '';
      if (!res.ok || !ctype.includes('image/png')) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          alreadyLoggedIn?: boolean;
          detail?: string;
        };
        // 已登录时后端不会去找二维码，这是正常情况不是故障
        if (body.alreadyLoggedIn) {
          toast(body.detail ?? '已经是登录状态');
          void load();
          return;
        }
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      setQr(URL.createObjectURL(blob));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setQrBusy(false);
    }
  }

  async function resetLogin() {
    if (!confirm('清除本地登录态？下次登录需要重新扫码。')) return;
    setQrBusy(true);
    try {
      await api.post('/api/login/reset');
      toast('已清除登录态');
      void load();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setQrBusy(false);
    }
  }

  async function importCookies() {
    if (!cookieInput.trim()) return;
    setQrBusy(true);
    try {
      const res = await api.post<{ ok: boolean; detail: string }>('/api/login/cookies', {
        cookies: cookieInput.trim(),
      });
      toast(res.detail, res.ok ? 'ok' : 'err');
      if (res.ok) setCookieInput('');
      void load();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setQrBusy(false);
    }
  }

  if (loading) return <Spinner />;

  const pending = drafts.filter((d) => d.status === 'pending').length;
  const approved = drafts.filter((d) => d.status === 'approved').length;
  const published = drafts.filter((d) => d.status === 'published').length;
  const totalNotes = sources.reduce((s, x) => s + (x.note_count ?? 0), 0);

  return (
    <div>
      <SectionTitle
        title="总览"
        desc="登录状态、任务队列与内容产出"
        action={
          <button className="btn-ghost" onClick={() => void load()}>
            刷新
          </button>
        }
      />

      {/* 就绪状态 */}
      <Card className="mb-5">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
          <div>
            <div className="flex items-center gap-1.5 text-xs text-ink-500 mb-1.5">
              <Dot ok={Boolean(health?.browser.hasSession)} />
              小红书登录
            </div>
            <div className="text-sm font-medium">
              {health?.browser.hasSession ? '已登录' : '未登录'}
            </div>
            {!health?.browser.hasSession && health?.browser.missingCookies.length ? (
              <div className="text-[11px] text-ink-400 mt-0.5">
                缺 {health.browser.missingCookies.join(' / ')}
              </div>
            ) : null}
          </div>

          <div>
            <div className="flex items-center gap-1.5 text-xs text-ink-500 mb-1.5">
              <Dot ok={Boolean(health?.llmConfigured)} />
              文本模型
            </div>
            <div className="text-sm font-medium truncate">
              {health?.llmConfigured ? health.llm.model : '未配置'}
            </div>
            {health?.llmMissing.map((m) => (
              <div key={m} className="text-[11px] text-amber-600 mt-0.5">
                {m}
              </div>
            ))}
          </div>

          <div>
            <div className="flex items-center gap-1.5 text-xs text-ink-500 mb-1.5">
              <Dot ok={Boolean(health?.signer.ready)} />
              签名器
            </div>
            <div className="text-sm font-medium">已就绪</div>
            <div className="text-[11px] text-ink-400 mt-0.5 truncate" title={health?.signer.diagnostic}>
              {health?.signer.ready ? health.signer.diagnostic : '待浏览器加载后探测'}
            </div>
          </div>

          <div>
            <div className="text-xs text-ink-500 mb-1.5">配图来源</div>
            <div className="text-sm font-medium">
              {health?.stockProviders.length
                ? health.stockProviders.map((p) => p.name).join(' → ')
                : '仅文字排版'}
            </div>
            {health?.stockProviders.some((p) => p.keyless) && (
              <div className="text-[11px] text-ink-400 mt-0.5">
                含免 key 兜底源
              </div>
            )}
          </div>
        </div>

        {ipBlock && (
          <div className="mt-5 rounded-lg bg-amber-50 border border-amber-300 px-4 py-3 text-sm text-amber-800">
            <div className="font-medium mb-1">⚠ 小红书已限制本机 IP</div>
            <div className="text-xs leading-relaxed">{ipBlock}</div>
          </div>
        )}

        {qr ? (
          <div className="mt-5 pt-5 border-t border-ink-100 flex items-center gap-5">
            <img src={qr} alt="登录二维码" className="w-40 h-40 rounded-lg border border-ink-200" />
            <div className="text-sm text-ink-600">
              请用小红书 App 扫码登录。
              <br />
              <span className="text-ink-400 text-xs">
                登录态会保存在本地浏览器 profile 中，重启服务后仍然有效。
              </span>
            </div>
          </div>
        ) : status?.hasSession ? (
          <div className="mt-5 pt-5 border-t border-ink-100 flex items-center gap-3">
            <span className="text-sm text-emerald-700">
              ✓ 已登录，可以直接到「语料库」抓取作者了
            </span>
            <button className="btn-ghost" onClick={() => void resetLogin()} title="清空本地登录态">
              退出登录
            </button>
            <Link to="/studio" className="btn-primary">
              去创作
            </Link>
          </div>
        ) : health?.browser.unknown ? (
          <div className="mt-5 pt-5 border-t border-ink-100 flex items-center gap-3">
            <span className="text-sm text-ink-500">
              登录状态尚未验证（浏览器按需启动，点下面按钮才会打开）
            </span>
            <button className="btn-primary" disabled={qrBusy} onClick={() => void startLogin()}>
              {qrBusy ? '启动中…' : '验证并登录'}
            </button>
          </div>
        ) : (
          <div className="mt-5 pt-5 border-t border-ink-100 space-y-3">
            <div className="flex items-center gap-3">
              <button
                className="btn-primary"
                disabled={qrBusy || Boolean(ipBlock)}
                onClick={() => void startLogin()}
                title={ipBlock ? '本机 IP 被风控，扫码不可用' : undefined}
              >
                {qrBusy ? '正在获取二维码…' : '扫码登录小红书'}
              </button>
              <Link to="/settings" className="btn-ghost">
                检查配置
              </Link>
            </div>

            <details className="text-sm">
              <summary className="cursor-pointer text-ink-500 hover:text-ink-800 select-none">
                或：手动导入 Cookie（IP 被风控时用这条）
              </summary>
              <div className="mt-2">
                <p className="text-[11px] text-ink-500 mb-2 leading-relaxed">
                  在你自己常用的浏览器里登录小红书 → 打开开发者工具 Console →
                  执行 <code className="bg-ink-100 px-1 rounded">copy(document.cookie)</code>
                  → 粘贴到下面。
                </p>
                <textarea
                  className="input h-24 font-mono text-[11px]"
                  placeholder="a1=...; webId=...; web_session=..."
                  value={cookieInput}
                  onChange={(e) => setCookieInput(e.target.value)}
                />
                <button
                  className="btn-ghost mt-2"
                  disabled={qrBusy || !cookieInput.trim()}
                  onClick={() => void importCookies()}
                >
                  {qrBusy ? '导入中…' : '导入 Cookie'}
                </button>
              </div>
            </details>
          </div>
        )}
      </Card>

      {/* 统计 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
        <Stat label="语料来源" value={sources.length} hint={`${totalNotes} 篇笔记`} />
        <Stat label="待审核" value={pending} hint={pending ? '需要你确认' : '暂无'} />
        <Stat label="待发布" value={approved} hint="已通过未发布" />
        <Stat
          label="已发布"
          value={published}
          hint={health?.scheduler.autoPublish ? '自动发布已开' : '手动发布'}
        />
      </div>

      {/* 队列 + 事件 */}
      <div className="grid md:grid-cols-2 gap-5">
        <Card>
          <SectionTitle
            title="最近草稿"
            action={
              <Link to="/drafts" className="text-sm text-accent-500 hover:underline">
                全部 →
              </Link>
            }
          />
          {drafts.length === 0 ? (
            <Empty>还没有草稿。到「语料库」抓取作者后生成。</Empty>
          ) : (
            <div className="space-y-2">
              {drafts.slice(0, 6).map((d) => (
                <Link
                  key={d.id}
                  to={`/drafts/${d.id}`}
                  className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-ink-50"
                >
                  <span className="flex-1 truncate text-sm">{d.title}</span>
                  <StatusBadge status={d.status} />
                </Link>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <SectionTitle title="运行事件" desc="降级、异常与降级链命中记录" />
          {events.length === 0 ? (
            <Empty>暂无事件</Empty>
          ) : (
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {events.slice(0, 20).map((e) => (
                <div key={e.id} className="flex gap-2.5 text-sm">
                  <span
                    className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${
                      e.severity === 'error'
                        ? 'bg-rose-500'
                        : e.severity === 'warn'
                          ? 'bg-amber-500'
                          : 'bg-ink-300'
                    }`}
                  />
                  <div className="min-w-0">
                    <div className="text-ink-700 break-words">{e.message}</div>
                    <div className="text-[11px] text-ink-400">
                      {e.ts} · {e.kind}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}