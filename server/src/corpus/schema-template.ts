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
  return '…';
}
