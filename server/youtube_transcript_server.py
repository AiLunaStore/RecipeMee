#!/usr/bin/env python3
"""
RecipeMee YouTube Transcript Server
Runs locally on Mac mini at http://localhost:8765/youtube-transcript
Exposes a simple HTTP API for fetching YouTube video transcripts.
"""

from flask import Flask, request, jsonify
from youtube_transcript_api import YouTubeTranscriptApi
from flask_cors import CORS
import re
import sys
import os

app = Flask(__name__)
CORS(app)

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
        transcript = api.get_transcript(video_id, languages=['en'])
        # get_transcript returns a list of dicts with 'text', 'start', 'duration'
        full_text = ' '.join([item['text'] for item in transcript])
        response = jsonify({
            'videoId': video_id,
            'transcript': full_text,
            'language': 'en'
        })
        response.headers['Access-Control-Allow-Origin'] = '*'
        return response
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
