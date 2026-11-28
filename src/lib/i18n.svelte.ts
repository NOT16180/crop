import {
  detectLocale,
  formatMessage,
  isSupportedLocale,
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  type Locale,
  type MessageKey,
} from './i18n-dict'

export { LOCALE_LABELS, SUPPORTED_LOCALES, type Locale, type MessageKey }

const STORAGE_KEY = 'crop-locale'

function readInitialLocale(): Locale {
  try {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
    if (isSupportedLocale(saved)) return saved
  } catch {
    // Private browsing or storage unavailable
  }
  return detectLocale()
}

const initialLocale = readInitialLocale()
let currentLocale = $state<Locale>(initialLocale)

function applyDocumentLang(locale: Locale) {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale
  }
}

applyDocumentLang(initialLocale)

export function getLocale(): Locale {
  return currentLocale
}

export function setLocale(next: Locale): void {
  if (!isSupportedLocale(next)) return
  currentLocale = next
  applyDocumentLang(next)
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // Ignore storage quota / private mode failures
  }
}

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  return formatMessage(currentLocale, key, vars)
}
