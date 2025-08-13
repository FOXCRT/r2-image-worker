import { Hono } from 'hono/quick'
import { cache } from 'hono/cache'
import { sha256 } from 'hono/utils/crypto'
import { basicAuth } from 'hono/basic-auth'

type Bindings = {
  BUCKET: R2Bucket
  USER: string
  PASS: string
}

const maxAge = 60 * 60 * 24 * 30
const app = new Hono<{ Bindings: Bindings }>()

// CORSヘッダーを設定する共通関数
const setCorsHeaders = (headers: Headers): Headers => {
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS, PUT')
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range, Accept')
  headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Type, Content-Disposition, ETag, Last-Modified')
  headers.set('Access-Control-Allow-Credentials', 'false')
  return headers
}

// 全リクエストにCORSヘッダーを追加するミドルウェア
app.use('*', async (c, next) => {
  await next()
  
  // レスポンスにCORSヘッダーを追加
  const headers = new Headers(c.res.headers)
  setCorsHeaders(headers)
  
  // 新しいレスポンスを作成
  const body = c.res.body
  const newResponse = new Response(body, {
    status: c.res.status,
    statusText: c.res.statusText,
    headers: headers
  })
  
  return newResponse
})

// OPTIONSリクエスト（CORSプリフライト）の処理
app.options('*', (c) => {
  const headers = new Headers()
  setCorsHeaders(headers)
  headers.set('Access-Control-Max-Age', '86400')
  
  return new Response(null, {
    status: 204,
    headers: headers
  })
})

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

// メインの画像配信エンドポイント（GET/HEAD両方に対応）
app.all('/:key', async (c) => {
  const key = c.req.param('key')
  const method = c.req.method
  
  // HEADリクエストの場合
  if (method === 'HEAD') {
    try {
      const object = await c.env.BUCKET.head(key)
      
      if (!object) {
        return c.notFound()
      }
      
      const headers = new Headers()
      headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream')
      headers.set('Content-Length', object.size.toString())
      headers.set('ETag', object.httpEtag || object.etag)
      headers.set('Last-Modified', object.uploaded.toUTCString())
      setCorsHeaders(headers)
      
      return new Response(null, {
        status: 200,
        headers: headers
      })
    } catch (error) {
      return c.notFound()
    }
  }
  
  // GETリクエストの場合
  if (method === 'GET') {
    try {
      // キャッシュのチェック
      const cacheKey = new Request(c.req.url)
      const cacheStore = caches.default
      
      // キャッシュから取得を試みる
      let cachedResponse = await cacheStore.match(cacheKey)
      
      if (cachedResponse) {
        // キャッシュヒット時もCORSヘッダーを確実に設定
        const headers = new Headers(cachedResponse.headers)
        setCorsHeaders(headers)
        
        return new Response(cachedResponse.body, {
          status: cachedResponse.status,
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
      const headers = new Headers()
      headers.set('Content-Type', contentType)
      headers.set('Cache-Control', `public, max-age=${isScreenshot ? 3600 : maxAge}`)
      headers.set('Content-Disposition', `${contentDisposition}; filename="${filename}"; filename*=UTF-8''${encodedFilename}`)
      headers.set('X-Content-Type-Options', 'nosniff')
      
      // 追加メタデータ
      if (object.httpEtag || object.etag) {
        headers.set('ETag', object.httpEtag || object.etag)
      }
      if (object.uploaded) {
        headers.set('Last-Modified', object.uploaded.toUTCString())
      }
      
      // CORSヘッダーを設定
      setCorsHeaders(headers)
      
      // レスポンスを作成
      const response = new Response(data, {
        status: 200,
        headers: headers
      })
      
      // キャッシュに保存（非同期）
      c.executionCtx.waitUntil(
        cacheStore.put(cacheKey, response.clone())
      )
      
      return response
      
    } catch (error) {
      console.error('Error fetching from R2:', error)
      return c.notFound()
    }
  }
  
  // その他のメソッドは許可しない
  return c.text('Method Not Allowed', 405)
})

export default app
