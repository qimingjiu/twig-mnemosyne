/**
 * TG sendAudio 本地文件上传测试
 * 用法：BOT_TOKEN=xxx CHAT_ID=123456 node test-sendAudio.mjs
 */

import { readFileSync } from 'node:fs'
import { FormData } from 'node:formdata'

const TOKEN = process.env.BOT_TOKEN
const CHAT_ID = process.env.CHAT_ID
const FILE = process.env.FILE || './test-music.mp3'

if (!TOKEN || !CHAT_ID) {
  console.error('Usage: BOT_TOKEN=xxx CHAT_ID=123456 node test-sendAudio.mjs')
  process.exit(1)
}

const form = new FormData()
form.append('chat_id', CHAT_ID)
form.append('audio', new Blob([readFileSync(FILE)], { type: 'audio/mpeg' }), 'BonDance.mp3')
form.append('title', 'BonDance')
form.append('performer', 'Test Artist')
form.append('caption', '🎵 测试本地文件上传')

const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendAudio`, {
  method: 'POST',
  body: form,
})

const data = await res.json()
console.log('Status:', res.status)
console.log('OK:', data.ok)
if (data.ok) {
  console.log('Message ID:', data.result?.message_id)
  console.log('Audio file_id:', data.result?.audio?.file_id)
  console.log('Duration:', data.result?.audio?.duration, 'seconds')
} else {
  console.error('Error:', data.error_code, data.description)
}
