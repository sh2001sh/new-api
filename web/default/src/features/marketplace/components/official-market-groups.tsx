import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { getMarketplaceAutoRoutePool, getMarketplaceRoutePool } from '../api'
import {
  useMarketplaceAutoRoutePool,
  useMarketplaceAutoRoutePoolUpdate,
  useMarketplaceRoutePool,
  useMarketplaceRoutePoolUpdate,
} from '../hooks'
import { selectedAutoRoutePoolGroupIDs } from '../lib/auto-route-pool'
import type { MarketplaceAutoRoutePoolItem } from '../types'

// Official IDs come from the routing catalog, not marketplace channel IDs.
export function OfficialMarketGroups(props: { poolID: string; enabled?: boolean }) {
  const { t } = useTranslation()
  const catalog = useMarketplaceAutoRoutePool(props.enabled ?? true)
  const isAuto = props.poolID === 'auto'
  const pool = useMarketplaceRoutePool(isAuto ? '' : props.poolID)
  const updateAuto = useMarketplaceAutoRoutePoolUpdate()
  const updatePool = useMarketplaceRoutePoolUpdate()
  const [pending, setPending] = useState(false)
  const target = isAuto ? catalog : pool
  const selected = new Set(selectedAutoRoutePoolGroupIDs(target.data?.items ?? []))
  const items = (catalog.data?.items ?? []).filter((item) => item.source_type === 'official')

  const add = async (item: MarketplaceAutoRoutePoolItem) => {
    setPending(true)
    try {
      // Refresh before replacing membership so adding an official group preserves
      // existing marketplace members, their order, and the saved pool strategy.
      const latest = isAuto
        ? await getMarketplaceAutoRoutePool()
        : await getMarketplaceRoutePool(props.poolID)
      const ids = selectedAutoRoutePoolGroupIDs(latest.items)
      if (ids.includes(item.group_id)) return
      if (ids.length >= 10) throw new Error(t('路由池最多可添加 10 个分组'))
      if (latest.config.max_multiplier > 0 && item.multiplier > latest.config.max_multiplier) {
        throw new Error(t('该分组倍率超过当前路由池上限'))
      }
      const values = { groupIds: [...ids, item.group_id], config: latest.config }
      if (isAuto) await updateAuto.mutateAsync(values)
      else await updatePool.mutateAsync({ id: props.poolID, ...values })
      toast.success(t('已将官方分组加入路由池'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('加入路由池失败'))
    } finally {
      setPending(false)
    }
  }

  if (props.enabled === false) return null
  return (
    <section className='border-border bg-card mb-4 rounded-lg border p-4'>
      <h3 className='font-semibold'>{t('官方分组')}</h3>
      <p className='text-muted-foreground mt-1 text-xs'>{t('显示当前账号可用的官方分组，可与市场渠道一起加入路由池。')}</p>
      {catalog.isLoading && <p role='status'>{t('正在加载官方分组…')}</p>}
      {catalog.isError && <Button variant='outline' onClick={() => void catalog.refetch()}>{t('官方分组加载失败，点击重试')}</Button>}
      {!catalog.isLoading && !catalog.isError && items.length === 0 && (
        <p className='text-muted-foreground mt-3 text-sm'>{t('当前账号暂无含可用模型的官方分组。')}</p>
      )}
      {items.map((item) => (
        <div key={item.group_id} className='border-border mt-3 flex flex-wrap items-start justify-between gap-3 border-t pt-3'>
          <div className='min-w-0 flex-1'>
            <div className='font-medium'>{item.system_display_name} · {item.multiplier}×</div>
            <p className='text-muted-foreground text-xs'>{item.source_label}</p>
            <details className='mt-2 text-xs'>
              <summary className='cursor-pointer'>{t('查看 {{count}} 个模型', { count: item.models.length })}</summary>
              <p className='mt-2 break-words'>{item.models.join(', ')}</p>
            </details>
          </div>
          <Button size='sm' variant='outline' disabled={!props.poolID || pending || target.isFetching || target.isError || selected.has(item.group_id)} onClick={() => void add(item)}>
            {selected.has(item.group_id) ? t('已在当前路由池') : t('加入当前路由池')}
          </Button>
        </div>
      ))}
      {!props.poolID && <p className='text-muted-foreground mt-3 text-xs'>{t('请先创建或选择路由池。')}</p>}
      {target.isError && props.poolID && <Button variant='outline' onClick={() => void target.refetch()}>{t('路由池加载失败，点击重试')}</Button>}
    </section>
  )
}
