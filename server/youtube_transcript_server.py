#!/usr/bin/env python3
"""
RecipeMee YouTube Transcript Server
Runs locally on Mac mini at http://localhost:8765/youtube-transcript
Exposes a simple HTTP API for fetching YouTube video transcripts.
"""

from flask import Flask, request, jsonify
from youtube_transcript_api import YouTubeTranscriptApi
import re
import sys
import os

app = Flask(__name__)
CORS_HEADERS = {'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json'}

def extract_video_id(url):
    """Extract video ID from various YouTube URL formats."""
    patterns = [
        r'(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/embed/|youtube\.com/shorts/)([a-zA-Z0-9_-]{11})',
        r'^([a-zA-Z0-9_-]{11})$',  # Already just an ID
    ]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return None

@app.route('/youtube-transcript', methods=['GET', 'OPTIONS'])
def get_transcript():
    if request.method == 'OPTIONS':
        return '', 204

    url = request.args.get('url', '')
    if not url:
        return jsonify({'error': 'Missing url parameter'}), 400

    video_id = extract_video_id(url)
    if not video_id:
        return jsonify({'error': 'Invalid YouTube URL'}), 400

    try:
        api = YouTubeTranscriptApi()
        transcript = api.fetch(video_id)
        # Join all snippet texts into one full transcript string
        full_text = ' '.join([s.text for s in transcript.snippets])
        return jsonify({
            'videoId': video_id,
            'transcript': full_text,
            'language': transcript.language
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok'})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8765))
    print(f'RecipeMee YouTube Transcript Server running on port {port}')
    from gevent.pywsgi import WSGIServer
    http_server = WSGIServer(('0.0.0.0', port), app)
    http_server.serve_forever()
