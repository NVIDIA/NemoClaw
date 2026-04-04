import type { ExchangeLocation } from '@/types'
import { useUiStore } from '@/store'

const CURRENCY_FLAGS: Record<string, string> = {
  USD: '🇺🇸', JPY: '🇯🇵', CNY: '🇨🇳', EUR: '🇪🇺', GBP: '🇬🇧', THB: '🇹🇭',
}

interface Props { location: ExchangeLocation }

export function ExchangeDetail({ location }: Props) {
  const { language } = useUiStore()
  const sortedRates = [...location.rates].sort((a, b) => b.buyRate - a.buyRate)

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        {location.noCommission && (
          <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs font-semibold rounded-full">
            ✅ {language === 'ko' ? '수수료 없음' : 'No Commission'}
          </span>
        )}
        {location.minAmount !== undefined && location.minAmount === 0 && (
          <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs font-semibold rounded-full">
            💡 {language === 'ko' ? '최소금액 없음' : 'No Minimum'}
          </span>
        )}
      </div>

      <div>
        <h4 className="text-sm font-semibold text-slate-600 mb-2">
          {language === 'ko' ? '환율 (매매기준율)' : 'Exchange Rates'}
        </h4>
        <div className="space-y-2">
          {sortedRates.map((rate) => (
            <div key={rate.currency}
              className="flex items-center justify-between bg-slate-50 rounded-xl px-3 py-2.5"
            >
              <div className="flex items-center gap-2">
                <span className="text-xl">{CURRENCY_FLAGS[rate.currency] ?? '💱'}</span>
                <div>
                  <div className="font-semibold text-slate-800">1 {rate.currency}</div>
                  <div className="text-xs text-slate-400">
                    {language === 'ko' ? '살 때' : 'Buy'} / {language === 'ko' ? '팔 때' : 'Sell'}
                  </div>
                </div>
              </div>
              <div className="text-right">
                <div className="font-bold text-emerald-700">₩{rate.buyRate.toLocaleString()}</div>
                <div className="text-xs text-slate-400">₩{rate.sellRate.toLocaleString()}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {location.openHours && (
        <div className="flex items-center gap-2 text-sm text-slate-600">
          <span>🕐</span>
          <span>{location.openHours}</span>
        </div>
      )}

      {location.minAmount !== undefined && location.minAmount > 0 && (
        <div className="flex items-center gap-2 text-sm text-slate-600">
          <span>💵</span>
          <span>
            {language === 'ko' ? `최소 환전: $${location.minAmount}` : `Min amount: $${location.minAmount}`}
          </span>
        </div>
      )}
    </div>
  )
}
