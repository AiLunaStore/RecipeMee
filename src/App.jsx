import { useState, useEffect, useRef } from 'react'

// Key note: the worker URL is used instead of MiniMax directly to HIDE the API key from the browser.
// The key lives in the Cloudflare Worker secret, not in client-side code.
const WORKER_URL = 'https://recipemee-proxy.recipemee.workers.dev/chat'
const YOUTUBE_API_KEY = 'REDACTED-GOOGLE-API-KEY-2'
const MODEL = 'minimax-m2'
const NAS_BACKUP_URL = 'https://levin-nas-1.tail065159.ts.net/backup'

// Dark Mode Color Palette
const COLORS = {
  bg: '#0D0D0D',
  surface: '#1A1A1A',
  surfaceHover: '#242424',
  border: '#2A2A2A',
  primary: '#8B5CF6',      // Violet
  primaryHover: '#7C3AED',
  secondary: '#06B6D4',    // Cyan
  accent: '#F59E0B',       // Amber
  success: '#10B981',      // Emerald
  error: '#EF4444',        // Red
  text: '#FAFAFA',
  textSecondary: '#A1A1AA',
  textMuted: '#71717A',
}

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
    throw e
  }
}

function App() {
  const [view, setView] = useState('library')
  const [inputType, setInputType] = useState('text')
  const [rawText, setRawText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [parsed, setParsed] = useState(null)
  const [recipes, setRecipes] = useState([])
  const [search, setSearch] = useState('')
  const [saveMsg, setSaveMsg] = useState('')
  const [fetchingTranscript, setFetchingTranscript] = useState(false)
  const [syncStatus, setSyncStatus] = useState('')
  const [lastSync, setLastSync] = useState(localStorage.getItem('recipemee_last_sync') || '')
  const [nasCount, setNasCount] = useState(null)
  const syncTimerRef = useRef(null)

  useEffect(() => {
    const saved = localStorage.getItem('recipemee_recipes')
    if (saved) setRecipes(JSON.parse(saved))
    checkNASCount()
  }, [])

  useEffect(() => {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
    syncTimerRef.current = setTimeout(() => {
      if (recipes.length > 0) {
        autoBackup()
      }
    }, 5000)
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

  const syncStatusConfig = {
    '': null,
    'syncing': { text: 'Syncing...', color: COLORS.textSecondary },
    'saved': { text: '✓ Backed up', color: COLORS.success },
    'restored': { text: '✓ Restored', color: COLORS.success },
    'error': { text: 'Sync failed', color: COLORS.error }
  }[syncStatus]

  return (
    <div style={styles.root}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Playfair+Display:wght@400;600;700&display=swap');

        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: ${COLORS.bg}; color: ${COLORS.text}; font-family: 'Inter', sans-serif; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: ${COLORS.bg}; }
        ::-webkit-scrollbar-thumb { background: ${COLORS.border}; border-radius: 3px; }
        ::selection { background: ${COLORS.primary}; color: white; }
        input, textarea, button { font-family: inherit; }
      `}</style>

      {/* Header */}
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <h1 style={styles.logo}>RecipeMee</h1>
          <span style={styles.tagline}>your recipe library</span>
        </div>
        <div style={styles.headerRight}>
          {syncStatusConfig && (
            <span style={{...styles.syncBadge, color: syncStatusConfig.color}}>
              {syncStatusConfig.text}
            </span>
          )}
        </div>
      </header>

      {/* Bottom Nav */}
      <nav style={styles.bottomNav}>
        <button
          style={{...styles.navBtn, ...(view === 'library' ? styles.navBtnActive : {})}}
          onClick={() => setView('library')}
        >
          <span style={styles.navIcon}>📚</span>
          <span style={styles.navLabel}>Library</span>
        </button>
        <button
          style={{...styles.navBtn, ...(view === 'add' ? styles.navBtnActive : {})}}
          onClick={() => setView('add')}
        >
          <span style={styles.navIcon}>➕</span>
          <span style={styles.navLabel}>Add</span>
        </button>
      </nav>

      {/* Main Content */}
      <main style={styles.main}>

        {view === 'library' && (
          <div>
            {/* Search */}
            <div style={styles.searchWrapper}>
              <span style={styles.searchIcon}>🔍</span>
              <input
                style={styles.searchInput}
                placeholder="Search recipes, ingredients..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>

            {/* NAS Info Bar */}
            <div style={styles.nasBar}>
              <span style={styles.nasCount}>
                {nasCount !== null ? (
                  nasCount > 0 ? `${nasCount} recipes backed up` : 'No backup yet'
                ) : '...'}
              </span>
              {lastSync && <span style={styles.lastSync}>Last sync {lastSync}</span>}
              <button style={styles.restoreBtnSmall} onClick={handleRestore}>
                ↩ Restore
              </button>
            </div>

            {/* Recipe Grid */}
            {filtered.length === 0 ? (
              <div style={styles.emptyState}>
                <span style={styles.emptyIcon}>📝</span>
                <h3 style={styles.emptyTitle}>No recipes yet</h3>
                <p style={styles.emptyText}>Add your first recipe to get started</p>
                <button style={styles.emptyBtn} onClick={() => setView('add')}>
                  + Add Recipe
                </button>
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

        {view === 'add' && (
          <div style={styles.addView}>
            {/* Tab Toggle */}
            <div style={styles.tabToggle}>
              <button
                style={{...styles.tab, ...(inputType === 'text' ? styles.tabActive : {})}}
                onClick={() => setInputType('text')}
              >
                Text
              </button>
              <button
                style={{...styles.tab, ...(inputType === 'url' ? styles.tabActive : {})}}
                onClick={() => setInputType('url')}
              >
                URL / YouTube
              </button>
            </div>

            {/* Textarea */}
            <textarea
              style={styles.textarea}
              placeholder={
                inputType === 'url'
                  ? 'Paste recipe URL or YouTube link...\n\nSupports:\n• Any website URL\n• youtube.com/watch?v=...\n• youtu.be/...'
                  : 'Paste recipe text here...\n\nCopy from any website, blog, cookbook, or type it out.'
              }
              value={rawText}
              onChange={e => setRawText(e.target.value)}
              rows={12}
            />

            {/* Error */}
            {error && (
              <div style={styles.errorBox}>
                {error}
              </div>
            )}

            {/* Parse Button */}
            <button
              style={styles.parseBtn}
              onClick={handleParse}
              disabled={loading || !rawText.trim() || fetchingTranscript}
            >
              {fetchingTranscript ? '📺 Fetching...' : loading ? '⏳ Parsing...' : isYouTubeURL(rawText) ? '🎬 Get YouTube Recipe' : '✨ Parse Recipe'}
            </button>

            {/* Preview */}
            {parsed && (
              <div style={styles.preview}>
                <h2 style={styles.previewTitle}>{parsed.title || 'Untitled'}</h2>
                {parsed.description && (
                  <p style={styles.previewDesc}>{parsed.description}</p>
                )}
                <div style={styles.metaRow}>
                  {parsed.servings && <span style={styles.metaChip}>🍽 {parsed.servings}</span>}
                  {parsed.totalTime && <span style={styles.metaChip}>⏱ {parsed.totalTime}</span>}
                  {parsed.tags?.map(tag => (
                    <span key={tag} style={styles.tagChip}>{tag}</span>
                  ))}
                </div>

                <div style={styles.section}>
                  <h3 style={styles.sectionTitle}>Ingredients ({parsed.ingredients?.length || 0})</h3>
                  <ul style={styles.list}>
                    {parsed.ingredients?.map((ing, i) => <li key={i}>{ing}</li>)}
                  </ul>
                </div>

                <div style={styles.section}>
                  <h3 style={styles.sectionTitle}>Instructions ({parsed.instructions?.length || 0})</h3>
                  <ol style={styles.list}>
                    {parsed.instructions?.map((step, i) => <li key={i}>{step}</li>)}
                  </ol>
                </div>

                <button style={styles.saveBtn} onClick={handleSave}>
                  {saveMsg || '💾 Save to Library'}
                </button>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}

function RecipeCard({ recipe, onDelete }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div style={styles.card}>
      <div style={styles.cardHeader} onClick={() => setExpanded(!expanded)}>
        <div style={styles.cardInfo}>
          <h3 style={styles.cardTitle}>{recipe.title || 'Untitled'}</h3>
          <div style={styles.cardMeta}>
            {recipe.servings && <span>🍽 {recipe.servings}</span>}
            {recipe.totalTime && <span>⏱ {recipe.totalTime}</span>}
          </div>
        </div>
        <span style={{...styles.expandIcon, transform: expanded ? 'rotate(180deg)' : 'none'}}>
          ▼
        </span>
      </div>

      {expanded && (
        <div style={styles.cardBody}>
          {recipe.description && (
            <p style={styles.cardDesc}>{recipe.description}</p>
          )}
          {recipe.tags?.length > 0 && (
            <div style={styles.cardTags}>
              {recipe.tags.map(tag => (
                <span key={tag} style={styles.tagChip}>{tag}</span>
              ))}
            </div>
          )}
          <div style={styles.section}>
            <h4 style={styles.sectionTitle}>Ingredients</h4>
            <ul style={styles.list}>
              {recipe.ingredients?.map((ing, i) => <li key={i}>{ing}</li>)}
            </ul>
          </div>
          <div style={styles.section}>
            <h4 style={styles.sectionTitle}>Instructions</h4>
            <ol style={styles.list}>
              {recipe.instructions?.map((step, i) => <li key={i}>{step}</li>)}
            </ol>
          </div>
          <button style={styles.deleteBtn} onClick={() => onDelete(recipe.id)}>
            🗑 Delete
          </button>
        </div>
      )}
    </div>
  )
}

const styles = {
  root: {
    minHeight: '100vh',
    background: COLORS.bg,
    color: COLORS.text,
    paddingBottom: '80px',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '20px 20px 16px',
    borderBottom: `1px solid ${COLORS.border}`,
    position: 'sticky',
    top: 0,
    background: COLORS.bg,
    zIndex: 100,
  },
  headerLeft: {
    display: 'flex',
    flexDirection: 'column',
  },
  logo: {
    fontFamily: "'Playfair Display', serif",
    fontSize: '28px',
    fontWeight: 700,
    color: COLORS.text,
    letterSpacing: '-0.5px',
  },
  tagline: {
    fontSize: '12px',
    color: COLORS.textMuted,
    marginTop: '2px',
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  syncBadge: {
    fontSize: '13px',
    fontWeight: 500,
  },
  bottomNav: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    display: 'flex',
    background: COLORS.surface,
    borderTop: `1px solid ${COLORS.border}`,
    padding: '8px 24px',
    paddingBottom: 'max(8px, env(safe-area-inset-bottom))',
    zIndex: 100,
  },
  navBtn: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '4px',
    background: 'transparent',
    border: 'none',
    color: COLORS.textMuted,
    cursor: 'pointer',
    padding: '8px',
    borderRadius: '12px',
    transition: 'all 0.2s',
  },
  navBtnActive: {
    color: COLORS.primary,
    background: `${COLORS.primary}15`,
  },
  navIcon: {
    fontSize: '22px',
  },
  navLabel: {
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.5px',
  },
  main: {
    padding: '20px',
  },
  searchWrapper: {
    position: 'relative',
    marginBottom: '12px',
  },
  searchIcon: {
    position: 'absolute',
    left: '14px',
    top: '50%',
    transform: 'translateY(-50%)',
    fontSize: '16px',
  },
  searchInput: {
    width: '100%',
    padding: '14px 14px 14px 42px',
    background: COLORS.surface,
    border: `1px solid ${COLORS.border}`,
    borderRadius: '14px',
    color: COLORS.text,
    fontSize: '15px',
    outline: 'none',
    transition: 'border-color 0.2s',
  },
  nasBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    marginBottom: '20px',
    padding: '10px 14px',
    background: COLORS.surface,
    borderRadius: '10px',
    fontSize: '13px',
    color: COLORS.textSecondary,
    flexWrap: 'wrap',
  },
  nasCount: {
    flex: 1,
  },
  lastSync: {
    color: COLORS.textMuted,
  },
  restoreBtnSmall: {
    background: 'transparent',
    border: `1px solid ${COLORS.border}`,
    color: COLORS.textSecondary,
    padding: '6px 12px',
    borderRadius: '8px',
    fontSize: '12px',
    cursor: 'pointer',
  },
  grid: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '60px 20px',
    textAlign: 'center',
  },
  emptyIcon: {
    fontSize: '48px',
    marginBottom: '16px',
    opacity: 0.5,
  },
  emptyTitle: {
    fontSize: '20px',
    fontWeight: 600,
    marginBottom: '8px',
    color: COLORS.text,
  },
  emptyText: {
    fontSize: '14px',
    color: COLORS.textSecondary,
    marginBottom: '24px',
  },
  emptyBtn: {
    background: COLORS.primary,
    color: COLORS.text,
    border: 'none',
    padding: '14px 28px',
    borderRadius: '12px',
    fontSize: '15px',
    fontWeight: 600,
    cursor: 'pointer',
  },
  addView: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  tabToggle: {
    display: 'flex',
    background: COLORS.surface,
    borderRadius: '12px',
    padding: '4px',
  },
  tab: {
    flex: 1,
    padding: '10px',
    background: 'transparent',
    border: 'none',
    color: COLORS.textSecondary,
    fontSize: '14px',
    fontWeight: 500,
    cursor: 'pointer',
    borderRadius: '10px',
    transition: 'all 0.2s',
  },
  tabActive: {
    background: COLORS.primary,
    color: COLORS.text,
  },
  textarea: {
    width: '100%',
    padding: '16px',
    background: COLORS.surface,
    border: `1px solid ${COLORS.border}`,
    borderRadius: '14px',
    color: COLORS.text,
    fontSize: '15px',
    lineHeight: 1.6,
    resize: 'vertical',
    outline: 'none',
    minHeight: '200px',
  },
  errorBox: {
    padding: '12px 16px',
    background: `${COLORS.error}15`,
    border: `1px solid ${COLORS.error}30`,
    borderRadius: '10px',
    color: COLORS.error,
    fontSize: '14px',
  },
  parseBtn: {
    width: '100%',
    padding: '16px',
    background: COLORS.primary,
    color: COLORS.text,
    border: 'none',
    borderRadius: '14px',
    fontSize: '16px',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'background 0.2s',
  },
  preview: {
    background: COLORS.surface,
    border: `1px solid ${COLORS.border}`,
    borderRadius: '16px',
    padding: '20px',
    marginTop: '8px',
  },
  previewTitle: {
    fontFamily: "'Playfair Display', serif",
    fontSize: '24px',
    fontWeight: 700,
    marginBottom: '8px',
    color: COLORS.text,
  },
  previewDesc: {
    fontSize: '14px',
    color: COLORS.textSecondary,
    lineHeight: 1.6,
    marginBottom: '12px',
  },
  metaRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px',
    marginBottom: '16px',
  },
  metaChip: {
    padding: '6px 12px',
    background: `${COLORS.primary}20`,
    color: COLORS.primary,
    borderRadius: '20px',
    fontSize: '13px',
    fontWeight: 500,
  },
  tagChip: {
    padding: '6px 12px',
    background: COLORS.surfaceHover,
    color: COLORS.textSecondary,
    borderRadius: '20px',
    fontSize: '12px',
    fontWeight: 500,
  },
  section: {
    marginBottom: '16px',
  },
  sectionTitle: {
    fontSize: '14px',
    fontWeight: 600,
    color: COLORS.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    marginBottom: '10px',
  },
  list: {
    paddingLeft: '20px',
    lineHeight: 1.8,
    fontSize: '15px',
    color: COLORS.text,
  },
  saveBtn: {
    width: '100%',
    padding: '16px',
    background: COLORS.success,
    color: COLORS.text,
    border: 'none',
    borderRadius: '14px',
    fontSize: '16px',
    fontWeight: 600,
    cursor: 'pointer',
    marginTop: '8px',
  },
  card: {
    background: COLORS.surface,
    border: `1px solid ${COLORS.border}`,
    borderRadius: '16px',
    overflow: 'hidden',
    transition: 'all 0.2s',
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px',
    cursor: 'pointer',
  },
  cardInfo: {
    flex: 1,
  },
  cardTitle: {
    fontFamily: "'Playfair Display', serif",
    fontSize: '17px',
    fontWeight: 600,
    marginBottom: '4px',
  },
  cardMeta: {
    display: 'flex',
    gap: '12px',
    fontSize: '13px',
    color: COLORS.textMuted,
  },
  expandIcon: {
    fontSize: '12px',
    color: COLORS.textMuted,
    transition: 'transform 0.2s',
  },
  cardBody: {
    padding: '0 16px 16px',
    borderTop: `1px solid ${COLORS.border}`,
  },
  cardDesc: {
    fontSize: '14px',
    color: COLORS.textSecondary,
    lineHeight: 1.6,
    marginTop: '12px',
  },
  cardTags: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
    marginTop: '12px',
  },
  deleteBtn: {
    marginTop: '16px',
    padding: '10px 16px',
    background: `${COLORS.error}15`,
    color: COLORS.error,
    border: `1px solid ${COLORS.error}30`,
    borderRadius: '10px',
    fontSize: '14px',
    cursor: 'pointer',
    width: '100%',
  },
}

export default App
