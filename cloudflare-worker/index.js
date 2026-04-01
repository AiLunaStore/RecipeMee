/**
 * RecipeMee YouTube Transcript Worker (JavaScript)
 * Fetches YouTube video transcripts using YouTube's internal transcript API.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response('', {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      })
    }

    if (url.pathname === '/youtube-transcript') {
      const videoId = url.searchParams.get('videoId')
      if (!videoId) {
        return jsonResponse({ error: 'Missing videoId parameter' }, 400)
      }

      try {
        const transcript = await getYouTubeTranscript(videoId)
        return jsonResponse({
          videoId,
          transcript,
          language: 'en',
        })
      } catch (e) {
        return jsonResponse({
          error: e.message || 'No transcript available for this video.',
        }, 500)
      }
    }

    return jsonResponse({ error: 'Not found' }, 404)
  }
}

async function getYouTubeTranscript(videoId) {
  // First, get the video page to extract the innertube API key
  const videoPageUrl = `https://www.youtube.com/watch?v=${videoId}&hl=en`
  const videoPage = await fetch(videoPageUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    }
  })
  const pageText = await videoPage.text()

  // Extract innertube API key and video details
  const apiKeyMatch = pageText.match(/"INNERTUBE_API_KEY":"([^"]+)"/)
  const apiKey = apiKeyMatch ? apiKeyMatch[1] : 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'

  // Extract transcript data from YouTube's transcript endpoint
  const transcriptUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=json`
  const transcriptResponse = await fetch(transcriptUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    }
  })

  if (transcriptResponse.ok) {
    const transcriptData = await transcriptResponse.json()
    if (transcriptData && transcriptData.events) {
      const textParts = transcriptData.events
        .filter(event => event.segs)
        .flatMap(event => event.segs.map(seg => seg.utf8 || ''))
        .join(' ')
        .replace(/\n+/g, ' ')
        .trim()
      if (textParts.length > 20) return textParts
    }
  }

  // Fallback: try caption via innertube API
  try {
    const captionUrl = `https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}`
    const captionResponse = await fetch(captionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20240101.00.00',
          }
        },
        params: 'Cg0KAhhEOkxRYUNnPTQ=',
        videoId,
      })
    })

    if (captionResponse.ok) {
      const data = await captionResponse.json()
      const transcripts = data.actions?.[0]?.updateEngageabilityPanel?.engageability?.subscribeVideoEngageabilityPanel?.microformat?.playerMicroformatRenderer
      // Parse transcript from response
      const body = JSON.stringify(data)
      const textMatches = body.match(/"text":"([^"\\]*(?:\\.[^"\\]*)*)"/g)
      if (textMatches && textMatches.length > 0) {
        const text = textMatches.map(m => m.match(/"text":"([^"]*)"/)[1]).join(' ')
        if (text.length > 20) return text
      }
    }
  } catch (e) {
    // Fall through to error
  }

  throw new Error('No transcript available for this video. The video may not have closed captions.')
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
