/**
 * RecipeMee YouTube Transcript Worker - Fallback
 * When YouTube blocks direct access, this returns video description as fallback.
 * Uses YouTube Data API to get video metadata.
 */

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
      const videoId = url.searchParams.get('videoId')
      if (!videoId) {
        return jsonResponse({ error: 'Missing videoId parameter' }, 400)
      }

      // Use YouTube Data API v3 - reliable, no blocking from browser
      const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoId}&key=${YOUTUBE_API_KEY}`

      try {
        const response = await fetch(apiUrl)
        const data = await response.json()

        if (!data.items?.length) {
          return jsonResponse({ error: 'Video not found', transcript: '' }, 404)
        }

        const video = data.items[0]
        const description = video.snippet?.description || ''
        const hasCaption = video.contentDetails?.caption === 'true'
        const title = video.snippet?.title || ''

        return jsonResponse({
          videoId,
          title,
          transcript: description,
          hasCaption,
          type: description.length > 50 ? 'description' : 'none',
        })
      } catch (e) {
        return jsonResponse({ error: e.message, transcript: '' }, 500)
      }
    }

    return jsonResponse({ error: 'Not found' }, 404)
  }
}

const YOUTUBE_API_KEY = 'REDACTED-GOOGLE-API-KEY-2'

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  })
}
