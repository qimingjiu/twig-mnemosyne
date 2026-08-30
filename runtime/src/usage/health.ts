/**
 * §9.5 Provider Health Scoring（Welford 在线方差，适配自 cp50/ai-gateway，见 NOTICE.md）。
 * 供路由大脑选 fallback 链参考；数据只在服务端（§9.6 防投毒）。
 */

interface WelfordStat {
  count: number
  mean: number
  m2: number
}

export class ProviderHealthMonitor {
  private stats: Map<string, WelfordStat> = new Map()

  update(provider: string, latency: number, error: boolean): void {
    // 失败样本按 30s 延迟惩罚计入，拉低健康分
    const effective = error ? 30_000 : latency
    const stat = this.stats.get(provider) ?? { count: 0, mean: 0, m2: 0 }
    stat.count++
    const delta = effective - stat.mean
    stat.mean += delta / stat.count
    const delta2 = effective - stat.mean
    stat.m2 += delta * delta2
    this.stats.set(provider, stat)
  }

  getHealthScore(provider: string): number {
    const stat = this.stats.get(provider)
    if (!stat || stat.count < 10) return 0.5

    const avgLatency = stat.mean
    const variance = stat.m2 / stat.count

    const latencyScore = Math.max(0, 1 - avgLatency / 10000)
    const stabilityScore = Math.max(0, 1 - variance / 1000000)

    return latencyScore * 0.6 + stabilityScore * 0.4
  }
}
