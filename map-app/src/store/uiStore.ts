import { create } from 'zustand'
import type { AnyLocation, Language } from '@/types'

const LANG_KEY = 'lowestprice_lang'

function loadLanguage(): Language {
  try {
    const v = localStorage.getItem(LANG_KEY)
    if (v === 'ko' || v === 'en') return v
  } catch {}
  return 'ko'
}

interface UiState {
  selectedPin: AnyLocation | null
  isPanelOpen: boolean
  language: Language
  isMobile: boolean
  setSelectedPin: (pin: AnyLocation | null) => void
  closePanel: () => void
  toggleLanguage: () => void
  setIsMobile: (v: boolean) => void
}

export const useUiStore = create<UiState>((set) => ({
  selectedPin: null,
  isPanelOpen: false,
  language: loadLanguage(),
  isMobile: window.innerWidth < 768,

  setSelectedPin: (pin) =>
    set({ selectedPin: pin, isPanelOpen: pin !== null }),

  closePanel: () => set({ selectedPin: null, isPanelOpen: false }),

  toggleLanguage: () =>
    set((state) => {
      const next = state.language === 'ko' ? 'en' : 'ko'
      try { localStorage.setItem(LANG_KEY, next) } catch {}
      return { language: next }
    }),

  setIsMobile: (v) => set({ isMobile: v }),
}))
