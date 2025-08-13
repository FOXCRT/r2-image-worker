import { Hono } from 'hono/quick'
import { cache } from 'hono/cache'
import { sha256 } from 'hono/utils/crypto'
import { basicAuth } from 'hono/basic-auth'
import { cors } from 'hono/cors'

type Bindings = {
  BUCKET: R2Bucket
  USER: string
  PASS: string
}

const maxAge = 60 * 60 * 24 * 30
const app = new Hono<{ Bindings: Bindings }>()

// 【重要】CORSミドルウェアを最初に設定
app.use('*', cors({
  origin: '*', // 本番環境では特定のドメインに制限することを推奨
  allowMethods: ['GET', 'HEAD', 'PUT', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'Range', 'Accept'],
  exposeHeaders: ['Content-Length', 'Content-Type', 'Content-Disposition', 'ETag', 'Last-Modified'],
  credentials: false,
  maxAge: 86400
}))

// PUTエンドポイントの認証
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

// HEADリクエスト対応
app.head('/:key', async (c) => {
  const key = c.req.param('key')
  
  try {
    const object = await c.env.BUCKET.head(key)
    
    if (!object) {
      return c.notFound()
    }
    
    // ヘッダーを設定してレスポンス
    c.header('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream')
    c.header('Content-Length', object.size.toString())
    c.header('ETag', object.httpEtag || object.etag)
    c.header('Last-Modified', object.uploaded.toUTCString())
    
    return c.body(null)
  } catch (error) {
    return c.notFound()
  }
})

// GETエンドポイント - キャッシュとCORSの両立
app.get('/:key', async (c) => {
  const key = c.req.param('key')
  
  // キャッシュのチェック（手動実装）
  const cacheKey = new Request(c.req.url)
  const cache = caches.default
  
  // キャッシュから取得を試みる
  let response = await cache.match(cacheKey)
  
  if (response) {
    // キャッシュヒット時もCORSヘッダーを確実に設定
    const headers = new Headers(response.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Type, Content-Disposition, ETag, Last-Modified')
    
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: headers
    })
  }
  
  // R2から取得
  const object = await c.env.BUCKET.get(key)
  
  if (!object) {
    return c.notFound()
  }
  
  const data = await object.arrayBuffer()
  const contentType = object.httpMetadata?.contentType || 'application/octet-stream'
  
  // クエリパラメータでダウンロードモードを制御
  const url = new URL(c.req.url)
  const forceDownload = url.searchParams.get('download') === 'true'
  
  // スクリーンショットかどうかを判定
  const isScreenshot = key.includes('screenshot_')
  
  // User-Agentからモバイルを検出
  const userAgent = c.req.header('User-Agent') || ''
  const isMobile = /iPhone|iPad|iPod|Android/i.test(userAgent)
  
  // Content-Dispositionの設定
  let contentDisposition = 'inline'
  if (forceDownload || (isScreenshot && isMobile)) {
    contentDisposition = 'attachment'
  }
  
  // ファイル名を適切にエンコード
  const filename = key.split('/').pop() || 'download'
  const encodedFilename = encodeURIComponent(filename)
  
  // レスポンスヘッダーを設定
  const headers = new Headers({
    'Content-Type': contentType,
    'Cache-Control': `public, max-age=${isScreenshot ? 3600 : maxAge}`,
    'Content-Disposition': `${contentDisposition}; filename="${filename}"; filename*=UTF-8''${encodedFilename}`,
    'X-Content-Type-Options': 'nosniff',
    // CORSヘッダーを明示的に設定
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Type, Content-Disposition, ETag, Last-Modified',
    'Access-Control-Allow-Credentials': 'false'
  })
  
  // 追加メタデータ
  if (object.httpEtag || object.etag) {
    headers.set('ETag', object.httpEtag || object.etag)
  }
  if (object.uploaded) {
    headers.set('Last-Modified', object.uploaded.toUTCString())
  }
  
  // レスポンスを作成
  const newResponse = new Response(data, {
    status: 200,
    headers: headers
  })
  
  // キャッシュに保存（CORSヘッダー付きで）
  c.executionCtx.waitUntil(cache.put(cacheKey, newResponse.clone()))
  
  return newResponse
})

// 404エラーハンドラー
app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404)
})

// エラーハンドラー
app.onError((err, c) => {
  console.error('Error:', err)
  return c.json({ error: 'Internal Server Error' }, 500)
})

export default app
