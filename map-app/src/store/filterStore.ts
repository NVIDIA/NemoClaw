import { create } from 'zustand'
import type { PriceCategory, Nationality } from '@/types'

const STORAGE_KEY = 'lowestprice_filters'

interface PersistedFilters {
  activeCategories: PriceCategory[]
  nationality: Nationality
  priceRange: [number, number]
}

function loadFilters(): PersistedFilters {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as PersistedFilters
  } catch {}
  return { activeCategories: [], nationality: 'all', priceRange: [0, 200000] }
}

function saveFilters(state: PersistedFilters) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {}
}

interface FilterState extends PersistedFilters {
  searchQuery: string
  showCheapestOnly: boolean
  toggleCategory: (cat: PriceCategory) => void
  setAllCategories: (cats: PriceCategory[]) => void
  clearCategories: () => void
  setNationality: (nat: Nationality) => void
  setPriceRange: (range: [number, number]) => void
  setSearchQuery: (q: string) => void
  toggleCheapestOnly: () => void
  resetFilters: () => void
}

const initial = loadFilters()

export const useFilterStore = create<FilterState>((set) => ({
  ...initial,
  searchQuery: '',
  showCheapestOnly: false,

  toggleCategory: (cat) =>
    set((state) => {
      const next = state.activeCategories.includes(cat)
        ? state.activeCategories.filter((c) => c !== cat)
        : [...state.activeCategories, cat]
      saveFilters({ activeCategories: next, nationality: state.nationality, priceRange: state.priceRange })
      return { activeCategories: next }
    }),

  setAllCategories: (cats) =>
    set((state) => {
      saveFilters({ activeCategories: cats, nationality: state.nationality, priceRange: state.priceRange })
      return { activeCategories: cats }
    }),

  clearCategories: () =>
    set((state) => {
      saveFilters({ activeCategories: [], nationality: state.nationality, priceRange: state.priceRange })
      return { activeCategories: [] }
    }),

  setNationality: (nat) =>
    set((state) => {
      saveFilters({ activeCategories: state.activeCategories, nationality: nat, priceRange: state.priceRange })
      return { nationality: nat }
    }),

  setPriceRange: (range) =>
    set((state) => {
      saveFilters({ activeCategories: state.activeCategories, nationality: state.nationality, priceRange: range })
      return { priceRange: range }
    }),

  setSearchQuery: (q) => set({ searchQuery: q }),

  toggleCheapestOnly: () =>
    set((state) => ({ showCheapestOnly: !state.showCheapestOnly })),

  resetFilters: () => {
    const defaults: PersistedFilters = { activeCategories: [], nationality: 'all', priceRange: [0, 200000] }
    saveFilters(defaults)
    return set({ ...defaults, searchQuery: '', showCheapestOnly: false })
  },
}))
