import { Hono } from 'hono/quick'
import { cache } from 'hono/cache'
import { sha256 } from 'hono/utils/crypto'
import { basicAuth } from 'hono/basic-auth'
import { getExtension } from 'hono/utils/mime'

type Bindings = {
  BUCKET: R2Bucket
  USER: string
  PASS: string
}

const maxAge = 60 * 60 * 24 * 30
const app = new Hono<{ Bindings: Bindings }>()

app.put('/upload', async (c, next) => {
  const auth = basicAuth({ username: c.env.USER, password: c.env.PASS })
  await auth(c, next)
})

app.put('/upload', async (c) => {
  const data = await c.req.parseBody<{ 
    image: File
    width?: string
    height?: string
    timestamp?: string  // "true" or "false"
    sha256?: string     // "true" or "false"
  }>()
  
  const file = data.image
  const type = file.type
  const useTimestamp = data.timestamp === 'true'
  const useSha256 = data.sha256 === 'true'
  
  const nameParts = file.name.split('.')
  const extension = nameParts.pop() || 'png'
  const basename = nameParts.join('.')
  
  let key = file.name  // デフォルトは元のファイル名
  
  // SHA256オプション、タイムスタンプオプション、またはその両方
  if (useSha256 || useTimestamp) {
    const parts = []
    parts.push(basename)
    
    // SHA256ハッシュを追加（最初の8文字）
    if (useSha256) {
      const hash = (await sha256(file)).substring(0, 8)
      parts.push(hash)
    }
    
    // タイムスタンプとランダム文字列を追加
    if (useTimestamp) {
      const timestamp = Date.now()
      const random = Math.random().toString(36).substring(2, 8)
      parts.push(`${timestamp}_${random}`)
    }
    
    key = `${parts.join('_')}.${extension}`
  }
  
  // widthとheightが指定されている場合
  if (data.width && data.height) {
    const keyParts = key.split('.')
    const ext = keyParts.pop()
    const base = keyParts.join('.')
    key = `${base}_${data.width}x${data.height}.${ext}`
  }
  
  await c.env.BUCKET.put(key, file, { httpMetadata: { contentType: type } })
  return c.text(key)
})

app.get(
  '*',
  cache({
    cacheName: 'r2-image-worker'
  })
)

app.get('/:key', async (c) => {
  const key = c.req.param('key')
  const object = await c.env.BUCKET.get(key)
  if (!object) return c.notFound()
  const data = await object.arrayBuffer()
  const contentType = object.httpMetadata?.contentType ?? ''
  return c.body(data, 200, {
    'Cache-Control': `public, max-age=${maxAge}`,
    'Content-Type': contentType
  })
})

export default app
