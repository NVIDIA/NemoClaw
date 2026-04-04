import { useMemo } from 'react'
import { useFilterStore } from '@/store'
import { useAllLocations } from './useAllLocations'
import type { AnyLocation, PriceCategory, Restaurant } from '@/types'

function getLocationPrice(loc: AnyLocation): number {
  switch (loc.category) {
    case 'exchange': return 0 // show all exchange shops
    case 'fuel': {
      const prices = Object.values(loc.prices).filter(Boolean) as number[]
      return prices.length ? Math.min(...prices) : 0
    }
    case 'restaurant': return loc.pricePerPerson
    case 'cafe': return loc.americanoPrice
    case 'convenience': return loc.avgItemPrice
    case 'jjimjilbang': return loc.entryFee
    case 'karaoke': {
      const rates = loc.rates.map((r) => r.pricePerHour)
      return Math.min(...rates)
    }
    case 'market': {
      const prices = loc.popularItems.map((i) => i.price)
      return Math.min(...prices)
    }
    case 'attraction': {
      const paid = loc.tickets.filter((t) => t.price > 0)
      return paid.length ? Math.min(...paid.map((t) => t.price)) : 0
    }
    case 'extra': return loc.price
    default: return 0
  }
}

const ALL_CATEGORIES: PriceCategory[] = [
  'exchange', 'fuel', 'restaurant', 'cafe', 'convenience',
  'jjimjilbang', 'karaoke', 'market', 'attraction', 'extra',
]

function getCheapestIdsByCategory(all: AnyLocation[]): Set<string> {
  const cheapestIds = new Set<string>()
  ALL_CATEGORIES.forEach((cat) => {
    const catLocs = all
      .filter((loc) => loc.category === cat)
      .map((loc) => ({ id: loc.id, price: getLocationPrice(loc) }))
    if (catLocs.length === 0) return
    // For exchange (price=0), just take first; otherwise sort by price
    const sorted = catLocs.filter((l) => l.price > 0).sort((a, b) => a.price - b.price)
    if (sorted.length > 0) {
      cheapestIds.add(sorted[0].id)
    } else {
      // all free (e.g. free attractions) — take first
      cheapestIds.add(catLocs[0].id)
    }
  })
  return cheapestIds
}

export function useFilteredMarkers(): AnyLocation[] {
  const { activeCategories, nationality, priceRange, searchQuery, showCheapestOnly } = useFilterStore()
  const all = useAllLocations()

  return useMemo(() => {
    const cheapestIds = showCheapestOnly ? getCheapestIdsByCategory(all) : null

    const q = searchQuery.trim().toLowerCase()

    return all.filter((loc) => {
      // Category filter
      if (activeCategories.length > 0 && !activeCategories.includes(loc.category)) {
        return false
      }

      // Nationality filter (only for restaurants)
      if (nationality !== 'all' && loc.category === 'restaurant') {
        const rest = loc as Restaurant
        if (!rest.nationalityTags.includes(nationality) && !rest.nationalityTags.includes('all')) {
          return false
        }
      }

      // Price range filter
      const price = getLocationPrice(loc)
      if (price > 0 && (price < priceRange[0] || price > priceRange[1])) {
        return false
      }

      // Search filter
      if (q) {
        const name = loc.name.toLowerCase()
        const nameEn = loc.nameEn.toLowerCase()
        const address = loc.address.toLowerCase()
        if (!name.includes(q) && !nameEn.includes(q) && !address.includes(q)) {
          return false
        }
      }

      // Cheapest only filter
      if (cheapestIds && !cheapestIds.has(loc.id)) {
        return false
      }

      return true
    })
  }, [all, activeCategories, nationality, priceRange, searchQuery, showCheapestOnly])
}

export { getLocationPrice }
