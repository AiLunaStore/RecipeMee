#!/usr/bin/env python3
"""
RecipeMee NAS Server
Handles: recipe backup/restore, URL scraping (residential IP), LLM chat (DeepSeek)
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import json
import os
import re
import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse
from deepseek import DeepSeekClient as DeepSeek

app = Flask(__name__)
CORS(app)

BACKUP_DIR = '/volume1/docker/recipemee-backup'
BACKUP_FILE = os.path.join(BACKUP_DIR, 'recipes.json')
DEEPSEEK_API_KEY = os.environ.get('DEEPSEEK_API_KEY', 'sk-b3ec10308f7644c8a8b3765e52e60ea5')

USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'


@app.route('/backup', methods=['GET', 'POST', 'OPTIONS'])
def backup():
    if request.method == 'OPTIONS':
        return '', 204
    if request.method == 'GET':
        if os.path.exists(BACKUP_FILE):
            with open(BACKUP_FILE, 'r') as f:
                data = json.load(f)
            return jsonify({
                'status': 'ok',
                'count': len(data.get('recipes', [])),
                'lastBackup': data.get('lastUpdated'),
                'recipes': data.get('recipes', [])
            })
        return jsonify({'status': 'ok', 'count': 0, 'lastBackup': None, 'recipes': []})
    if request.method == 'POST':
        data = request.get_json()
        if not data or 'recipes' not in data:
            return jsonify({'error': 'Missing recipes array'}), 400
        backup_data = {
            'recipes': data['recipes'],
            'lastUpdated': data.get('lastUpdated', ''),
            'deviceId': data.get('deviceId', 'unknown')
        }
        os.makedirs(BACKUP_DIR, exist_ok=True)
        with open(BACKUP_FILE, 'w') as f:
            json.dump(backup_data, f, indent=2)
        return jsonify({'status': 'ok', 'count': len(data['recipes']), 'savedAt': backup_data['lastUpdated']})


@app.route('/scrape', methods=['GET', 'OPTIONS'])
def scrape():
    if request.method == 'OPTIONS':
        return '', 204

    # Handle YouTube URLs specially - use the Data API to get description
    if 'youtube.com' in target_url or 'youtu.be' in target_url:
        video_id = None
        match = re.search(r'(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/embed/|youtube\.com/shorts/)([a-zA-Z0-9_-]{11})', target_url)
        if match:
            video_id = match.group(1)
        if not video_id:
            return jsonify({'error': 'Could not extract YouTube video ID'}), 400
        api_key = os.environ.get('YOUTUBE_API_KEY', 'AIzaSyCEjrxFAYdwzUH7EQIREx7V9L72Kk6r64I')
        api_url = f'https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id={video_id}&key={api_key}'
        try:
            api_resp = requests.get(api_url, timeout=10)
            if not api_resp.ok:
                return jsonify({'error': 'YouTube API unavailable'}), 502
            api_data = api_resp.json()
            items = api_data.get('items', [])
            if not items:
                return jsonify({'error': 'YouTube video not found'}), 404
            snippet = items[0].get('snippet', {})
            description = snippet.get('description', '')
            thumbnails = snippet.get('thumbnails', {})
            thumbnail = (thumbnails.get('maxres') or thumbnails.get('high') or thumbnails.get('medium') or thumbnails.get('standard') or {}).get('url', '')
            return jsonify({'url': target_url, 'text': description, 'photoUrl': thumbnail})
        except Exception as e:
            return jsonify({'error': f'YouTube API error: {str(e)}'}), 500

    if not target_url:
        return jsonify({'error': 'Missing url parameter'}), 400
    try:
        parsed = urlparse(target_url)
        if parsed.scheme not in ('http', 'https'):
            return jsonify({'error': 'Only HTTP/HTTPS URLs allowed'}), 400
    except Exception:
        return jsonify({'error': 'Invalid URL'}), 400
    try:
        resp = requests.get(target_url, timeout=10, headers={
            'User-Agent': USER_AGENT,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate',
            'Connection': 'keep-alive',
        }, verify='/etc/ssl/certs/ca-certificates.crt')
        resp.raise_for_status()
        content_type = resp.headers.get('content-type', '')
        if 'text/html' not in content_type:
            return jsonify({'error': 'Only HTML pages can be fetched'}), 400
        html = resp.text
        photo_url = None
        og_image_match = re.search(r'<meta[^>]*(?:property|name)=["\']og:image["\'][^>]*content=["\']([^"\']+)["\']', html, re.I)
        if not og_image_match:
            og_image_match = re.search(r'<meta[^>]*content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\']og:image["\']', html, re.I)
        if og_image_match:
            photo_url = og_image_match.group(1)
            if photo_url.startswith('/'):
                photo_url = urljoin(target_url, photo_url)
        soup = BeautifulSoup(html, 'html.parser')
        for tag in soup.find_all(['script', 'style', 'nav', 'header', 'footer', 'aside']):
            tag.decompose()
        for tag in soup.find_all(style=re.compile(r'display\s*:\s*none|visibility\s*:\s*hidden', re.I)):
            tag.decompose()
        article = soup.find('article') or soup.find('main') or soup.find('div', id=re.compile(r'content|recipe|main', re.I)) or soup
        text = article.get_text(separator='\n', strip=True)
        text = re.sub(r'\n{3,}', '\n\n', text).strip()
        return jsonify({'url': target_url, 'text': text[:15000], 'photoUrl': (photo_url or '').replace('&amp;', '&')})
    except requests.exceptions.Timeout:
        return jsonify({'error': 'Request timed out'}), 500
    except requests.exceptions.HTTPError as e:
        return jsonify({'error': f'Failed to fetch URL (status {e.response.status_code})'}), 500
    except Exception as e:
        return jsonify({'error': f'Failed to fetch URL: {str(e)}'}), 500


@app.route('/chat', methods=['POST', 'OPTIONS'])
def chat():
    if request.method == 'OPTIONS':
        return '', 204
    data = request.get_json() or {}
    messages = data.get('messages', [])
    model = data.get('model', 'deepseek-chat')
    max_tokens = data.get('max_tokens', 4000)
    temperature = data.get('temperature', 0.7)

    # Get the last user message (recipe text to parse)
    user_message = ''
    for m in reversed(messages):
        if m.get('role') == 'user':
            user_message = m.get('content', '')
            break

    if not user_message:
        return jsonify({'error': 'No message content'}), 400

    try:
        client = DeepSeek(api_key=DEEPSEEK_API_KEY)
        system_prompt = """Parse this recipe into clean JSON. Return ONLY the JSON object with this exact structure:
{
  "title": "Recipe name",
  "description": "1-2 sentence description",
  "servings": "4 servings",
  "prepTime": "15 mins",
  "cookTime": "30 mins",
  "totalTime": "45 mins",
  "ingredients": [{"text": "full ingredient text", "qty": "2", "unit": "cups", "item": "flour"}],
  "instructions": [{"text": "step text", "timer": "5 mins"}],
  "tags": ["Breakfast", "Dinner", "Healthy"],
  "photoUrl": "",
  "nutrition": {
    "calories": "350 kcal",
    "protein": "25g",
    "carbs": "40g",
    "fat": "12g",
    "fiber": "6g",
    "sugar": "8g",
    "sodium": "580mg"
  }
}

