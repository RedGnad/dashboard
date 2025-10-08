// Minimal i18n scaffolding (EN/FR) for future UI / CLI messages.
// Usage: t('key', 'fr') or set DEFAULT_LANG.

export type Lang = 'en' | 'fr'

const messages: Record<Lang, Record<string, string>> = {
  en: {
    verification_pass: 'Verification PASS',
    verification_fail: 'Verification FAIL',
    guardrails_blocked: 'Execution blocked by guardrails',
    guardrails_clear: 'Guardrails clear',
    feature_hash_mismatch: 'Feature hash mismatch',
    building_proof_pack: 'Building proof pack',
    proof_pack_ok: 'Proof pack OK',
  },
  fr: {
    verification_pass: 'Vérification OK',
    verification_fail: 'Vérification ÉCHEC',
    guardrails_blocked: 'Exécution bloquée par guardrails',
    guardrails_clear: 'Guardrails OK',
    feature_hash_mismatch: 'Mismatch hash des features',
    building_proof_pack: 'Construction du proof pack',
    proof_pack_ok: 'Proof pack valide',
  },
}

export const DEFAULT_LANG: Lang = 'en'

export function t(key: string, lang: Lang = DEFAULT_LANG): string {
  const table = messages[lang] || messages[DEFAULT_LANG]
  return table[key] || key
}

export function listI18nKeys(): string[] {
  return Array.from(new Set(Object.values(messages).flatMap(o => Object.keys(o)))).sort()
}
