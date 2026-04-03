/**
 * RecipeMee Cloudflare Worker
 * Handles: YouTube API, generic URL fetching for recipe pages, LLM chat proxy
 */

const YOUTUBE_API_KEY = 'AIzaSyCEjrxFAYdwzUH7EQIREx7V9L72Kk6r64I'
const MINIMAX_BASE = 'https://api.minimax.io/anthropic'
const DEEPSEEK_BASE = 'https://api.deepseek.com'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response('', {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        }
      })
    }

    if (url.pathname === '/chat') {
      return handleChat(request, env)
    }

    if (url.pathname === '/youtube-transcript') {
      return handleYouTubeTranscript(url)
    }

    if (url.pathname === '/fetch-url') {
      return handleFetchUrl(url)
    }

    return jsonResponse({ error: 'Not found' }, 404)
  }
}

async function handleChat(request, env) {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  const MINIMAX_API_KEY = env.MINIMAX_API_KEY || ''
  const DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY || ''

  try {
    const body = await request.json()
    const { model = 'deepseek-chat', messages, max_tokens = 4000, temperature = 0.7 } = body

    // Route to DeepSeek for deepseek-chat model (used for recipe parsing)
    if (model.startsWith('deepseek')) {
      const response = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages,
          max_tokens,
          temperature,
        }),
      })

      const data = await response.json()
      return new Response(JSON.stringify(data), {
        status: response.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      })
    }

    // Default: route to MiniMax (Anthropic-compatible)
    const anthropicMessages = messages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : m.role,
      content: m.content,
    }))

    const response = await fetch(`${MINIMAX_BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MINIMAX_API_KEY}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        messages: anthropicMessages,
        max_tokens,
      }),
    })

    const data = await response.json()

    // Convert Anthropic response to OpenAI chat completions format
    if (data.id) {
      const openAIResponse = {
        id: data.id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: data.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: extractTextContent(data.content),
          },
          finish_reason: data.stop_reason || 'stop',
        }],
        usage: data.usage ? {
          prompt_tokens: data.usage.input_tokens,
          completion_tokens: data.usage.output_tokens,
          total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
        } : undefined,
      }
      return new Response(JSON.stringify(openAIResponse), {
        status: response.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      })
    }

    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch (e) {
    return jsonResponse({ error: e.message }, 500)
  }
}

function extractTextContent(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.filter(c => c.type === 'text').map(c => c.text).join('')
  }
  return String(content)
}

async function handleYouTubeTranscript(url) {
  const videoId = url.searchParams.get('videoId')
  if (!videoId) return jsonResponse({ error: 'Missing videoId parameter' }, 400)

  const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoId}&key=${YOUTUBE_API_KEY}`

  try {
    const response = await fetch(apiUrl)
    const data = await response.json()

    if (!data.items?.length) {
      return jsonResponse({ error: 'Video not found', transcript: '' }, 404)
    }

    const video = data.items[0]
    const description = video.snippet?.description || ''
    const title = video.snippet?.title || ''

    return jsonResponse({
      videoId,
      title,
      transcript: description,
      type: description.length > 50 ? 'description' : 'none',
    })
  } catch (e) {
    return jsonResponse({ error: e.message, transcript: '' }, 500)
  }
}

async function handleFetchUrl(url) {
  const targetUrl = url.searchParams.get('url')
  if (!targetUrl) return jsonResponse({ error: 'Missing url parameter' }, 400)

  try {
    const parsed = new URL(targetUrl)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return jsonResponse({ error: 'Only HTTP/HTTPS URLs allowed' }, 400)
    }
  } catch (e) {
    return jsonResponse({ error: 'Invalid URL' }, 400)
  }

  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    })

    if (!response.ok) {
      return jsonResponse({ error: `Failed to fetch URL (status ${response.status})` }, 500)
    }

    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('text/html')) {
      return jsonResponse({ error: 'Only HTML pages can be fetched' }, 400)
    }

    const html = await response.text()

    // Extract og:image (Open Graph image - main recipe photo)
    let photoUrl = extractMetaContent(html, 'og:image')
      || extractMetaContent(html, 'twitter:image')
      || extractMetaContent(html, 'og:image:url')
      || ''

    // If relative URL, make it absolute
    if (photoUrl && photoUrl.startsWith('/')) {
      const urlObj = new URL(targetUrl)
      photoUrl = urlObj.origin + photoUrl
    }

    const text = extractReadableText(html)

    return jsonResponse({
      url: targetUrl,
      text: text.substring(0, 15000),
      photoUrl,
    })
  } catch (e) {
    return jsonResponse({ error: 'Failed to fetch URL: ' + e.message }, 500)
  }
}

function extractReadableText(html) {
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim()

  return text
}

function extractMetaContent(html, property) {
  // og:image
  const ogMatch = html.match(new RegExp(`<meta[^>]*(?:property|property)=["']${property}["'][^>]*content=["']([^"']+)["'][^>]*>`, 'i'))
  if (ogMatch) return ogMatch[1]

  // Also try reversed attribute order
  const ogMatch2 = html.match(new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${property}["'][^>]*>`, 'i'))
  if (ogMatch2) return ogMatch2[1]

  return null
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  })
}