IMPORTANT: Return ONLY the JSON object, nothing else. No markdown, no explanation. Estimate nutrition per serving based on ingredients — include calories, protein, carbs, fat, fiber (and sugar/sodium if identifiable)."""

        response = client.chat_completion(
            model='deepseek-chat',
            messages=[
                {'role': 'system', 'content': system_prompt},
                {'role': 'user', 'content': user_message}
            ],
            max_tokens=max_tokens,
            temperature=temperature,
        )

        content = response.choices[0].message.content

        # Strip markdown code blocks if present
        content = content.strip()
        if content.startswith('```'):
            content = re.sub(r'^```(?:json)?\s*', '', content)
            content = re.sub(r'\s*```$', '', content)
        content = content.strip()

        # Try to parse and validate JSON
        try:
            parsed = json.loads(content)
            return jsonify({'choices': [{'message': {'content': json.dumps(parsed)}}]})
        except json.JSONDecodeError:
            # Return as-is, let the app handle it
            return jsonify({'choices': [{'message': {'content': content}}]})

    except Exception as e:
        return jsonify({'error': f'Chat error: {str(e)}'}), 500


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok'})


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8765))
    from gevent.pywsgi import WSGIServer
    print(f'RecipeMee NAS Server running on port {port}')
    http_server = WSGIServer(('0.0.0.0', port), app)
    http_server.serve_forever()

@app.route('/youtube', methods=['GET', 'OPTIONS'])
def youtube_transcript():
    """Fetch YouTube video description via Data API v3"""
    video_id = request.args.get('id') or request.args.get('video_id', '')
    if not video_id:
        return jsonify({'error': 'Missing video ID'}), 400

    api_key = os.environ.get('YOUTUBE_API_KEY', 'AIzaSyCEjrxFAYdwzUH7EQIREx7V9L72Kk6r64I')
    url = f'https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id={video_id}&key={api_key}'
    
    try:
        resp = requests.get(url, timeout=10)
        if not resp.ok:
            return jsonify({'error': 'YouTube API unavailable'}), 502
        data = resp.json()
        items = data.get('items', [])
        if not items:
            return jsonify({'error': 'Video not found'}), 404
        snippet = items[0].get('snippet', {})
        description = snippet.get('description', '')
        thumbnails = snippet.get('thumbnails', {})
        thumbnail = (
            thumbnails.get('maxres', {}) or
            thumbnails.get('high', {}) or
            thumbnails.get('medium', {}) or
            thumbnails.get('standard', {})
        ).get('url', '')
        if len(description) < 50:
            return jsonify({'error': 'No description found'}), 422
        return jsonify({'description': description, 'thumbnail': thumbnail})
    except Exception as e:
        return jsonify({'error': str(e)}), 500
