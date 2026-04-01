#!/usr/bin/env python3
"""
RecipeMee Backup Server
Saves and syncs recipe backups to the NAS.
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import json
import os

app = Flask(__name__)
CORS(app)

BACKUP_DIR = '/volume1/docker/recipemee-backup'
BACKUP_FILE = os.path.join(BACKUP_DIR, 'recipes.json')

@app.route('/backup', methods=['GET', 'POST', 'OPTIONS'])
def backup():
    if request.method == 'OPTIONS':
        return '', 204

    if request.method == 'GET':
        # Return current backup
        if os.path.exists(BACKUP_FILE):
            with open(BACKUP_FILE, 'r') as f:
                data = json.load(f)
            return jsonify({
                'status': 'ok',
                'count': len(data.get('recipes', [])),
                'lastBackup': data.get('lastUpdated'),
                'recipes': data.get('recipes', [])
            })
        return jsonify({
            'status': 'ok',
            'count': 0,
            'lastBackup': None,
            'recipes': []
        })

    if request.method == 'POST':
        # Save backup
        data = request.get_json()
        if not data or 'recipes' not in data:
            return jsonify({'error': 'Missing recipes array'}), 400

        backup_data = {
            'recipes': data['recipes'],
            'lastUpdated': data.get('lastUpdated', ''),
            'deviceId': data.get('deviceId', 'unknown')
        }

        # Ensure backup dir exists
        os.makedirs(BACKUP_DIR, exist_ok=True)

        with open(BACKUP_FILE, 'w') as f:
            json.dump(backup_data, f, indent=2)

        return jsonify({
            'status': 'ok',
            'count': len(data['recipes']),
            'savedAt': backup_data['lastUpdated']
        })

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok'})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8765))
    from gevent.pywsgi import WSGIServer
    print(f'RecipeMee Backup Server running on port {port}')
    http_server = WSGIServer(('0.0.0.0', port), app)
    http_server.serve_forever()
