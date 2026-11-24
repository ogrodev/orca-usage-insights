// Display names per provider (the `provider` column of a usage record), for the panel, the worker and
// Explain prompts. Pure, and bundled into the panel by scripts/build.mjs. A provider added to the
// scanner gets its name here.
export const PROVIDER_LABELS = Object.freeze({ claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' })

const OMP_PROVIDER_NAMES = Object.freeze({
  anthropic: 'Anthropic',
  'openai-codex': 'OpenAI Codex',
  openai: 'OpenAI',
  'ollama-cloud': 'Ollama Cloud',
  openrouter: 'OpenRouter',
  typesafe: 'TypeSafe',
  'kimi-code': 'Kimi Code',
  zai: 'Z.ai',
  google: 'Google',
  'google-gemini-cli': 'Gemini CLI',
  'github-copilot': 'GitHub Copilot',
})

export function ompProviderName(id) {
  if (Object.hasOwn(OMP_PROVIDER_NAMES, id)) return OMP_PROVIDER_NAMES[id]
  return String(id).split(/[-_]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ') || 'Unknown'
}

export function providerLabel(provider, fallback = provider) {
  if (Object.hasOwn(PROVIDER_LABELS, provider)) return PROVIDER_LABELS[provider]
  if (typeof provider === 'string' && provider.startsWith('omp:')) return `OMP · ${ompProviderName(provider.slice(4))}`
  return fallback
}

export function accountLabel(raw, labels) {
  const known = labels?.get?.(raw)
  if (known) return known
  const match = /^(.*)\/(.*)#(\d+)$/.exec(String(raw))
  return match ? `${ompProviderName(match[2])} · ${match[1]} #${match[3]}` : String(raw)
}
