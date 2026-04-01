/**
 * RecipeMee Cloudflare Worker
 * Handles: MiniMax API relay + YouTube transcript fetching
 */

const WORKER_URL = 'https://api.minimax.io';
const API_KEY = MINIMAX_API_KEY; // bound via `wrangler secret put MINIMAX_API_KEY`

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Route: YouTube transcript endpoint
    if (url.pathname === '/youtube-transcript') {
      const videoUrl = url.searchParams.get('url');
      if (!videoUrl) {
        return new Response(JSON.stringify({ error: 'Missing url param' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Extract video ID from various YouTube URL formats
      const videoId = extractVideoId(videoUrl);
      if (!videoId) {
        return new Response(JSON.stringify({ error: 'Invalid YouTube URL' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      try {
        const transcript = await getYouTubeTranscript(videoId);
        return new Response(JSON.stringify({ transcript }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Route: MiniMax API relay (existing functionality)
    if (request.method === 'POST') {
      try {
        const body = await request.json();
        const minimaxRes = await fetch(`${WORKER_URL}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.MINIMAX_API_KEY}`
          },
          body: JSON.stringify(body)
        });
        const data = await minimaxRes.json();
        return new Response(JSON.stringify(data), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    return new Response('RecipeMee Worker', { status: 200 });
  }
};

function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

async function getYouTubeTranscript(videoId) {
  // Use YouTube's internal transcript API
  // This hits the same endpoint the web player uses
  const transcriptUrl = `https://youtubetranscript.com/?v=${videoId}`;
  
  try {
    // Try youtubetranscript.com first (CORS-friendly from Worker)
    const res = await fetch(transcriptUrl);
    if (res.ok) {
      const html = await res.text();
      // Extract transcript from HTML
      const textMatch = html.match(/<div[^>]*id=["']content["'][^>]*>([\s\S]*?)<\/div>/);
      if (textMatch) {
        const text = textMatch[1]
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .trim();
        if (text.length > 50) return text;
      }
    }
  } catch (e) {
    // Fall through to next method
  }

  // Fallback: Use invidio.us API (public YouTube proxy)
  try {
    const apiUrl = `https://invidious.projectsegfau.lt/api/v1/videos/${videoId}`;
    const res = await fetch(apiUrl);
    if (res.ok) {
      const data = await res.json();
      if (data.subtitles && data.subtitles.length > 0) {
        // Get captions from the first available language
        const captionUrl = data.subtitles[0].url;
        const captionRes = await fetch(captionUrl);
        if (captionRes.ok) {
          const xml = await captionRes.text();
          return parseTTML(xml);
        }
      }
    }
  } catch (e) {
    // Fall through
  }

  throw new Error('No transcript available for this video');
}

function parseTTML(xml) {
  // Simple TTML/vtt parsing
  const text = xml
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n+/g, ' ')
    .trim();
  return text;
}
