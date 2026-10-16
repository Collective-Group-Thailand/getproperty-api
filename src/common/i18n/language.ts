export const SUPPORTED_LANGUAGES = ['th', 'en'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];
/** Thai by default (contract §3 "Localisation"). */
export const DEFAULT_LANGUAGE: Language = 'th';

/** Picks the best supported language from an `Accept-Language` header, honouring q-values. */
export function resolveLanguage(acceptLanguage: string | string[] | undefined): Language {
  const header = Array.isArray(acceptLanguage) ? acceptLanguage.join(',') : acceptLanguage;
  if (!header) return DEFAULT_LANGUAGE;

  const ranked = header
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const quality = q ? Number(q.slice(2)) : 1;
      return {
        base: tag.toLowerCase().split('-')[0] ?? '',
        quality: Number.isNaN(quality) ? 0 : quality,
        index,
      };
    })
    .filter((entry) => entry.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);

  const match = ranked.find((entry) => (SUPPORTED_LANGUAGES as readonly string[]).includes(entry.base));
  return (match?.base as Language | undefined) ?? DEFAULT_LANGUAGE;
}
