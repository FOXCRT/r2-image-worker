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

// BasicAuth ミドルウェア（元の実装どおり）
app.put('/upload', async (c, next) => {
  try {
    const auth = basicAuth({ username: c.env.USER, password: c.env.PASS })
    await auth(c, next)
  } catch (e) {
    console.error('Auth error:', e)
    return c.json({ 
      error: 'Auth failed', 
      details: e instanceof Error ? e.message : String(e) 
    }, 401)
  }
})

app.put('/upload', async (c) => {
  try {
    console.log('Upload handler started')
    
    // 環境変数チェック
    if (!c.env.BUCKET) {
      console.error('BUCKET not bound')
      return c.json({ error: 'BUCKET not configured' }, 500)
    }
    
    // parseBody
    let data
    try {
      data = await c.req.parseBody()
      console.log('ParseBody success, keys:', Object.keys(data))
    } catch (e) {
      console.error('ParseBody error:', e)
      return c.json({ 
        error: 'ParseBody failed', 
        details: e instanceof Error ? e.message : String(e) 
      }, 400)
    }
    
    const file = data.image as File
    if (!file) {
      return c.json({ error: 'No image file in request' }, 400)
    }
    
    console.log('File info:', file.name, file.size, file.type)
    
    // シンプルなファイル名でアップロード（デバッグ用）
    const key = `test_${Date.now()}_${file.name}`
    
    try {
      await c.env.BUCKET.put(key, file, { 
        httpMetadata: { 
          contentType: file.type || 'application/octet-stream' 
        } 
      })
      console.log('Upload to R2 successful:', key)
    } catch (e) {
      console.error('R2 upload error:', e)
      return c.json({ 
        error: 'R2 upload failed', 
        details: e instanceof Error ? e.message : String(e) 
      }, 500)
    }
    
    return c.text(key)
    
  } catch (e) {
    console.error('Unexpected error:', e)
    return c.json({ 
      error: 'Internal Server Error', 
      details: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined 
    }, 500)
  }
})

// ヘルスチェック
app.get('/health', (c) => {
  return c.json({ 
    status: 'ok',
    user_configured: !!c.env.USER,
    pass_configured: !!c.env.PASS,
    bucket_configured: !!c.env.BUCKET
  })
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
