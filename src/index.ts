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

// PUTエンドポイント
app.put('/upload', async (c, next) => {
  const auth = basicAuth({ username: c.env.USER, password: c.env.PASS })
  await auth(c, next)
})

app.put('/upload', async (c) => {
  const data = await c.req.parseBody<{
    image: File
    width?: string
    height?: string
    timestamp?: string
    sha256?: string
  }>()
  
  const file = data.image
  const type = file.type
  const useTimestamp = data.timestamp === 'true'
  const useSha256 = data.sha256 === 'true'
  
  const nameParts = file.name.split('.')
  const extension = nameParts.pop() || 'png'
  const basename = nameParts.join('.')
  
  let key = file.name
  
  if (useSha256 || useTimestamp) {
    const parts = []
    parts.push(basename)
    
    if (useSha256) {
      const hash = (await sha256(file)).substring(0, 8)
      parts.push(hash)
    }
    
    if (useTimestamp) {
      const timestamp = Date.now()
      const random = Math.random().toString(36).substring(2, 8)
      parts.push(`${timestamp}_${random}`)
    }
    
    key = `${parts.join('_')}.${extension}`
  }
  
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
    cacheName: 'r2-image-worker',
    cacheControl: `public, max-age=${maxAge}`
  })
)

// CORSプリフライト対応
app.options('*', (c) => {
  return c.text('', 204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS, PUT',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Allow-Credentials': 'false'
  })
})

// HEADリクエスト対応（ファイル存在確認用）
app.head('/:key', async (c) => {
  const key = c.req.param('key')
  const object = await c.env.BUCKET.head(key)
  
  if (!object) return c.notFound()
  
  return c.body(null, 200, {
    'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
    'Content-Length': object.size.toString(),
    'ETag': object.httpEtag || object.etag,
    'Last-Modified': object.uploaded.toUTCString(),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Type, ETag, Last-Modified'
  })
})

// 画像配信エンドポイント（CORS対応強化）
app.get('/:key', async (c) => {
  const key = c.req.param('key')
  const object = await c.env.BUCKET.get(key)
  
  if (!object) return c.notFound()
  
  const data = await object.arrayBuffer()
  const contentType = object.httpMetadata?.contentType ?? 'application/octet-stream'
  
  // クエリパラメータでダウンロードモードを制御
  const url = new URL(c.req.url)
  const forceDownload = url.searchParams.get('download') === 'true'
  
  // スクリーンショットかどうかを判定
  const isScreenshot = key.includes('screenshot_')
  
  // Content-Dispositionの設定
  let contentDisposition = 'inline'
  if (forceDownload || (isScreenshot && c.req.header('User-Agent')?.includes('Mobile'))) {
    // 強制ダウンロードまたはモバイルからのスクリーンショットアクセス
    contentDisposition = 'attachment'
  }
  
  // ファイル名を適切にエンコード（日本語等の対応）
  const filename = key.split('/').pop() || 'download'
  const encodedFilename = encodeURIComponent(filename)
  
  // レスポンスヘッダー
  const headers: Record<string, string> = {
    'Cache-Control': `public, max-age=${isScreenshot ? 3600 : maxAge}`, // スクリーンショットは1時間キャッシュ
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Type, Content-Disposition, ETag, Last-Modified',
    'Access-Control-Allow-Credentials': 'false',
    'Content-Disposition': `${contentDisposition}; filename="${filename}"; filename*=UTF-8''${encodedFilename}`,
    'X-Content-Type-Options': 'nosniff'
  }
  
  // 追加のメタデータがあれば設定
  if (object.httpEtag || object.etag) {
    headers['ETag'] = object.httpEtag || object.etag
  }
  if (object.uploaded) {
    headers['Last-Modified'] = object.uploaded.toUTCString()
  }
  
  return c.body(data, 200, headers)
})

export default app
