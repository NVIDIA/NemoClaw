import { create } from 'zustand'
import type { PriceCategory, Nationality } from '@/types'

interface FilterState {
  activeCategories: PriceCategory[]
  nationality: Nationality
  priceRange: [number, number]
  searchQuery: string
  toggleCategory: (cat: PriceCategory) => void
  setAllCategories: (cats: PriceCategory[]) => void
  clearCategories: () => void
  setNationality: (nat: Nationality) => void
  setPriceRange: (range: [number, number]) => void
  setSearchQuery: (q: string) => void
}

export const useFilterStore = create<FilterState>((set) => ({
  activeCategories: [],
  nationality: 'all',
  priceRange: [0, 200000],
  searchQuery: '',

  toggleCategory: (cat) =>
    set((state) => ({
      activeCategories: state.activeCategories.includes(cat)
        ? state.activeCategories.filter((c) => c !== cat)
        : [...state.activeCategories, cat],
    })),

  setAllCategories: (cats) => set({ activeCategories: cats }),

  clearCategories: () => set({ activeCategories: [] }),

  setNationality: (nat) => set({ nationality: nat }),

  setPriceRange: (range) => set({ priceRange: range }),

  setSearchQuery: (q) => set({ searchQuery: q }),
}))
