export type PriceCategory =
  | 'exchange'
  | 'fuel'
  | 'restaurant'
  | 'cafe'
  | 'convenience'
  | 'jjimjilbang'
  | 'karaoke'
  | 'market'
  | 'attraction'
  | 'extra'

export type Nationality =
  | 'all'
  | 'korean'
  | 'japanese'
  | 'chinese'
  | 'western'
  | 'indian'
  | 'halal'
  | 'vegan'

export type Language = 'ko' | 'en'

export interface BaseLocation {
  id: string
  name: string
  nameEn: string
  lat: number
  lng: number
  address: string
  addressEn?: string
  category: PriceCategory
  rating?: number
  phone?: string
  website?: string
  openHours?: string
}

export interface CategoryMeta {
  id: PriceCategory
  label: string
  labelEn: string
  emoji: string
  color: string
  bgColor: string
  borderColor: string
}

export const CATEGORY_META: Record<PriceCategory, CategoryMeta> = {
  exchange: {
    id: 'exchange',
    label: '환전소',
    labelEn: 'Exchange',
    emoji: '💱',
    color: '#D97706',
    bgColor: 'bg-yellow-100',
    borderColor: 'border-yellow-400',
  },
  fuel: {
    id: 'fuel',
    label: '주유소',
    labelEn: 'Fuel',
    emoji: '⛽',
    color: '#16A34A',
    bgColor: 'bg-green-100',
    borderColor: 'border-green-400',
  },
  restaurant: {
    id: 'restaurant',
    label: '식당',
    labelEn: 'Restaurant',
    emoji: '🍜',
    color: '#DC2626',
    bgColor: 'bg-red-100',
    borderColor: 'border-red-400',
  },
  cafe: {
    id: 'cafe',
    label: '카페',
    labelEn: 'Cafe',
    emoji: '☕',
    color: '#92400E',
    bgColor: 'bg-amber-100',
    borderColor: 'border-amber-700',
  },
  convenience: {
    id: 'convenience',
    label: '편의점',
    labelEn: 'Convenience',
    emoji: '🏪',
    color: '#2563EB',
    bgColor: 'bg-blue-100',
    borderColor: 'border-blue-400',
  },
  jjimjilbang: {
    id: 'jjimjilbang',
    label: '찜질방',
    labelEn: 'Sauna',
    emoji: '🛁',
    color: '#7C3AED',
    bgColor: 'bg-purple-100',
    borderColor: 'border-purple-400',
  },
  karaoke: {
    id: 'karaoke',
    label: '노래방',
    labelEn: 'Karaoke',
    emoji: '🎤',
    color: '#DB2777',
    bgColor: 'bg-pink-100',
    borderColor: 'border-pink-400',
  },
  market: {
    id: 'market',
    label: '전통시장',
    labelEn: 'Market',
    emoji: '🏮',
    color: '#EA580C',
    bgColor: 'bg-orange-100',
    borderColor: 'border-orange-400',
  },
  attraction: {
    id: 'attraction',
    label: '관광명소',
    labelEn: 'Attraction',
    emoji: '🏛️',
    color: '#0891B2',
    bgColor: 'bg-cyan-100',
    borderColor: 'border-cyan-400',
  },
  extra: {
    id: 'extra',
    label: '기타',
    labelEn: 'More',
    emoji: '✨',
    color: '#4F46E5',
    bgColor: 'bg-indigo-100',
    borderColor: 'border-indigo-400',
  },
}

export const NATIONALITY_META: Record<Nationality, { label: string; labelEn: string; flag: string }> = {
  all: { label: '전체', labelEn: 'All', flag: '🌍' },
  korean: { label: '한국인', labelEn: 'Korean', flag: '🇰🇷' },
  japanese: { label: '일본인', labelEn: 'Japanese', flag: '🇯🇵' },
  chinese: { label: '중국인', labelEn: 'Chinese', flag: '🇨🇳' },
  western: { label: '서양인', labelEn: 'Western', flag: '🇺🇸' },
  indian: { label: '인도인', labelEn: 'Indian', flag: '🇮🇳' },
  halal: { label: '무슬림', labelEn: 'Muslim/Halal', flag: '🕌' },
  vegan: { label: '비건', labelEn: 'Vegan', flag: '🌱' },
}
