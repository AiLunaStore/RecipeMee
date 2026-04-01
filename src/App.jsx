import { useState, useEffect, useRef } from 'react'

// Key note: the worker URL is used instead of MiniMax directly to HIDE the API key from the browser.
// The key lives in the Cloudflare Worker secret, not in client-side code.
const WORKER_URL = 'https://recipemee-proxy.recipemee.workers.dev/chat'
const YOUTUBE_API_KEY = 'REDACTED-GOOGLE-API-KEY-2'
const MODEL = 'minimax-m2'
const NAS_BACKUP_URL = 'https://levin-nas-1.tail065159.ts.net/backup'

function isYouTubeURL(text) {
  return /youtube\.com|youtu\.be/.test(text)
}

function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  ]
  for (const pattern of patterns) {
    const match = url.match(pattern)
    if (match) return match[1]
  }
  return null
}

async function fetchYouTubeTranscriptBrowser(videoId) {
  try {
    const detailsUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoId}&key=${YOUTUBE_API_KEY}`
    const detailsRes = await fetch(detailsUrl)
    if (!detailsRes.ok) throw new Error('YouTube API unavailable')
    const details = await detailsRes.json()

    if (!details.items?.length) {
      throw new Error('Video not found or not accessible')
    }

    const video = details.items[0]
    const description = video.snippet?.description || ''

    if (description.length > 50) {
      return description
    }
    throw new Error('No description found for this video.')
  } catch (e) {
    throw new Error(e.message || 'YouTube transcript fetch failed')
  }
}

function parseRecipeWithLLM(rawText) {
  return fetch(WORKER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: `You are a recipe parser. Parse the recipe text below into a clean JSON object with exactly this structure:
{
  "title": "Recipe name",
  "description": "1-2 sentence description",
  "servings": "number or string like '4 servings'",
  "prepTime": "e.g. '15 mins'",
  "cookTime": "e.g. '30 mins'",
  "totalTime": "e.g. '45 mins'",
  "ingredients": ["list of all ingredients"],
  "instructions": ["step 1", "step 2", ...],
  "tags": ["relevant tags"]
}
Return ONLY the JSON object, nothing else. If a field is unknown, omit it or use null.`
        },
        {
          role: 'user',
          content: rawText
        }
      ]
    })
  })
  .then(r => r.json())
  .then(data => {
    const content = data.choices?.[0]?.message?.content || ''
    let jsonMatch = content.match(/\{[\s\S]*?\}/s)
    if (!jsonMatch) jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON found in response: ' + content.substring(0, 100))
    try {
      return JSON.parse(jsonMatch[0])
    } catch (e) {
      const fixed = jsonMatch[0].replace(/,(\s*[}\]])/g, '$1')
      return JSON.parse(fixed)
    }
  })
}

// Backup/Sync functions
async function backupToNAS(recipes) {
  try {
    const response = await fetch(NAS_BACKUP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipes,
        lastUpdated: new Date().toISOString(),
        deviceId: 'iphone-' + navigator.userAgent.substring(0, 20)
      })
    })
    if (!response.ok) throw new Error('Backup failed')
    return await response.json()
  } catch (e) {
    console.error('Backup error:', e)
    throw e
  }
}

async function restoreFromNAS() {
  try {
    const response = await fetch(NAS_BACKUP_URL)
    if (!response.ok) throw new Error('Restore failed')
    const data = await response.json()
    return data
  } catch (e) {
    console.error('Restore error:', e)
    throw e
  }
}

function getDeviceId() {
  let id = localStorage.getItem('recipemee_device_id')
  if (!id) {
    id = 'device_' + Math.random().toString(36).substr(2, 9)
    localStorage.setItem('recipemee_device_id', id)
  }
  return id
}

function App() {
  const [view, setView] = useState('add')
  const [inputType, setInputType] = useState('text')
  const [rawText, setRawText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [parsed, setParsed] = useState(null)
  const [recipes, setRecipes] = useState([])
  const [search, setSearch] = useState('')
  const [saveMsg, setSaveMsg] = useState('')
  const [fetchingTranscript, setFetchingTranscript] = useState(false)
  const [syncStatus, setSyncStatus] = useState('') // '' | 'syncing' | 'saved' | 'restored' | 'error'
  const [lastSync, setLastSync] = useState(localStorage.getItem('recipemee_last_sync') || '')
  const [nasCount, setNasCount] = useState(null)
  const syncTimerRef = useRef(null)

  // Load recipes from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('recipemee_recipes')
    if (saved) setRecipes(JSON.parse(saved))
    checkNASCount()
  }, [])

  // Auto-backup whenever recipes change (debounced)
  useEffect(() => {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
    syncTimerRef.current = setTimeout(() => {
      if (recipes.length > 0) {
        autoBackup()
      }
    }, 5000) // 5 second debounce
    return () => clearTimeout(syncTimerRef.current)
  }, [recipes])

  async function checkNASCount() {
    try {
      const data = await restoreFromNAS()
      setNasCount(data.count || 0)
    } catch (e) {
      setNasCount(null)
    }
  }

  async function autoBackup() {
    try {
      setSyncStatus('syncing')
      await backupToNAS(recipes)
      setSyncStatus('saved')
      const now = new Date().toLocaleTimeString()
      setLastSync(now)
      localStorage.setItem('recipemee_last_sync', now)
      checkNASCount()
      setTimeout(() => setSyncStatus(''), 2000)
    } catch (e) {
      setSyncStatus('error')
      setTimeout(() => setSyncStatus(''), 3000)
    }
  }

  async function handleRestore() {
    if (!window.confirm('This will replace your current recipes with the backup. Continue?')) return
    try {
      setSyncStatus('syncing')
      const data = await restoreFromNAS()
      if (data.recipes && data.recipes.length > 0) {
        setRecipes(data.recipes)
        localStorage.setItem('recipemee_recipes', JSON.stringify(data.recipes))
        setSyncStatus('restored')
        setLastSync(data.lastBackup ? new Date(data.lastBackup).toLocaleString() : '')
        checkNASCount()
        setTimeout(() => setSyncStatus(''), 2000)
      } else {
        alert('No recipes found in backup.')
        setSyncStatus('')
      }
    } catch (e) {
      alert('Restore failed: ' + e.message)
      setSyncStatus('error')
      setTimeout(() => setSyncStatus(''), 3000)
    }
  }

  async function handleParse() {
    if (!rawText.trim()) return
    setLoading(true)
    setError('')
    setParsed(null)

    try {
      let textToParse = rawText.trim()

      if (isYouTubeURL(textToParse)) {
        setFetchingTranscript(true)
        try {
          const videoId = extractVideoId(textToParse)
          if (!videoId) throw new Error('Could not extract video ID from URL')
          const transcript = await fetchYouTubeTranscriptBrowser(videoId)
          if (!transcript || transcript.length < 50) {
            throw new Error('No description available for this video.')
          }
          textToParse = transcript
        } catch (e) {
          throw new Error('YouTube fetch failed: ' + e.message)
        } finally {
          setFetchingTranscript(false)
        }
      }

      const result = await parseRecipeWithLLM(textToParse)
      setParsed(result)
    } catch (e) {
      setError('Parse failed: ' + e.message)
    } finally {
      setLoading(false)
      setFetchingTranscript(false)
    }
  }

  const handleSave = () => {
    if (!parsed) return
    const recipe = {
      ...parsed,
      id: Date.now(),
      savedAt: new Date().toISOString()
    }
    const updated = [recipe, ...recipes]
    setRecipes(updated)
    localStorage.setItem('recipemee_recipes', JSON.stringify(updated))
    setSaveMsg('Saved!')
    setTimeout(() => setSaveMsg(''), 2000)
    setRawText('')
    setParsed(null)
    setView('library')
    // Trigger immediate backup
    autoBackup()
  }

  const handleDelete = (id) => {
    const updated = recipes.filter(r => r.id !== id)
    setRecipes(updated)
    localStorage.setItem('recipemee_recipes', JSON.stringify(updated))
  }

  const filtered = recipes.filter(r => {
    const q = search.toLowerCase()
    return (
      r.title?.toLowerCase().includes(q) ||
      r.ingredients?.some(i => i.toLowerCase().includes(q)) ||
      r.tags?.some(t => t.toLowerCase().includes(q))
    )
  })

  const syncStatusText = {
    '': '',
    'syncing': '🔄 Syncing...',
    'saved': '✅ Backed up',
    'restored': '✅ Restored',
    'error': '❌ Sync failed'
  }[syncStatus]

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.title}>📋 RecipeMee</h1>
        <div style={styles.tabs}>
          <button style={{ ...styles.tab, ...(view === 'add' ? styles.tabActive : {}) }} onClick={() => setView('add')}>+ Add</button>
          <button style={{ ...styles.tab, ...(view === 'library' ? styles.tabActive : {}) }} onClick={() => setView('library')}>
            Library ({recipes.length})
          </button>
        </div>
      </header>

      {syncStatusText && (
        <div style={{
          ...styles.syncBanner,
          ...(syncStatus === 'error' ? styles.syncError : {}),
          ...(syncStatus === 'saved' || syncStatus === 'restored' ? styles.syncSuccess : {})
        }}>
          {syncStatusText}
        </div>
      )}

      {view === 'add' ? (
        <div style={styles.card}>
          <div style={styles.inputTypeToggle}>
            <button style={{ ...styles.toggleBtn, ...(inputType === 'text' ? styles.toggleActive : {}) }} onClick={() => setInputType('text')}>Paste Text</button>
            <button style={{ ...styles.toggleBtn, ...(inputType === 'url' ? styles.toggleActive : {}) }} onClick={() => setInputType('url')}>Recipe URL / YouTube</button>
          </div>

          <textarea
            style={styles.textarea}
            placeholder={inputType === 'url'
              ? 'Paste a recipe URL or YouTube video link...\nhttps://youtube.com/...'
              : 'Paste recipe text here...\nCopy from any website, blog, or document.'}
            value={rawText}
            onChange={e => setRawText(e.target.value)}
            rows={10}
          />

          {error && <div style={styles.error}>{error}</div>}

          <button
            style={styles.parseBtn}
            onClick={handleParse}
            disabled={loading || !rawText.trim() || fetchingTranscript}
          >
            {fetchingTranscript ? 'Fetching description...' : loading ? 'Parsing...' : isYouTubeURL(rawText) ? '🎬 Parse YouTube Recipe' : 'Parse Recipe'}
          </button>

          {parsed && (
            <div style={styles.parsedPreview}>
              <h2 style={styles.previewTitle}>{parsed.title || 'Untitled'}</h2>
              {parsed.description && <p style={styles.previewDesc}>{parsed.description}</p>}
              <div style={styles.meta}>
                {parsed.servings && <span>🍽 {parsed.servings}</span>}
                {parsed.totalTime && <span>⏱ {parsed.totalTime}</span>}
              </div>
              <h3>Ingredients ({parsed.ingredients?.length || 0})</h3>
              <ul style={styles.list}>
                {parsed.ingredients?.map((ing, i) => <li key={i}>{ing}</li>)}
              </ul>
              <h3>Instructions ({parsed.instructions?.length || 0} steps)</h3>
              <ol style={styles.list}>
                {parsed.instructions?.map((step, i) => <li key={i}>{step}</li>)}
              </ol>
              <button style={styles.saveBtn} onClick={handleSave}>
                {saveMsg || '💾 Save to Library'}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div>
          <div style={styles.syncRow}>
            <input
              style={styles.search}
              placeholder="Search recipes, ingredients, tags..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <div style={styles.syncActions}>
              {lastSync && <span style={styles.lastSync}>Synced {lastSync}</span>}
              <button style={styles.restoreBtn} onClick={handleRestore} title="Restore from NAS backup">
                ↩️ Restore
              </button>
            </div>
          </div>
          {nasCount !== null && (
            <div style={styles.nasInfo}>
              {nasCount > 0 ? `${nasCount} recipes in backup` : 'No backup yet'}
            </div>
          )}
          {filtered.length === 0 ? (
            <div style={styles.empty}>
              {recipes.length === 0 ? 'No recipes saved yet.' : 'No recipes match your search.'}
            </div>
          ) : (
            <div style={styles.grid}>
              {filtered.map(recipe => (
                <RecipeCard key={recipe.id} recipe={recipe} onDelete={handleDelete} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function RecipeCard({ recipe, onDelete }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div style={styles.recipeCard}>
      <div style={styles.cardHeader} onClick={() => setExpanded(!expanded)}>
        <h3 style={styles.cardTitle}>{recipe.title || 'Untitled'}</h3>
        <span style={styles.expandIcon}>{expanded ? '▲' : '▼'}</span>
      </div>
      {recipe.description && <p style={styles.cardDesc}>{recipe.description}</p>}
      <div style={styles.cardMeta}>
        {recipe.servings && <span>🍽 {recipe.servings}</span>}
        {recipe.totalTime && <span>⏱ {recipe.totalTime}</span>}
        {recipe.tags?.map(tag => <span key={tag} style={styles.tag}>{tag}</span>)}
      </div>
      {expanded && (
        <div style={styles.cardBody}>
          <h4>Ingredients</h4>
          <ul style={styles.list}>
            {recipe.ingredients?.map((ing, i) => <li key={i}>{ing}</li>)}
          </ul>
          <h4>Instructions</h4>
          <ol style={styles.list}>
            {recipe.instructions?.map((step, i) => <li key={i}>{step}</li>)}
          </ol>
          <button style={styles.deleteBtn} onClick={() => onDelete(recipe.id)}>🗑 Delete</button>
        </div>
      )}
    </div>
  )
}

const styles = {
  container: { maxWidth: '800px', margin: '0 auto', padding: '20px', fontFamily: 'system-ui, sans-serif' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' },
  title: { fontSize: '28px', margin: 0 },
  tabs: { display: 'flex', gap: '8px' },
  tab: { padding: '8px 16px', border: 'none', borderRadius: '8px', background: '#e0e0e0', cursor: 'pointer', fontSize: '14px' },
  tabActive: { background: '#333', color: '#fff' },
  syncBanner: { textAlign: 'center', padding: '8px', borderRadius: '8px', marginBottom: '16px', fontSize: '14px', background: '#f0f0f0', color: '#666' },
  syncError: { background: '#fee2e2', color: '#dc2626' },
  syncSuccess: { background: '#dcfce7', color: '#16a34a' },
  card: { background: '#fff', borderRadius: '16px', padding: '24px', boxShadow: '0 2px 12px rgba(0,0,0,0.08)' },
  inputTypeToggle: { display: 'flex', gap: '8px', marginBottom: '16px' },
  toggleBtn: { padding: '6px 14px', border: '2px solid #ddd', borderRadius: '8px', background: '#fff', cursor: 'pointer', fontSize: '13px' },
  toggleActive: { borderColor: '#333', background: '#333', color: '#fff' },
  textarea: { width: '100%', padding: '12px', borderRadius: '10px', border: '2px solid #ddd', fontSize: '14px', fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box' },
  error: { color: '#dc2626', padding: '10px', background: '#fee2e2', borderRadius: '8px', marginTop: '12px', fontSize: '14px' },
  parseBtn: { marginTop: '14px', width: '100%', padding: '14px', background: '#333', color: '#fff', border: 'none', borderRadius: '10px', fontSize: '16px', cursor: 'pointer', fontWeight: '600' },
  parsedPreview: { marginTop: '24px', padding: '20px', background: '#f8f9fa', borderRadius: '12px', border: '2px solid #e0e0e0', textAlign: 'left' },
  previewTitle: { margin: '0 0 8px', fontSize: '22px' },
  previewDesc: { color: '#666', margin: '0 0 12px', fontSize: '14px' },
  meta: { display: 'flex', gap: '16px', marginBottom: '16px', fontSize: '14px', color: '#555' },
  list: { paddingLeft: '24px', lineHeight: '1.7', fontSize: '14px' },
  saveBtn: { marginTop: '20px', width: '100%', padding: '14px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: '10px', fontSize: '16px', cursor: 'pointer', fontWeight: '600' },
  syncRow: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px' },
  syncActions: { display: 'flex', gap: '8px', alignItems: 'center' },
  lastSync: { fontSize: '12px', color: '#999', whiteSpace: 'nowrap' },
  restoreBtn: { padding: '8px 12px', background: '#f0f0f0', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', whiteSpace: 'nowrap' },
  nasInfo: { fontSize: '12px', color: '#999', marginBottom: '12px' },
  search: { flex: '1 1 100%', padding: '12px', borderRadius: '10px', border: '2px solid #ddd', fontSize: '15px', boxSizing: 'border-box' },
  empty: { textAlign: 'center', color: '#999', padding: '40px', fontSize: '15px' },
  grid: { display: 'flex', flexDirection: 'column', gap: '12px' },
  recipeCard: { background: '#fff', borderRadius: '14px', padding: '18px', boxShadow: '0 2px 8px rgba(0,0,0,0.07)', textAlign: 'left' },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' },
  cardTitle: { margin: 0, fontSize: '18px' },
  expandIcon: { fontSize: '12px', color: '#999' },
  cardDesc: { margin: '8px 0', color: '#666', fontSize: '13px' },
  cardMeta: { display: 'flex', flexWrap: 'wrap', gap: '10px', fontSize: '13px', color: '#777', marginTop: '8px' },
  tag: { background: '#f0f0f0', padding: '2px 8px', borderRadius: '6px' },
  cardBody: { marginTop: '16px', borderTop: '1px solid #eee', paddingTop: '16px' },
  deleteBtn: { marginTop: '12px', padding: '8px 14px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '13px' },
}

export default App
