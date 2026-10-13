import type { z } from 'zod';

/**
 * 把 zod schema 展开成「填空模板」，直接塞进 prompt。
 *
 * 只写一句「按 JSON schema 输出」完全没用 —— 模型不知道你的 schema 长什么样，
 * 会自己发明一套字段名（实测返回过 {title:{core_function:...}} 这种），
 * 数据能存下来但后面全对不上。给模板比讲道理有效得多。
 */
export function asTemplate(schema: z.ZodTypeAny): unknown {
  const def = (schema as unknown as { _def?: Record<string, unknown> })._def ?? {};
  const typeName = def['typeName'] as string | undefined;

  if (typeName === 'ZodObject') {
    const shape = (schema as unknown as { shape: Record<string, z.ZodTypeAny> }).shape;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(shape)) out[k] = asTemplate(v);
    return out;
  }
  if (typeName === 'ZodArray') return [asTemplate(def['type'] as z.ZodTypeAny)];
  if (typeName === 'ZodOptional' || typeName === 'ZodNullable') {
    return asTemplate(def['innerType'] as z.ZodTypeAny);
  }
  if (typeName === 'ZodEnum') return def['values'];
  // 联合类型只拿第一个分支做模板。
  //
  // 用途：`card_template_spec` 声明成「新契约 OR 旧 18 字段」—— 这样历史画像
  // 还能解析出来，但**提示词里只给新契约的形状**，模型就不会再产出旧形状。
  // 不这样处理的话 asTemplate 会退化成 "…"，模型又只能自己发明字段名。
  if (typeName === 'ZodUnion') {
    const options = (def['options'] as z.ZodTypeAny[] | undefined) ?? [];
    return options[0] ? asTemplate(options[0]) : '…';
  }
  return '…';
}
