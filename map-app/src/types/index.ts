export * from './common'

import type { BaseLocation, Nationality } from './common'

// ─── Money Exchange ──────────────────────────────────────────────────────────
export interface ExchangeRate {
  currency: 'USD' | 'JPY' | 'CNY' | 'EUR' | 'GBP' | 'THB'
  buyRate: number   // KRW you get per 1 foreign unit
  sellRate: number  // KRW you pay per 1 foreign unit
}

export interface ExchangeLocation extends BaseLocation {
  category: 'exchange'
  rates: ExchangeRate[]
  noCommission: boolean
  minAmount?: number
}

// ─── Fuel Station ────────────────────────────────────────────────────────────
export interface FuelPrices {
  gasoline?: number   // KRW per liter (휘발유)
  diesel?: number     // KRW per liter (경유)
  lpg?: number        // KRW per liter (LPG)
  electric?: number   // KRW per kWh (전기)
  hydrogen?: number   // KRW per kg (수소)
}

export interface FuelStation extends BaseLocation {
  category: 'fuel'
  brand: string
  prices: FuelPrices
  selfService: boolean
  carWash: boolean
}

// ─── Restaurant ──────────────────────────────────────────────────────────────
export interface MenuItem {
  name: string
  nameEn: string
  price: number
  isVegetarian?: boolean
  isHalal?: boolean
  spicyLevel?: 0 | 1 | 2 | 3
}

export interface Restaurant extends BaseLocation {
  category: 'restaurant'
  nationalityTags: Nationality[]
  menuItems: MenuItem[]
  pricePerPerson: number
  cuisineType: string
  cuisineTypeEn: string
  isHalal: boolean
  isVegetarianFriendly: boolean
  hasEnglishMenu: boolean
  hasChineseMenu: boolean
  hasJapaneseMenu: boolean
}

// ─── Cafe ─────────────────────────────────────────────────────────────────────
export interface CafeItem {
  name: string
  nameEn: string
  price: number
  isBestValue?: boolean
}

export interface Cafe extends BaseLocation {
  category: 'cafe'
  brand: string
  items: CafeItem[]
  americanoPrice: number
  hasWifi: boolean
  hasOutdoorSeating: boolean
}

// ─── Convenience Store ───────────────────────────────────────────────────────
export interface ConvenienceItem {
  name: string
  nameEn: string
  price: number
  category: string
}

export interface ConvenienceStore extends BaseLocation {
  category: 'convenience'
  brand: 'CU' | 'GS25' | '7-Eleven' | 'emart24' | 'Ministop'
  popularItems: ConvenienceItem[]
  avgItemPrice: number
  open24Hours: boolean
  hasAtm: boolean
}

// ─── Jjimjilbang ─────────────────────────────────────────────────────────────
export interface Jjimjilbang extends BaseLocation {
  category: 'jjimjilbang'
  entryFee: number
  overnightFee?: number
  towelIncluded: boolean
  amenities: string[]
  separateGenders: boolean
}

// ─── Karaoke ─────────────────────────────────────────────────────────────────
export interface KaraokeRate {
  roomSize: 'small' | 'medium' | 'large'
  pricePerHour: number
  maxPeople: number
}

export interface Karaoke extends BaseLocation {
  category: 'karaoke'
  rates: KaraokeRate[]
  hasForeignSongs: boolean
  hasTambourine: boolean
  discountHours?: string
}

// ─── Traditional Market ───────────────────────────────────────────────────────
export interface MarketItem {
  name: string
  nameEn: string
  price: number
  unit: string
}

export interface TraditionalMarket extends BaseLocation {
  category: 'market'
  marketType: string
  marketTypeEn: string
  popularItems: MarketItem[]
  operatingDays: string
  closedDay?: string
}

// ─── Tourist Attraction ───────────────────────────────────────────────────────
export interface AttractionTicket {
  type: string
  typeEn: string
  price: number
  ageGroup?: string
}

export interface TouristAttraction extends BaseLocation {
  category: 'attraction'
  attractionType: string
  tickets: AttractionTicket[]
  freeEntry: boolean
  discountInfo?: string
  discountInfoEn?: string
}

// ─── Extra (Street Food, PC Bang, Accommodation) ─────────────────────────────
export type ExtraType = 'streetfood' | 'pcbang' | 'accommodation'

export interface Extra extends BaseLocation {
  category: 'extra'
  extraType: ExtraType
  extraTypeLabel: string
  extraTypeLabelEn: string
  price: number
  priceUnit: string
  priceUnitEn: string
  description: string
  descriptionEn: string
  emoji: string
}

// ─── Union type for all pins ──────────────────────────────────────────────────
export type AnyLocation =
  | ExchangeLocation
  | FuelStation
  | Restaurant
  | Cafe
  | ConvenienceStore
  | Jjimjilbang
  | Karaoke
  | TraditionalMarket
  | TouristAttraction
  | Extra

export interface PriceRank {
  locationId: string
  rank: 1 | 2 | 3
}
