import type {
  AnyLocation, Cafe, ConvenienceStore, Jjimjilbang,
  Karaoke, TraditionalMarket, TouristAttraction, Extra
} from '@/types'
import { useUiStore } from '@/store'

interface Props { location: AnyLocation }

export function GenericDetail({ location }: Props) {
  const { language } = useUiStore()

  switch (location.category) {
    case 'cafe': {
      const loc = location as Cafe
      return (
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            {loc.hasWifi && <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs font-semibold rounded-full">📶 WiFi</span>}
            {loc.hasOutdoorSeating && <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs font-semibold rounded-full">🌿 {language === 'ko' ? '야외석' : 'Outdoor'}</span>}
          </div>
          <div className="flex items-center justify-between bg-amber-50 rounded-xl px-4 py-3">
            <span className="text-sm text-slate-600">{language === 'ko' ? '아메리카노' : 'Americano'}</span>
            <span className="text-xl font-bold text-amber-700">₩{loc.americanoPrice.toLocaleString()}</span>
          </div>
          <div className="space-y-2">
            {loc.items.map((item, i) => (
              <div key={i} className="flex justify-between py-1.5 border-b border-slate-50 last:border-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm text-slate-700">{language === 'ko' ? item.name : item.nameEn}</span>
                  {item.isBestValue && <span className="px-1.5 py-0.5 bg-yellow-100 text-yellow-700 text-xs rounded-full">👑 BEST</span>}
                </div>
                <span className="text-sm font-semibold text-slate-700">₩{item.price.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )
    }

    case 'convenience': {
      const loc = location as ConvenienceStore
      const brandColors: Record<string, string> = {
        CU: 'bg-purple-100 text-purple-700',
        GS25: 'bg-blue-100 text-blue-700',
        '7-Eleven': 'bg-red-100 text-red-700',
        emart24: 'bg-yellow-100 text-yellow-700',
        Ministop: 'bg-green-100 text-green-700',
      }
      return (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className={`px-3 py-1 text-sm font-bold rounded-full ${brandColors[loc.brand] || 'bg-slate-100 text-slate-700'}`}>
              {loc.brand}
            </span>
            {loc.open24Hours && <span className="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs font-medium rounded-full">24H</span>}
            {loc.hasAtm && <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs font-medium rounded-full">🏧 ATM</span>}
          </div>
          <h4 className="text-sm font-semibold text-slate-600">{language === 'ko' ? '인기 상품' : 'Popular Items'}</h4>
          <div className="space-y-2">
            {loc.popularItems.map((item, i) => (
              <div key={i} className="flex justify-between py-1.5 border-b border-slate-50 last:border-0">
                <span className="text-sm text-slate-700">{language === 'ko' ? item.name : item.nameEn}</span>
                <span className="text-sm font-semibold text-slate-700">₩{item.price.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )
    }

    case 'jjimjilbang': {
      const loc = location as Jjimjilbang
      return (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-purple-50 rounded-xl p-3 text-center">
              <div className="text-xs text-purple-600 font-medium">{language === 'ko' ? '입장료' : 'Entry'}</div>
              <div className="text-xl font-bold text-purple-800">₩{loc.entryFee.toLocaleString()}</div>
            </div>
            {loc.overnightFee && (
              <div className="bg-indigo-50 rounded-xl p-3 text-center">
                <div className="text-xs text-indigo-600 font-medium">{language === 'ko' ? '숙박 추가' : 'Overnight'}</div>
                <div className="text-xl font-bold text-indigo-800">+₩{loc.overnightFee.toLocaleString()}</div>
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {loc.towelIncluded && <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs rounded-full">🛁 {language === 'ko' ? '타월 포함' : 'Towel incl.'}</span>}
            {loc.separateGenders && <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded-full">👥 {language === 'ko' ? '남녀 구분' : 'Separate genders'}</span>}
          </div>
          <div>
            <h4 className="text-sm font-semibold text-slate-600 mb-1.5">{language === 'ko' ? '시설' : 'Amenities'}</h4>
            <div className="flex flex-wrap gap-1.5">
              {loc.amenities.map((a, i) => (
                <span key={i} className="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs rounded-full">{a}</span>
              ))}
            </div>
          </div>
        </div>
      )
    }

    case 'karaoke': {
      const loc = location as Karaoke
      const sizeLabel: Record<string, string> = { small: '소 (2-3인)', medium: '중 (4-6인)', large: '대 (10인+)' }
      const sizeLabelEn: Record<string, string> = { small: 'Small (2-3p)', medium: 'Medium (4-6p)', large: 'Large (10p+)' }
      return (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {loc.hasForeignSongs && <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded-full">🎵 {language === 'ko' ? '외국곡 있음' : 'Foreign songs'}</span>}
            {loc.hasTambourine && <span className="px-2 py-0.5 bg-pink-100 text-pink-700 text-xs rounded-full">🥁 {language === 'ko' ? '탬버린 있음' : 'Tambourine'}</span>}
          </div>
          <div className="space-y-2">
            {loc.rates.map((rate, i) => (
              <div key={i} className="flex items-center justify-between bg-pink-50 rounded-xl px-4 py-3">
                <span className="text-sm font-medium text-slate-700">
                  {language === 'ko' ? sizeLabel[rate.roomSize] : sizeLabelEn[rate.roomSize]}
                </span>
                <span className="text-lg font-bold text-pink-700">₩{rate.pricePerHour.toLocaleString()}<span className="text-xs font-normal text-slate-500 ml-1">/h</span></span>
              </div>
            ))}
          </div>
          {loc.discountHours && (
            <div className="flex items-start gap-2 bg-yellow-50 rounded-xl p-3">
              <span>⏰</span>
              <span className="text-xs text-yellow-800">{loc.discountHours}</span>
            </div>
          )}
        </div>
      )
    }

    case 'market': {
      const loc = location as TraditionalMarket
      return (
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="px-2 py-0.5 bg-orange-100 text-orange-700 text-xs rounded-full">
              🏮 {language === 'ko' ? loc.marketType : loc.marketTypeEn}
            </span>
            {loc.closedDay && (
              <span className="px-2 py-0.5 bg-red-100 text-red-700 text-xs rounded-full">
                🚫 {language === 'ko' ? `${loc.closedDay} 휴무` : `Closed: ${loc.closedDay}`}
              </span>
            )}
          </div>
          <div>
            <h4 className="text-sm font-semibold text-slate-600 mb-2">{language === 'ko' ? '인기 상품' : 'Popular Items'}</h4>
            <div className="space-y-2">
              {loc.popularItems.map((item, i) => (
                <div key={i} className="flex items-center justify-between py-1.5 border-b border-slate-50 last:border-0">
                  <span className="text-sm text-slate-700">{language === 'ko' ? item.name : item.nameEn}</span>
                  <span className="text-sm font-semibold text-slate-700">₩{item.price.toLocaleString()} <span className="text-xs text-slate-400">/{item.unit}</span></span>
                </div>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-500 bg-slate-50 rounded-xl p-2">
            <span>📅</span><span>{loc.operatingDays}</span>
            {loc.openHours && <><span>·</span><span>🕐 {loc.openHours}</span></>}
          </div>
        </div>
      )
    }

    case 'attraction': {
      const loc = location as TouristAttraction
      return (
        <div className="space-y-3">
          {loc.discountInfo && (
            <div className="flex items-start gap-2 bg-yellow-50 rounded-xl p-3">
              <span>💡</span>
              <span className="text-xs text-yellow-800">
                {language === 'ko' ? loc.discountInfo : (loc.discountInfoEn ?? loc.discountInfo)}
              </span>
            </div>
          )}
          <div>
            <h4 className="text-sm font-semibold text-slate-600 mb-2">{language === 'ko' ? '입장권' : 'Tickets'}</h4>
            <div className="space-y-2">
              {loc.tickets.map((ticket, i) => (
                <div key={i} className="flex items-center justify-between bg-slate-50 rounded-xl px-3 py-2.5">
                  <span className="text-sm text-slate-700">{language === 'ko' ? ticket.type : ticket.typeEn}</span>
                  <span className={`text-lg font-bold ${ticket.price === 0 ? 'text-green-600' : 'text-slate-800'}`}>
                    {ticket.price === 0 ? (language === 'ko' ? '무료' : 'FREE') : `₩${ticket.price.toLocaleString()}`}
                  </span>
                </div>
              ))}
            </div>
          </div>
          {loc.openHours && (
            <div className="flex items-center gap-2 text-sm text-slate-600">
              <span>🕐</span><span>{loc.openHours}</span>
            </div>
          )}
        </div>
      )
    }

    case 'extra': {
      const loc = location as Extra
      return (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-3xl">{loc.emoji}</span>
            <span className="px-2 py-0.5 bg-indigo-100 text-indigo-700 text-xs font-semibold rounded-full">
              {language === 'ko' ? loc.extraTypeLabel : loc.extraTypeLabelEn}
            </span>
          </div>
          <div className="bg-indigo-50 rounded-xl px-4 py-3 flex items-center justify-between">
            <span className="text-sm text-slate-600">
              {language === 'ko' ? `₩/1${loc.priceUnit}` : `₩/${loc.priceUnitEn}`}
            </span>
            <span className="text-2xl font-bold text-indigo-700">₩{loc.price.toLocaleString()}</span>
          </div>
          <p className="text-sm text-slate-600">
            {language === 'ko' ? loc.description : loc.descriptionEn}
          </p>
        </div>
      )
    }

    default:
      return null
  }
}
