/**
 * crontab 与「人话」之间的翻译。
 *
 * crontab 是给机器看的 —— 没人能从 `30 9 * * *` 一眼看出是早上九点半。
 * 界面上只让人选「每天 / 每周几 / 每隔几小时」+ 几点，
 * crontab 本身折叠起来当技术细节显示。
 */

export type Frequency = 'daily' | 'weekly' | 'hourly';

export interface ScheduleParts {
  time: string; // 'HH:MM'
  freq: Frequency;
  days: number[]; // 1=周一 … 7=周日，仅 weekly 用
  everyNHours: number; // 仅 hourly 用
}

const DEFAULT_PARTS: ScheduleParts = {
  time: '09:30',
  freq: 'daily',
  days: [1, 2, 3, 4, 5, 6, 7],
  everyNHours: 4,
};

const DAY_NAMES = ['', '一', '二', '三', '四', '五', '六', '日'];

/** crontab → 表单。仅支持我们能表达的几种形态，认不出来就返回默认值。 */
export function cronToParts(cron: string): ScheduleParts {
  const f = (cron ?? '').trim().split(/\s+/);
  if (f.length !== 5) return { ...DEFAULT_PARTS };

  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];

  // 每天固定时刻：m h * * *
  if (dom === '*' && mon === '*' && dow === '*' && /^\d+$/.test(min) && /^\d+$/.test(hour)) {
    return {
      ...DEFAULT_PARTS,
      freq: 'daily',
      time: `${pad(hour)}:${pad(min)}`,
    };
  }

  // 每周：m h * * d
  if (dom === '*' && mon === '*' && /^\d+$/.test(dow) && /^\d+$/.test(min) && /^\d+$/.test(hour)) {
    return {
      ...DEFAULT_PARTS,
      freq: 'weekly',
      time: `${pad(hour)}:${pad(min)}`,
      days: [Number(dow)],
    };
  }

  // 每隔 N 小时：0 */N * * *
  if (min === '0' && /^\*\/(\d+)$/.test(hour) && dom === '*' && mon === '*' && dow === '*') {
    return { ...DEFAULT_PARTS, freq: 'hourly', everyNHours: Number(RegExp.$1) };
  }

  return { ...DEFAULT_PARTS };
}

/** 表单 → crontab。 */
export function partsToCron(p: ScheduleParts): string {
  if (p.freq === 'hourly') {
    const n = Math.max(1, Math.min(23, Math.round(p.everyNHours) || 4));
    return `0 */${n} * * *`;
  }

  const [h, m] = (p.time || '09:30').split(':');
  const min = String(Math.max(0, Math.min(59, Number(m) || 0))).padStart(2, '0');
  const hour = String(Math.max(0, Math.min(23, Number(h) || 9))).padStart(2, '0');

  if (p.freq === 'weekly') {
    const days = (p.days.length ? p.days : [1]).map((d) => Math.max(0, Math.min(7, d)));
    return `${min} ${hour} * * ${days.join(',')}`;
  }

  return `${min} ${hour} * * *`;
}

/** 一句话说明，界面上直接给人看。 */
export function describeSchedule(p: ScheduleParts): string {
  if (p.freq === 'hourly') {
    const n = Math.max(1, p.everyNHours);
    return `每隔 ${n} 小时执行一次`;
  }
  if (p.freq === 'weekly') {
    const days = (p.days.length ? p.days : [1]).map((d) => `周${DAY_NAMES[d] ?? d}`).join('、');
    return `${days} ${p.time} 执行`;
  }
  return `每天 ${p.time} 执行`;
}

/** 下次运行时间的自然语言表述。 */
export function describeNext(iso: string | null): string {
  if (!iso) return '未排期';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '未排期';

  const diff = d.getTime() - Date.now();
  if (diff < 0) return '即将执行';

  const mins = Math.round(diff / 60000);
  let rel: string;
  if (mins < 60) rel = `${mins} 分钟后`;
  else if (mins < 60 * 24) rel = `${Math.floor(mins / 60)} 小时 ${mins % 60} 分后`;
  else rel = `${Math.floor(mins / 1440)} 天后`;

  return `${d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })}（${rel}）`;
}

function pad(n: string | number): string {
  return String(Number(n)).padStart(2, '0');
}
