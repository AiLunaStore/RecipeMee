/**
 * RecipeMee Cloudflare Worker
 * Handles: YouTube API, generic URL fetching for recipe pages
 */

const YOUTUBE_API_KEY = 'REDACTED-GOOGLE-API-KEY-2'

export default {
  async fetch(request) {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response('', {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
        }
      })
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

  // Basic URL validation
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

    // Extract readable text from HTML
    const text = extractReadableText(html)

    return jsonResponse({
      url: targetUrl,
      text: text.substring(0, 15000), // Limit to 15k chars
      rawLength: html.length,
    })
  } catch (e) {
    return jsonResponse({ error: 'Failed to fetch URL: ' + e.message }, 500)
  }
}

function extractReadableText(html) {
  // Remove script and style tags
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  // Replace common block elements with newlines
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

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  })
}
