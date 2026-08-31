import { describe, it, expect } from 'vitest'
import { musicEnvelope } from '../src/chat/pipeline.js'

describe('§5.5 音乐信封 → TG 附件', () => {
  it('play 结果解析为单条附件（含 page_url/play_url）', () => {
    const raw = JSON.stringify({
      status: 'music', action: 'play',
      songs: [{ id: 1, title: '晴天', artist: '周杰伦', pageUrl: 'https://music.163.com/song?id=1', playUrl: 'https://music.163.com/song/media/outer/url?id=1.mp3' }],
    })
    const env = musicEnvelope(raw)
    expect(env?.songs).toHaveLength(1)
    expect(env?.songs[0]).toMatchObject({ kind: 'music', title: '晴天', page_url: 'https://music.163.com/song?id=1' })
  })

  it('非音乐/坏 JSON 返回 undefined（当普通文本走）', () => {
    expect(musicEnvelope('{"status":"other"}')).toBeUndefined()
    expect(musicEnvelope('not json')).toBeUndefined()
    expect(musicEnvelope('{"status":"music","songs":[]}')).toEqual({ songs: [] })
  })

  it('缺 pageUrl 的歌曲被过滤', () => {
    const raw = JSON.stringify({ status: 'music', songs: [{ title: 'x', pageUrl: 'https://x' }, { title: 'y' }] })
    expect(musicEnvelope(raw)?.songs).toHaveLength(1)
  })
})
