import { Hono } from 'hono/quick'
import { cors } from 'hono/cors'  
import { cache } from 'hono/cache'
import { sha256 } from 'hono/utils/crypto'
import { basicAuth } from 'hono/basic-auth'

type Bindings = {
  BUCKET: R2Bucket
  USER: string
  PASS: string
  ALLOWED_ORIGINS?: string  // 環境変数で制御可能
}

const app = new Hono<{ Bindings: Bindings }>()

// 1. CORSミドルウェアを最初に適用（重要）
app.use('*', cors({
  origin: (origin, c) => {
    // 環境変数でオリジンを制御
    const allowedOrigins = c.env.ALLOWED_ORIGINS?.split(',') || ['*']
    if (allowedOrigins.includes('*')) return '*'
    if (allowedOrigins.includes(origin)) return origin
    return allowedOrigins[0] // デフォルトは最初のオリジン
  },
  allowMethods: ['GET', 'HEAD', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'Range', 'If-None-Match'],
  exposeHeaders: [
    'Content-Length',
    'Content-Type', 
    'Content-Disposition',
    'Content-Range',
    'ETag',
    'Last-Modified',
    'Accept-Ranges'
  ],
  credentials: false,
  maxAge: 86400
}))

// 2. キャッシュミドルウェア（GETリクエストのみ）
app.get('*', cache({
  cacheName: 'r2-image-cache',
  cacheControl: 'public, max-age=3600',
  wait: true,
  // CORSヘッダーも含めてキャッシュされるように
  vary: ['Origin', 'Access-Control-Request-Headers']
}))

// 元のコードと同じ構造を維持
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


// 画像配信エンドポイント（GET/HEAD対応）
app.on(['GET', 'HEAD'], '/:key{.+}', async (c) => {
  const key = c.req.param('key')
  const method = c.req.method
  
  try {
    // HEADリクエストの場合はメタデータのみ
    if (method === 'HEAD') {
      const object = await c.env.BUCKET.head(key)
      
      if (!object) {
        return c.notFound()
      }
      
      // ETagベースのキャッシュ制御
      const etag = object.httpEtag || object.etag
      const ifNoneMatch = c.req.header('If-None-Match')
      
      if (ifNoneMatch && ifNoneMatch === etag) {
        return c.body(null, 304)
      }
      
      c.header('Content-Type', object.httpMetadata?.contentType || getContentType(key))
      c.header('Content-Length', object.size.toString())
      c.header('Accept-Ranges', 'bytes')
      c.header('ETag', etag)
      c.header('Last-Modified', object.uploaded.toUTCString())
      c.header('Cache-Control', getCacheControl(key))
      
      return c.body(null)
    }
    
    // GETリクエストの処理
    const url = new URL(c.req.url)
    const forceDownload = url.searchParams.get('download') === 'true'
    
    // Rangeヘッダーの処理（部分ダウンロード対応）
    const range = c.req.header('Range')
    let object: R2Object | R2ObjectBody
    let status = 200
    let contentRange: string | undefined
    
    if (range) {
      // Range対応
      const matches = range.match(/bytes=(\d+)-(\d*)/)
      if (matches) {
        const start = parseInt(matches[1], 10)
        const end = matches[2] ? parseInt(matches[2], 10) : undefined
        
        object = await c.env.BUCKET.get(key, {
          range: { offset: start, length: end ? end - start + 1 : undefined }
        })
        
        if (object) {
          status = 206 // Partial Content
          const totalSize = 'size' in object ? object.size : 0
          contentRange = `bytes ${start}-${end || totalSize - 1}/${totalSize}`
        }
      } else {
        object = await c.env.BUCKET.get(key)
      }
    } else {
      // 通常のGETリクエスト
      object = await c.env.BUCKET.get(key)
    }
    
    if (!object) {
      return c.notFound()
    }
    
    // ETagベースのキャッシュ制御
    const etag = object.httpEtag || object.etag
    const ifNoneMatch = c.req.header('If-None-Match')
    
    if (ifNoneMatch && ifNoneMatch === etag) {
      return c.body(null, 304)
    }
    
    // レスポンスボディの取得
    const body = 'body' in object ? object.body : null
    if (!body) {
      return c.notFound()
    }
    
    // Content-Dispositionの設定
    const isScreenshot = key.includes('screenshot_')
    const isMobile = /iPhone|iPad|iPod|Android/i.test(c.req.header('User-Agent') || '')
    
    let contentDisposition = 'inline'
    if (forceDownload) {
      contentDisposition = 'attachment'
    } else if (isScreenshot && isMobile) {
      // モバイルでスクリーンショットは自動的にダウンロード
      contentDisposition = 'attachment'
    }
    
    const filename = key.split('/').pop() || 'download'
    const encodedFilename = encodeURIComponent(filename)
    
    // レスポンスヘッダーの設定
    c.header('Content-Type', object.httpMetadata?.contentType || getContentType(key))
    c.header('Content-Disposition', `${contentDisposition}; filename="${filename}"; filename*=UTF-8''${encodedFilename}`)
    c.header('Cache-Control', getCacheControl(key))
    c.header('ETag', etag)
    c.header('Last-Modified', object.uploaded.toUTCString())
    c.header('Accept-Ranges', 'bytes')
    c.header('X-Content-Type-Options', 'nosniff')
    
    if (contentRange) {
      c.header('Content-Range', contentRange)
    }
    
    // ArrayBufferに変換して返す
    const data = await streamToArrayBuffer(body)
    return c.body(data, status)
    
  } catch (error) {
    console.error('Error serving file:', error)
    return c.json({ error: 'Internal Server Error' }, 500)
  }
})

// 404ハンドラー
app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404)
})

// エラーハンドラー
app.onError((err, c) => {
  console.error('Worker error:', err)
  return c.json({ error: 'Internal Server Error' }, 500)
})

// ヘルパー関数
function getContentType(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase()
  const mimeTypes: Record<string, string> = {
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'svg': 'image/svg+xml',
    'ico': 'image/x-icon',
    'bmp': 'image/bmp',
    'tiff': 'image/tiff',
    'pdf': 'application/pdf'
  }
  return mimeTypes[ext || ''] || 'application/octet-stream'
}

function getCacheControl(key: string): string {
  // スクリーンショットは短めのキャッシュ
  if (key.includes('screenshot_')) {
    return 'public, max-age=3600' // 1時間
  }
  // ロゴなどの静的画像は長期キャッシュ
  return 'public, max-age=31536000, immutable' // 1年
}

async function streamToArrayBuffer(stream: ReadableStream): Promise<ArrayBuffer> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  
  return result.buffer
}

export default app
