import { useMemo } from 'react'
import { useAllLocations } from './useAllLocations'
import { getLocationPrice } from './useFilteredMarkers'
import type { PriceRank, PriceCategory } from '@/types'

export function usePriceRanks(category: PriceCategory): PriceRank[] {
  const all = useAllLocations()

  return useMemo(() => {
    const filtered = all
      .filter((loc) => loc.category === category)
      .map((loc) => ({ id: loc.id, price: getLocationPrice(loc) }))
      .filter((item) => item.price > 0)
      .sort((a, b) => a.price - b.price)

    return filtered.slice(0, 3).map((item, i) => ({
      locationId: item.id,
      rank: (i + 1) as 1 | 2 | 3,
    }))
  }, [all, category])
}
