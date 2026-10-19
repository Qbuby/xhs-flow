/**
 * 只重建 style_profiles（不清蒸馏）。
 *   node server/dist/diagnostics/rebuild-profile.js [sourceId]
 */
import { buildStyleProfile, getStyleProfile } from '../corpus/profile.js';

const sourceId = Number(process.argv[2] ?? 10);
const profile = await buildStyleProfile(sourceId);
const spec = (profile?.card_template_spec ?? {}) as { account_template?: unknown };
console.log('account_template =', JSON.stringify(spec.account_template ?? null));

const stored = getStyleProfile(sourceId);
const storedSpec = (stored?.profile?.card_template_spec ?? {}) as { account_template?: unknown };
console.log('库里 account_template =', JSON.stringify(storedSpec.account_template ?? null));
process.exit(0);
