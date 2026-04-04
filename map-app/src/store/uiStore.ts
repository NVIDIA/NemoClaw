import { create } from 'zustand'
import type { AnyLocation, Language } from '@/types'

interface UiState {
  selectedPin: AnyLocation | null
  isPanelOpen: boolean
  language: Language
  isMobile: boolean
  setSelectedPin: (pin: AnyLocation | null) => void
  closePanl: () => void
  toggleLanguage: () => void
  setIsMobile: (v: boolean) => void
}

export const useUiStore = create<UiState>((set) => ({
  selectedPin: null,
  isPanelOpen: false,
  language: 'ko',
  isMobile: window.innerWidth < 768,

  setSelectedPin: (pin) =>
    set({ selectedPin: pin, isPanelOpen: pin !== null }),

  closePanl: () => set({ selectedPin: null, isPanelOpen: false }),

  toggleLanguage: () =>
    set((state) => ({ language: state.language === 'ko' ? 'en' : 'ko' })),

  setIsMobile: (v) => set({ isMobile: v }),
}))
