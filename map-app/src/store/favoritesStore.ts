import { create } from 'zustand'

const STORAGE_KEY = 'lowestprice_favorites'

function loadFavorites(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as string[]
  } catch {}
  return []
}

function saveFavorites(ids: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch {}
}

interface FavoritesState {
  favoriteIds: string[]
  isFavorite: (id: string) => boolean
  toggle: (id: string) => void
  clear: () => void
}

export const useFavoritesStore = create<FavoritesState>((set, get) => ({
  favoriteIds: loadFavorites(),

  isFavorite: (id) => get().favoriteIds.includes(id),

  toggle: (id) =>
    set((state) => {
      const next = state.favoriteIds.includes(id)
        ? state.favoriteIds.filter((f) => f !== id)
        : [...state.favoriteIds, id]
      saveFavorites(next)
      return { favoriteIds: next }
    }),

  clear: () => {
    saveFavorites([])
    set({ favoriteIds: [] })
  },
}))
