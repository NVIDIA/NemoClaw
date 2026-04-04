import type { FuelStation } from '@/types'
import { useUiStore } from '@/store'

const FUEL_META = {
  gasoline: { label: '휘발유', labelEn: 'Gasoline', unit: '/L', emoji: '⛽', color: 'text-green-700', bg: 'bg-green-50' },
  diesel: { label: '경유', labelEn: 'Diesel', unit: '/L', emoji: '🛢️', color: 'text-blue-700', bg: 'bg-blue-50' },
  lpg: { label: 'LPG', labelEn: 'LPG', unit: '/L', emoji: '🔵', color: 'text-purple-700', bg: 'bg-purple-50' },
  electric: { label: '전기', labelEn: 'Electric', unit: '/kWh', emoji: '⚡', color: 'text-yellow-700', bg: 'bg-yellow-50' },
  hydrogen: { label: '수소', labelEn: 'Hydrogen', unit: '/kg', emoji: '💧', color: 'text-cyan-700', bg: 'bg-cyan-50' },
}

interface Props { location: FuelStation }

export function FuelDetail({ location }: Props) {
  const { language } = useUiStore()
  const entries = Object.entries(location.prices).filter(([, v]) => v !== undefined) as [keyof typeof FUEL_META, number][]

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        {location.selfService && (
          <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs font-semibold rounded-full">
            🔧 {language === 'ko' ? '셀프주유' : 'Self-service'}
          </span>
        )}
        {location.carWash && (
          <span className="px-2 py-0.5 bg-cyan-100 text-cyan-700 text-xs font-semibold rounded-full">
            🚿 {language === 'ko' ? '세차장' : 'Car wash'}
          </span>
        )}
      </div>

      <div>
        <h4 className="text-sm font-semibold text-slate-600 mb-2">
          {language === 'ko' ? '연료 가격' : 'Fuel Prices'}
        </h4>
        <div className="grid grid-cols-2 gap-2">
          {entries.map(([type, price]) => {
            const meta = FUEL_META[type]
            return (
              <div key={type} className={`${meta.bg} rounded-xl p-3 flex flex-col gap-1`}>
                <div className="flex items-center gap-1.5">
                  <span className="text-xl">{meta.emoji}</span>
                  <span className="text-xs font-medium text-slate-600">
                    {language === 'ko' ? meta.label : meta.labelEn}
                  </span>
                </div>
                <div className={`text-xl font-bold ${meta.color}`}>
                  ₩{price.toLocaleString()}
                  <span className="text-xs font-normal text-slate-500 ml-1">{meta.unit}</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="bg-slate-50 rounded-xl p-3">
        <div className="text-sm font-medium text-slate-700">{location.brand}</div>
        <div className="text-xs text-slate-500 mt-0.5">{location.address}</div>
      </div>
    </div>
  )
}
