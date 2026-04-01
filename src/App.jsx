import { useState, useEffect } from 'react'

// Key note: the worker URL is used instead of MiniMax directly to HIDE the API key from the browser.
// The key lives in the Cloudflare Worker secret, not in client-side code.
const WORKER_URL = 'https://recipemee-proxy.recipemee.workers.dev/chat'
const MODEL = 'minimax-m2'

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
    // Try multiple JSON extraction strategies
    let jsonMatch = content.match(/\{[\s\S]*?\}/s) // non-greedy
    if (!jsonMatch) jsonMatch = content.match(/\{[\s\S]*\}/) // greedy fallback
    if (!jsonMatch) throw new Error('No JSON found in response: ' + content.substring(0, 100))
    try {
      return JSON.parse(jsonMatch[0])
    } catch (e) {
      // Try to fix common JSON issues (trailing commas, etc.)
      const fixed = jsonMatch[0].replace(/,(\s*[}\]])/g, '$1')
      return JSON.parse(fixed)
    }
  })
}

function App() {
  const [view, setView] = useState('add') // 'add' | 'library'
  const [inputType, setInputType] = useState('text') // 'text' | 'url'
  const [rawText, setRawText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [parsed, setParsed] = useState(null)
  const [recipes, setRecipes] = useState([])
  const [search, setSearch] = useState('')
  const [saveMsg, setSaveMsg] = useState('')

  useEffect(() => {
    const saved = localStorage.getItem('recipemee_recipes')
    if (saved) setRecipes(JSON.parse(saved))
  }, [])

  const handleParse = async () => {
    if (!rawText.trim()) return
    setLoading(true)
    setError('')
    setParsed(null)
    try {
      const result = await parseRecipeWithLLM(rawText)
      setParsed(result)
    } catch (e) {
      setError('Parse failed: ' + e.message)
    } finally {
      setLoading(false)
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

      {view === 'add' ? (
        <div style={styles.card}>
          <div style={styles.inputTypeToggle}>
            <button style={{ ...styles.toggleBtn, ...(inputType === 'text' ? styles.toggleActive : {}) }} onClick={() => setInputType('text')}>Paste Text</button>
            <button style={{ ...styles.toggleBtn, ...(inputType === 'url' ? styles.toggleActive : {}) }} onClick={() => setInputType('url')}>Recipe URL</button>
          </div>

          <textarea
            style={styles.textarea}
            placeholder={inputType === 'url' ? 'Paste recipe URL...\nhttps://example.com/recipe/...' : 'Paste recipe text here...\nCopy from any website, blog, or document.'}
            value={rawText}
            onChange={e => setRawText(e.target.value)}
            rows={10}
          />

          {error && <div style={styles.error}>{error}</div>}

          <button style={styles.parseBtn} onClick={handleParse} disabled={loading || !rawText.trim()}>
            {loading ? 'Parsing...' : 'Parse Recipe'}
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
          <input
            style={styles.search}
            placeholder="Search recipes, ingredients, tags..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
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
  search: { width: '100%', padding: '12px', borderRadius: '10px', border: '2px solid #ddd', fontSize: '15px', marginBottom: '20px', boxSizing: 'border-box' },
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
