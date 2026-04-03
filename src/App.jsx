import { useState, useEffect, useRef, useCallback } from 'react'

const WORKER_URL = 'https://levin-nas-1.tail065159.ts.net/chat'
const YOUTUBE_API_KEY = 'REDACTED-GOOGLE-API-KEY-2'
const MODEL = 'deepseek-chat'
const NAS_BACKUP_URL = 'https://levin-nas-1.tail065159.ts.net/backup'
const NAS_SCRAPE_URL = 'https://levin-nas-1.tail065159.ts.net/scrape'

const COLORS = {
  bg: '#0D0D0D',
  surface: '#1A1A1A',
  surfaceHover: '#242424',
  border: '#2A2D2D',
  primary: '#8B5CF6',
  primaryHover: '#7C3AED',
  secondary: '#06B6D4',
  accent: '#F59E0B',
  success: '#10B981',
  error: '#EF4444',
  text: '#FAFAFA',
  textSecondary: '#A1A1AA',
  textMuted: '#71717A',
  danger: '#EF4444',
  star: '#FBBF24',
}

const ALL_TAGS = [
  // Meal Type
  'Breakfast', 'Lunch', 'Dinner', 'Dessert', 'Snack', 'Drinks', 'Appetizer',
  // Dietary
  'Vegan', 'Vegetarian', 'Gluten-Free', 'Keto', 'Low-Carb', 'Dairy-Free', 'Nut-Free',
  // Cuisine
  'Italian', 'Mexican', 'Asian', 'Chinese', 'Japanese', 'Thai', 'Indian', 'Mediterranean', 'American', 'French', 'Korean', 'Vietnamese',
  // Style
  'Quick (<30min)', 'Healthy', 'Comfort Food', 'Spicy', 'One-Pot', 'Meal-Prep', 'Gourmet', 'Budget-Friendly', 'Kid-Friendly'
]

function isYouTubeURL(text) {
  return /youtube\.com|youtu\.be/.test(text)
}

function extractVideoId(url) {
  const patterns = [/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/]
  for (const pattern of patterns) {
    const match = url.match(pattern)
    if (match) return match[1]
  }
  return null
}

async function fetchYouTubeTranscriptBrowser(videoId) {
  const detailsUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoId}&key=${YOUTUBE_API_KEY}`
  const detailsRes = await fetch(detailsUrl)
  if (!detailsRes.ok) throw new Error('YouTube API unavailable')
  const details = await detailsRes.json()
  if (!details.items?.length) throw new Error('Video not found')
  const snippet = details.items[0].snippet || {}
  const description = snippet.description || ''
  // Get highest quality thumbnail
  const thumbnails = snippet.thumbnails || {}
  const thumbnail = thumbnails.maxres?.url || thumbnails.high?.url || thumbnails.medium?.url || thumbnails.standard?.url || ''
  if (description.length < 50) throw new Error('No description found')
  return { description, thumbnail }
}

async function fetchRecipeURL(pageUrl) {
  // Use our NAS (residential IP) to fetch the URL - bypasses recipe site blocks
  const proxyUrl = `${NAS_SCRAPE_URL}?url=${encodeURIComponent(pageUrl)}`
  const response = await fetch(proxyUrl)
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(err.error || 'Failed to fetch URL')
  }
  const data = await response.json()
  if (data.error) throw new Error(data.error)

  // Limit text to 8000 chars to avoid overwhelming the LLM
  let text = (data.text || '').substring(0, 8000)
  return { text, photoUrl: data.photoUrl || '' }
}

function parseRecipeWithLLM(rawText) {
  return fetch(WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      temperature: 0.2,
      messages: [{
        role: 'system',
        content: `Parse this recipe into clean JSON. Be aggressive with tagging — detect EVERYTHING relevant.
For each ingredient, extract the quantity, unit, and item separately.
For instructions, detect if there's a timer mentioned (like "5 mins", "30 minutes", "1 hour").

Return ONLY the JSON object with this exact structure:
{
  "title": "Recipe name",
  "description": "1-2 sentence description",
  "servings": "4 servings",
  "prepTime": "15 mins",
  "cookTime": "30 mins",
  "totalTime": "45 mins",
  "ingredients": [{"text": "full ingredient text", "qty": "2", "unit": "cups", "item": "flour"}],
  "instructions": [{"text": "step text", "timer": "5 mins"}],
  "tags": ["Breakfast", "Vegan", "Quick (<30min)", "Healthy", "Italian"],
  "photoUrl": ""
}

IMPORTANT — Tag Detection Rules:
- MEAL TYPE (pick ALL that apply): Breakfast, Lunch, Dinner, Dessert, Snack, Drinks, Appetizer
- DIETARY: Vegan, Vegetarian, Gluten-Free, Keto, Low-Carb, Dairy-Free, Nut-Free
- CUISINE: Italian, Mexican, Asian, Chinese, Japanese, Thai, Indian, Mediterranean, American, French, Korean, Vietnamese
- STYLE: Quick (<30min), Healthy, Comfort Food, Spicy, One-Pot, Meal-Prep, Gourmet, Budget-Friendly, Kid-Friendly
- Based on TOTAL TIME: if totalTime is under 30 mins, tag "Quick (<30min)"

Return ONLY the JSON, nothing else.`
      }, { role: 'user', content: rawText }]
    })
  })
  .then(r => r.json())
  .then(data => {
    const content = data.choices?.[0]?.message?.content || ''
    let jsonStr = null

    // Strategy 1: JSON code block
    const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim()

    // Strategy 2: Extract JSON by bracket counting from first {
    if (!jsonStr) {
      const firstBrace = content.indexOf('{')
      if (firstBrace !== -1) {
        let depth = 0
        let end = -1
        for (let i = firstBrace; i < content.length; i++) {
          if (content[i] === '{') depth++
          else if (content[i] === '}') {
            depth--
            if (depth === 0) { end = i; break }
          }
        }
        if (end !== -1) jsonStr = content.substring(firstBrace, end + 1)
      }
    }

    if (!jsonStr) {
      // Return a minimal valid recipe so user doesn't lose their data
      return {
        title: 'Untitled Recipe',
        description: content.substring(0, 200),
        servings: '4 servings',
        prepTime: null,
        cookTime: null,
        totalTime: null,
        ingredients: [],
        instructions: [],
        tags: [],
        photoUrl: ''
      }
    }

    // Fix common JSON issues
    let fixed = jsonStr
      .replace(/,\s*([}\]])/g, '$1')  // trailing commas
      .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')  // unquoted keys
      .replace(/:\s*'([^']*)'/g, ': "$1"')  // single quotes to double quotes

    try { return JSON.parse(fixed) }
    catch (e) {
      // Last resort: strip all non-ASCII
      const clean = fixed.replace(/[^\x20-\x7E\n\r\t{}[],:""-]/g, '')
      try { return JSON.parse(clean) }
      catch (e2) {
        // If content is too long, try with just the first valid portion
        const titleMatch = content.match(/"title":\s*"([^"]+)"/)
        const descMatch = content.match(/"description":\s*"([^"]+)"/)
        if (titleMatch || descMatch) {
          return {
            title: titleMatch ? titleMatch[1] : 'Untitled Recipe',
            description: descMatch ? descMatch[1] : '',
            servings: '4 servings',
            prepTime: null,
            cookTime: null,
            totalTime: null,
            ingredients: [],
            instructions: [],
            tags: [],
            photoUrl: ''
          }
        }
        throw new Error('Recipe parse error — the text may not be a standard recipe format')
      }
    }
  })
}

async function backupToNAS(recipes) {
  const response = await fetch(NAS_BACKUP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipes, lastUpdated: new Date().toISOString() })
  })
  if (!response.ok) throw new Error('Backup failed')
  return response.json()
}

async function restoreFromNAS() {
  const response = await fetch(NAS_BACKUP_URL)
  if (!response.ok) throw new Error('Restore failed')
  return response.json()
}

// Parse a quantity string like "1 1/2" or "0.5" into a float
function parseQty(qtyStr) {
  if (!qtyStr) return null
  const str = qtyStr.trim()
  // Handle fractions like "1/2", "3/4"
  if (/^\d+\/\d+$/.test(str)) {
    const [n, d] = str.split('/').map(Number)
    return n / d
  }
  // Handle mixed numbers like "1 1/2"
  const parts = str.split(' ')
  let total = 0
  for (const p of parts) {
    if (p.includes('/')) {
      const [n, d] = p.split('/').map(Number)
      total += n / d
    } else {
      total += parseFloat(p) || 0
    }
  }
  return total || null
}

// Scale an ingredient quantity by a factor
function scaleIngredientQty(ing, scale) {
  if (!ing.qty) return ing
  const qty = parseQty(ing.qty)
  if (qty === null) return ing
  const scaled = qty * scale
  // Format nicely
  let formatted
  if (Number.isInteger(scaled)) {
    formatted = String(scaled)
  } else if (Math.abs(scaled - 0.25) < 0.01) {
    formatted = '¼'
  } else if (Math.abs(scaled - 0.33) < 0.02) {
    formatted = '⅓'
  } else if (Math.abs(scaled - 0.5) < 0.01) {
    formatted = '½'
  } else if (Math.abs(scaled - 0.67) < 0.02) {
    formatted = '⅔'
  } else if (Math.abs(scaled - 0.75) < 0.01) {
    formatted = '¾'
  } else if (Math.abs(scaled - 0.125) < 0.01) {
    formatted = '⅛'
  } else {
    formatted = scaled % 1 === 0 ? scaled.toFixed(0) : scaled.toFixed(1).replace(/\.0$/, '')
  }
  return { ...ing, qty: formatted }
}

export default function App() {
  const [view, setView] = useState('library')
  const [rawText, setRawText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [parsed, setParsed] = useState(null)
  const [recipes, setRecipes] = useState([])
  const [search, setSearch] = useState('')
  const [saveMsg, setSaveMsg] = useState('')
  const [fetchingTranscript, setFetchingTranscript] = useState(false)
  const [sourceUrl, setSourceUrl] = useState('')
  const [syncStatus, setSyncStatus] = useState('')
  const [lastSync, setLastSync] = useState(localStorage.getItem('recipemee_last_sync') || '')
  const [nasCount, setNasCount] = useState(null)
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false)
  const [selectedRecipe, setSelectedRecipe] = useState(null)
  const [currentStep, setCurrentStep] = useState(0)
  const [servingScale, setServingScale] = useState(1)
  const [groceryList, setGroceryList] = useState([])
  const [groceryChecked, setGroceryChecked] = useState({})
  const syncTimerRef = useRef(null)

  useEffect(() => {
    const saved = localStorage.getItem('recipemee_recipes')
    if (saved) setRecipes(JSON.parse(saved))
    const savedGrocery = localStorage.getItem('recipemee_grocery')
    if (savedGrocery) setGroceryList(JSON.parse(savedGrocery))
    checkNASCount()
  }, [])

  useEffect(() => {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
    syncTimerRef.current = setTimeout(() => {
      if (recipes.length > 0) autoBackup()
    }, 5000)
    return () => clearTimeout(syncTimerRef.current)
  }, [recipes])

  async function checkNASCount() {
    try {
      const data = await restoreFromNAS()
      setNasCount(data.count || 0)
    } catch { setNasCount(null) }
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
    } catch {
      setSyncStatus('error')
      setTimeout(() => setSyncStatus(''), 3000)
    }
  }

  async function handleRestore() {
    if (!window.confirm('Replace current recipes with backup?')) return
    try {
      setSyncStatus('syncing')
      const data = await restoreFromNAS()
      if (data.recipes?.length) {
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

      // YouTube URL — get description via API
      if (isYouTubeURL(textToParse)) {
        setFetchingTranscript(true)
        setSourceUrl(textToParse)
        try {
          const videoId = extractVideoId(textToParse)
          if (!videoId) throw new Error('Could not extract video ID from this YouTube URL')
          const result = await fetchYouTubeTranscriptBrowser(videoId)
          if (!result.description || result.description.length < 50) {
            throw new Error('This video has no description. Try copying the recipe text manually.')
          }
          textToParse = result.description
          if (result.thumbnail) {
            setParsed(prev => ({ ...prev, photoUrl: result.thumbnail }))
          }
        } catch (e) {
          setFetchingTranscript(false)
          setError(e.message)
          setLoading(false)
          return
        }
        setFetchingTranscript(false)
      } else if (textToParse.startsWith('http://') || textToParse.startsWith('https://')) {
        // Generic URL — fetch page content
        setFetchingTranscript(true)
        setSourceUrl(textToParse) // remember URL for saving
        try {
          const result = await fetchRecipeURL(textToParse)
          if (!result.text || result.text.length < 100) {
            throw new Error('Could not read this page. Try copying the recipe text manually instead.')
          }
          textToParse = result.text
          // Also store photoUrl for later
          if (result.photoUrl) {
            setParsed(prev => ({ ...prev, photoUrl: result.photoUrl }))
          }
        } catch (e) {
          setFetchingTranscript(false)
          setError(e.message)
          setLoading(false)
          return
        }
        setFetchingTranscript(false)
      } else {
        setSourceUrl('') // plain text, no source URL
      }
      // Plain text — use as-is

      const result = await parseRecipeWithLLM(textToParse)
      setParsed(result)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
      setFetchingTranscript(false)
    }
  }

  function autoTagRecipe(recipe, rawText) {
    const text = (rawText || '').toLowerCase()
    const title = (recipe.title || '').toLowerCase()
    const combined = title + ' ' + text
    const tags = new Set(recipe.tags || [])

    // Auto-detect meal type
    const breakfastWords = ['breakfast', 'pancake', 'waffle', 'omelette', 'scrambled', 'cereal', 'oatmeal', 'oats', 'toast', 'bacon', 'eggs', 'muffin', 'french toast', 'hash brown', 'sausage', 'bagel', 'smoothie bowl']
    const lunchWords = ['sandwich', 'wrap', 'salad', 'soup', 'lunch', 'bowl', 'taco', 'quesadilla', 'panini', 'sub', 'burger']
    const dinnerWords = ['dinner', 'supper', 'steak', 'roast', 'pasta', 'stir fry', 'curry', 'risotto', 'lasagna', 'enchilada', 'baked', 'grilled', 'simmer', 'casserole']
    const dessertWords = ['dessert', 'cake', 'cookie', 'brownie', 'pie', 'ice cream', 'pudding', 'mousse', 'cheesecake', 'chocolate', 'candy', 'fudge', 'tart', 'cobbler']
    const snackWords = ['snack', 'trail mix', 'popcorn', 'crackers', 'dip', 'hummus', 'nuts', 'granola', 'energy ball']
    const drinkWords = ['smoothie', 'juice', 'coffee', 'tea', 'latte', 'shake', 'cocktail', 'lemonade', 'infused water', 'milkshake', 'hot chocolate', 'chai', 'espresso']

    if (breakfastWords.some(w => combined.includes(w))) tags.add('Breakfast')
    if (lunchWords.some(w => combined.includes(w))) tags.add('Lunch')
    if (dinnerWords.some(w => combined.includes(w))) tags.add('Dinner')
    if (dessertWords.some(w => combined.includes(w))) tags.add('Dessert')
    if (snackWords.some(w => combined.includes(w))) tags.add('Snack')
    if (drinkWords.some(w => combined.includes(w))) tags.add('Drinks')

    // Auto-detect dietary
    const veganWords = ['vegan', 'plant-based', 'plant based', 'dairy-free', 'egg-free', 'no animal']
    const vegWords = ['vegetarian', 'no meat', 'meatless', 'veggie']
    const gfWords = ['gluten-free', 'gluten free', 'celiac', 'gf ', 'wheat-free', 'all-purpose flour']
    const ketoWords = ['keto', 'low-carb', 'low carb', 'atkins', 'banting']
    const dairyWords = ['dairy-free', 'lactose-free', 'lactose free', 'dairy free', 'no dairy', 'vegan']

    if (veganWords.some(w => combined.includes(w))) tags.add('Vegan')
    if (vegWords.some(w => combined.includes(w)) && !combined.includes('non-vegetarian')) tags.add('Vegetarian')
    if (gfWords.some(w => combined.includes(w))) tags.add('Gluten-Free')
    if (ketoWords.some(w => combined.includes(w))) tags.add('Keto')
    if (dairyWords.some(w => combined.includes(w))) tags.add('Dairy-Free')

    // Auto-detect cuisine
    if (combined.includes('italian') || combined.includes('pasta') || combined.includes('pizza') || combined.includes('risotto') || combined.includes('spaghetti') || combined.includes('lasagna') || combined.includes('basil') && combined.includes('oregano')) tags.add('Italian')
    if (combined.includes('mexican') || combined.includes('taco') || combined.includes('burrito') || combined.includes('salsa') || combined.includes('enchilada') || combined.includes('quesadilla') || combined.includes('guacamole') || combined.includes('tortilla')) tags.add('Mexican')
    if (combined.includes('chinese') || combined.includes('dim sum') || combined.includes('wok') || combined.includes('soy sauce') && combined.includes('ginger')) tags.add('Chinese')
    if (combined.includes('japanese') || combined.includes('sushi') || combined.includes('ramen') || combined.includes('miso') || combined.includes('teriyaki') || combined.includes('tempura')) tags.add('Japanese')
    if (combined.includes('thai') || combined.includes('pad thai') || combined.includes('curry') && combined.includes('coconut')) tags.add('Thai')
    if (combined.includes('indian') || combined.includes('curry') || combined.includes('garam masala') || combined.includes('tikka') || combined.includes('naan') || combined.includes('paneer')) tags.add('Indian')
    if (combined.includes('korean') || combined.includes('kimchi') || combined.includes('bibimbap') || combined.includes('gochujang') || combined.includes('bulgogi')) tags.add('Korean')
    if (combined.includes('vietnamese') || combined.includes('pho') || combined.includes('banh mi') || combined.includes('vermicelli')) tags.add('Vietnamese')
    if (combined.includes('mediterranean') || combined.includes('hummus') || combined.includes('falafel') || combined.includes('tzatziki') || combined.includes('olive oil') && combined.includes('oregano')) tags.add('Mediterranean')

    // Auto-detect style
    if (combined.includes('quick') || combined.includes('easy') || combined.includes('15 minute') || combined.includes('20 minute') || combined.includes('30 minute') || combined.includes('fast') || combined.includes('under 30')) tags.add('Quick (<30min)')
    if (combined.includes('healthy') || combined.includes('nutritious') || combined.includes('low calorie') || combined.includes('high protein') || combined.includes('salad') || combined.includes('lean')) tags.add('Healthy')
    if (combined.includes('comfort') || combined.includes('hearty') || combined.includes('stick to your ribs') || combined.includes('creamy') || combined.includes('mac and cheese') || combined.includes('potato')) tags.add('Comfort Food')
    if (combined.includes('spicy') || combined.includes('hot') || combined.includes('chili') || combined.includes('jalapeño') || combined.includes('cayenne') || combined.includes('red pepper')) tags.add('Spicy')
    if (combined.includes('one-pot') || combined.includes('one pot') || combined.includes('one-pan') || combined.includes('sheet pan')) tags.add('One-Pot')
    if (combined.includes('meal prep') || combined.includes('meal-prep') || combined.includes('batch') || combined.includes('freezer')) tags.add('Meal-Prep')
    if (combined.includes('kid') || combined.includes('child') || combined.includes('toddler') || combined.includes('family friendly')) tags.add('Kid-Friendly')
    if (combined.includes('budget') || combined.includes('cheap') || combined.includes('affordable') || combined.includes('economical')) tags.add('Budget-Friendly')

    return Array.from(tags)
  }

  function handleSave() {
    if (!parsed) return
    let servings = parsed.servings || '4'
    if (typeof servings === 'number') servings = String(servings)
    let ingredients = parsed.ingredients || []
    if (typeof ingredients[0] === 'string') {
      ingredients = ingredients.map(text => ({ text, qty: null, unit: null, item: text }))
    }
    const autoTags = autoTagRecipe(parsed, rawText)
    const recipe = {
      ...parsed,
      servings,
      ingredients,
      tags: autoTags.length > 0 ? autoTags : parsed.tags || [],
      photoUrl: parsed.photoUrl || '',
      sourceUrl: sourceUrl || parsed.sourceUrl || '',
      id: Date.now(),
      savedAt: new Date().toISOString(),
      favorite: false,
    }
    const updated = [recipe, ...recipes]
    setRecipes(updated)
    localStorage.setItem('recipemee_recipes', JSON.stringify(updated))
    setSaveMsg('Saved!')
    setTimeout(() => { setSaveMsg(''); setRawText(''); setParsed(null); setView('library') }, 1500)
    autoBackup()
  }

  function toggleFavorite(id) {
    const updated = recipes.map(r => r.id === id ? { ...r, favorite: !r.favorite } : r)
    setRecipes(updated)
    localStorage.setItem('recipemee_recipes', JSON.stringify(updated))
  }

  function handleDelete(id) {
    const updated = recipes.filter(r => r.id !== id)
    setRecipes(updated)
    localStorage.setItem('recipemee_recipes', JSON.stringify(updated))
  }

  function enterCookMode(recipe) {
    setSelectedRecipe(recipe)
    setCurrentStep(0)
    setServingScale(1)
    setView('cook')
  }

  function addToGroceryList(recipe) {
    const items = recipe.ingredients.map(ing => {
      const text = typeof ing === 'string' ? ing : ing.text || ''
      return text
    }).filter(Boolean)
    const updated = [...new Set([...groceryList, ...items])]
    setGroceryList(updated)
    localStorage.setItem('recipemee_grocery', JSON.stringify(updated))
  }

  function toggleGroceryItem(item) {
    setGroceryChecked(prev => ({ ...prev, [item]: !prev[item] }))
  }

  function clearGrocery() {
    setGroceryList([])
    setGroceryChecked({})
    localStorage.removeItem('recipemee_grocery')
  }

  // Filter recipes
  let filtered = recipes
  if (search.trim()) {
    const q = search.toLowerCase()
    filtered = filtered.filter(r =>
      r.title?.toLowerCase().includes(q) ||
      r.ingredients?.some(i => (typeof i === 'string' ? i : i.text || '').toLowerCase().includes(q)) ||
      r.tags?.some(t => t.toLowerCase().includes(q)) ||
      (r.description || '').toLowerCase().includes(q)
    )
  }
  if (showFavoritesOnly) filtered = filtered.filter(r => r.favorite)

  // Serving scale
  let scaledIngredients = parsed?.ingredients || []
  if (servingScale !== 1 && scaledIngredients.length > 0) {
    scaledIngredients = scaledIngredients.map(ing => scaleIngredientQty(ing, servingScale))
  }

  const syncStatusConfig = { '': null, syncing: { text: 'Syncing...', color: COLORS.textSecondary }, saved: { text: '✓ Backed up', color: COLORS.success }, restored: { text: '✓ Restored', color: COLORS.success }, error: { text: 'Sync failed', color: COLORS.error } }[syncStatus]

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
        button:disabled { opacity: 0.5; cursor: not-allowed; }
      `}</style>

      <header style={styles.header}>
        <div>
          <h1 style={styles.logo}>RecipeMee</h1>
          <span style={styles.tagline}>your recipe library</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {syncStatusConfig && <span style={{ fontSize: '13px', color: syncStatusConfig.color }}>{syncStatusConfig.text}</span>}
          <button style={styles.iconBtn} onClick={() => setView('grocery')} title="Grocery List">
            🛒 {groceryList.length > 0 && <span style={styles.badge}>{groceryList.length}</span>}
          </button>
        </div>
      </header>

      <nav style={styles.bottomNav}>
        <button style={{ ...styles.navBtn, ...(view === 'library' ? styles.navBtnActive : {}) }} onClick={() => setView('library')}>
          <span style={styles.navIcon}>📚</span><span style={styles.navLabel}>Library</span>
        </button>
        <button style={{ ...styles.navBtn, ...(view === 'add' ? styles.navBtnActive : {}) }} onClick={() => setView('add')}>
          <span style={styles.navIcon}>➕</span><span style={styles.navLabel}>Add</span>
        </button>
        <button style={{ ...styles.navBtn, ...(view === 'grocery' ? styles.navBtnActive : {}) }} onClick={() => setView('grocery')}>
          <span style={styles.navIcon}>🛒</span><span style={styles.navLabel}>Grocery</span>
          {groceryList.length > 0 && <span style={styles.badge}>{groceryList.length}</span>}
        </button>
      </nav>

      <main style={styles.main}>
        {/* ===== LIBRARY VIEW ===== */}
        {view === 'library' && (
          <div>
            <div style={styles.searchWrapper}>
              <span style={styles.searchIcon}>🔍</span>
              <input style={styles.searchInput} placeholder="Search recipes, ingredients, tags..." value={search} onChange={e => setSearch(e.target.value)} />
            </div>

            {/* NAS Bar */}
            <div style={styles.nasBar}>
              <button
                style={{ ...styles.favToggle, color: showFavoritesOnly ? COLORS.star : COLORS.textMuted }}
                onClick={() => setShowFavoritesOnly(!showFavoritesOnly)}
              >
                ♥ Favorites {showFavoritesOnly ? 'On' : ''}
              </button>
              <span style={{ flex: 1, fontSize: '13px', color: COLORS.textSecondary, textAlign: 'center' }}>
                {nasCount !== null ? (nasCount > 0 ? `${nasCount} backed up` : 'No backup yet') : '...'}
              </span>
              {lastSync && <span style={{ fontSize: '12px', color: COLORS.textMuted }}>Synced {lastSync}</span>}
              <button style={styles.restoreBtnSmall} onClick={handleRestore}>↩</button>
            </div>

            {filtered.length === 0 ? (
              <div style={styles.emptyState}>
                <span style={{ fontSize: '48px', marginBottom: '16px' }}>📝</span>
                <h3 style={{ fontSize: '20px', fontWeight: 600, marginBottom: '8px' }}>No recipes yet</h3>
                <p style={{ fontSize: '14px', color: COLORS.textSecondary, marginBottom: '24px' }}>
                  {recipes.length === 0 ? 'Add your first recipe to get started' : 'No recipes match your filters'}
                </p>
                <button style={styles.primaryBtn} onClick={() => setView('add')}>+ Add Recipe</button>
              </div>
            ) : (
              <div style={styles.grid}>
                {filtered.map(recipe => (
                  <RecipeCard
                    key={recipe.id}
                    recipe={recipe}
                    onDelete={handleDelete}
                    onToggleFavorite={toggleFavorite}
                    onEnterCook={enterCookMode}
                    onAddToGrocery={addToGroceryList}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* ===== ADD VIEW ===== */}
        {view === 'add' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <textarea
              style={styles.textarea}
              placeholder={'Paste a recipe URL, YouTube link, or recipe text...\n\nWorks with:\n• Any recipe website URL\n• YouTube video URLs\n• Copied recipe text from any source'}
              value={rawText}
              onChange={e => setRawText(e.target.value)}
              rows={12}
            />

            {error && <div style={styles.errorBox}>{error}</div>}

            <button style={styles.primaryBtn} onClick={handleParse} disabled={loading || !rawText.trim() || fetchingTranscript}>
              {fetchingTranscript ? '📺 Getting recipe...' : loading ? '⏳ Parsing...' : '✨ Get Recipe'}
            </button>

            {parsed && <RecipePreview recipe={parsed} scaledIngredients={scaledIngredients} servingScale={servingScale} setServingScale={setServingScale} onSave={handleSave} saveMsg={saveMsg} />}
          </div>
        )}

        {/* ===== COOK MODE VIEW ===== */}
        {view === 'cook' && selectedRecipe && (
          <CookMode
            recipe={selectedRecipe}
            currentStep={currentStep}
            setCurrentStep={setCurrentStep}
            servingScale={servingScale}
            setServingScale={setServingScale}
            onBack={() => setView('library')}
          />
        )}

        {/* ===== GROCERY VIEW ===== */}
        {view === 'grocery' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ fontSize: '24px', fontFamily: "'Playfair Display', serif" }}>Grocery List</h2>
              {groceryList.length > 0 && (
                <button style={styles.clearBtn} onClick={clearGrocery}>Clear All</button>
              )}
            </div>
            {groceryList.length === 0 ? (
              <div style={styles.emptyState}>
                <span style={{ fontSize: '48px', marginBottom: '16px' }}>🛒</span>
                <p style={{ color: COLORS.textSecondary }}>Add ingredients from any recipe</p>
              </div>
            ) : (
              <div style={styles.groceryList}>
                {groceryList.map(item => (
                  <div
                    key={item}
                    style={{ ...styles.groceryItem, ...(groceryChecked[item] ? styles.groceryItemChecked : {}) }}
                    onClick={() => toggleGroceryItem(item)}
                  >
                    <span style={{ ...styles.groceryCheck, ...(groceryChecked[item] ? styles.groceryCheckChecked : {}) }}>
                      {groceryChecked[item] ? '✓' : ''}
                    </span>
                    <span style={{ flex: 1 }}>{item}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}

function RecipeCard({ recipe, onDelete, onToggleFavorite, onEnterCook, onAddToGrocery }) {
  const [expanded, setExpanded] = useState(false)
  const hasIngredients = recipe.ingredients?.length > 0
  const hasInstructions = recipe.instructions?.length > 0

  return (
    <div style={styles.card}>
      {recipe.photoUrl && (
        <div style={styles.cardPhotoWrapper} onClick={() => setExpanded(!expanded)}>
          <img src={recipe.photoUrl} alt={recipe.title} style={styles.cardPhoto} onError={e => e.target.style.display = 'none'} />
          {recipe.sourceUrl && (
            <a
              href={recipe.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={styles.photoLink}
              onClick={e => e.stopPropagation()}
              title="View original recipe"
            >
              🔗
            </a>
          )}
        </div>
      )}
      <div style={styles.cardHeader} onClick={() => setExpanded(!expanded)}>
        <div style={{ flex: 1 }}>
          {!recipe.photoUrl && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
              <h3 style={styles.cardTitle}>{recipe.title || 'Untitled'}</h3>
              <button
                style={{ ...styles.favoriteBtn, color: recipe.favorite ? COLORS.star : COLORS.textMuted }}
                onClick={e => { e.stopPropagation(); onToggleFavorite(recipe.id) }}
              >
                {recipe.favorite ? '♥' : '♡'}
              </button>
            </div>
          )}
          {recipe.photoUrl && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', paddingTop: '12px' }}>
              <h3 style={styles.cardTitle}>{recipe.title || 'Untitled'}</h3>
              <button
                style={{ ...styles.favoriteBtn, color: recipe.favorite ? COLORS.star : COLORS.textMuted }}
                onClick={e => { e.stopPropagation(); onToggleFavorite(recipe.id) }}
              >
                {recipe.favorite ? '♥' : '♡'}
              </button>
            </div>
          )}
          <div style={styles.cardMeta}>
            {recipe.servings && <span>🍽 {recipe.servings}</span>}
            {recipe.totalTime && <span>⏱ {recipe.totalTime}</span>}
            {recipe.tags?.slice(0, 2).map(tag => <span key={tag} style={styles.tag}>{tag}</span>)}
          </div>
        </div>
        <span style={{ ...styles.expandIcon, transform: expanded ? 'rotate(180deg)' : 'none' }}>▼</span>
      </div>

      {expanded && (
        <div style={styles.cardBody}>
          {recipe.sourceUrl && (
            <a
              href={recipe.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={styles.sourceLink}
            >
              🔗 View Original Recipe
            </a>
          )}
          {recipe.description && <p style={styles.cardDesc}>{recipe.description}</p>}
          {recipe.tags?.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '10px' }}>
              {recipe.tags.map(tag => <span key={tag} style={styles.tag}>{tag}</span>)}
            </div>
          )}

          {hasIngredients && (
            <div style={styles.cardSection}>
              <h4 style={styles.cardSectionTitle}>Ingredients</h4>
              <ul style={styles.list}>
                {recipe.ingredients.map((ing, i) => {
                  const text = typeof ing === 'string' ? ing : ing.text || ''
                  return <li key={i}>{text}</li>
                })}
              </ul>
            </div>
          )}

          {hasInstructions && (
            <div style={styles.cardSection}>
              <h4 style={styles.cardSectionTitle}>Instructions</h4>
              <ol style={styles.list}>
                {recipe.instructions.map((step, i) => {
                  const text = typeof step === 'string' ? step : step.text || ''
                  return <li key={i}>{text}</li>
                })}
              </ol>
            </div>
          )}

          <div style={styles.cardActions}>
            {hasInstructions && (
              <button style={styles.cookBtn} onClick={() => onEnterCook(recipe)}>👨‍🍳 Cook Mode</button>
            )}
            <button style={styles.groceryBtn} onClick={() => onAddToGrocery(recipe)}>🛒 Add to List</button>
            <button style={styles.deleteBtn} onClick={() => onDelete(recipe.id)}>🗑</button>
          </div>
        </div>
      )}
    </div>
  )
}

function RecipePreview({ recipe, scaledIngredients, servingScale, setServingScale, onSave, saveMsg }) {
  const displayIngredients = scaledIngredients.length > 0 ? scaledIngredients : recipe.ingredients || []
  const servingsNum = parseInt((recipe.servings || '4').replace(/\D/g, '') || '4')

  return (
    <div style={styles.preview}>
      {recipe.photoUrl && (
        <img src={recipe.photoUrl} alt={recipe.title} style={{ width: '100%', height: '180px', objectFit: 'cover', borderRadius: '12px', marginBottom: '12px' }} onError={e => e.target.style.display = 'none'} />
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
        <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: '24px', fontWeight: 700, flex: 1 }}>{recipe.title || 'Untitled'}</h2>
        <button style={styles.favoriteBtn} onClick={e => e.stopPropagation()}>♡</button>
      </div>

      {recipe.sourceUrl && (
        <a href={recipe.sourceUrl} target="_blank" rel="noopener noreferrer" style={styles.sourceLink}>
          🔗 View Original Recipe
        </a>
      )}

      {recipe.description && <p style={{ fontSize: '14px', color: COLORS.textSecondary, lineHeight: 1.6, marginBottom: '12px' }}>{recipe.description}</p>}

      {/* Serving Scaler */}
      <div style={styles.servingScaler}>
        <span style={{ fontSize: '14px', color: COLORS.textSecondary }}>Servings:</span>
        <div style={styles.servingControls}>
          <button style={styles.servingBtn} onClick={() => setServingScale(s => Math.max(0.5, s - 0.5))}>−</button>
          <span style={{ fontWeight: 600, minWidth: '60px', textAlign: 'center' }}>
            {Math.round(servingsNum * servingScale)} servings
          </span>
          <button style={styles.servingBtn} onClick={() => setServingScale(s => s + 0.5)}>+</button>
        </div>
        <button style={{ fontSize: '12px', color: COLORS.primary, background: 'none', border: 'none', cursor: 'pointer' }} onClick={() => setServingScale(1)}>Reset</button>
      </div>

      <div style={styles.metaRow}>
        {recipe.servings && <span style={styles.metaChip}>🍽 {recipe.servings}</span>}
        {recipe.totalTime && <span style={styles.metaChip}>⏱ {recipe.totalTime}</span>}
        {recipe.tags?.map(tag => <span key={tag} style={styles.tagChip}>{tag}</span>)}
      </div>

      {displayIngredients.length > 0 && (
        <div style={styles.section}>
          <h3 style={styles.sectionTitle}>Ingredients ({displayIngredients.length})</h3>
          <ul style={styles.list}>
            {displayIngredients.map((ing, i) => {
              if (typeof ing === 'string') return <li key={i}>{ing}</li>
              const parts = []
              if (ing.qty) parts.push(ing.qty)
              if (ing.unit) parts.push(ing.unit)
              if (ing.item) parts.push(ing.item)
              return <li key={i}>{parts.join(' ')}</li>
            })}
          </ul>
        </div>
      )}

      {recipe.instructions?.length > 0 && (
        <div style={styles.section}>
          <h3 style={styles.sectionTitle}>Instructions ({recipe.instructions.length})</h3>
          <ol style={styles.list}>
            {recipe.instructions.map((step, i) => {
              const text = typeof step === 'string' ? step : step.text || ''
              return <li key={i}>{text}</li>
            })}
          </ol>
        </div>
      )}

      <button style={styles.saveBtn} onClick={onSave}>{saveMsg || '💾 Save to Library'}</button>
    </div>
  )
}

function CookMode({ recipe, currentStep, setCurrentStep, servingScale, setServingScale, onBack }) {
  const [wakeLock, setWakeLock] = useState(null)
  const [timers, setTimers] = useState({})
  const servingsNum = parseInt((recipe.servings || '4').replace(/\D/g, '') || '4')
  const scaledServings = Math.round(servingsNum * servingScale)

  const scaledIngredients = recipe.ingredients.map(ing => {
    if (typeof ing === 'string') return ing
    const text = ing.text || ''
    const qty = ing.qty ? parseQty(ing.qty) : null
    if (qty === null) return text
    const scaled = qty * servingScale
    let formatted = Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(1).replace(/\.0$/, '')
    return `${formatted} ${ing.unit || ''} ${ing.item || text}`.trim()
  })

  const instructions = (recipe.instructions || []).map((s, i) => typeof s === 'string' ? s : s.text || '')
  const currentInstruction = instructions[currentStep]
  const totalSteps = instructions.length
  const progress = totalSteps > 0 ? ((currentStep + 1) / totalSteps) * 100 : 0

  // Wake lock
  useEffect(() => {
    if ('wakeLock' in navigator) {
      navigator.wakeLock.request('screen').then(lock => setWakeLock(lock)).catch(() => {})
    }
    return () => { if (wakeLock) wakeLock.release().catch(() => {}) }
  }, [])

  // Parse timer from step
  function parseTimer(text) {
    const match = text.match(/(\d+)\s*(min|mins|minutes?|hr|hrs|hours?|sec|secs|seconds?)/i)
    if (!match) return null
    const num = parseInt(match[1])
    const unit = match[2].toLowerCase()
    const secs = unit.startsWith('min') ? num * 60 : unit.startsWith('hr') || unit.startsWith('hour') ? num * 3600 : num
    return secs
  }

  function startTimer(stepIndex) {
    const text = instructions[stepIndex]
    const secs = parseTimer(text)
    if (!secs) return
    setTimers(prev => ({ ...prev, [stepIndex]: { secs, remaining: secs, active: true } }))
    const interval = setInterval(() => {
      setTimers(prev => {
        const t = prev[stepIndex]
        if (!t || !t.active) return prev
        const newRemaining = t.remaining - 1
        if (newRemaining <= 0) {
          clearInterval(interval)
          return { ...prev, [stepIndex]: { ...t, remaining: 0, active: false, done: true } }
        }
        return { ...prev, [stepIndex]: { ...t, remaining: newRemaining } }
      })
    }, 1000)
  }

  function formatTime(secs) {
    const m = Math.floor(secs / 60)
    const s = secs % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  return (
    <div style={styles.cookMode}>
      {/* Header */}
      <div style={styles.cookHeader}>
        <button style={styles.cookBackBtn} onClick={onBack}>← Back</button>
        <h2 style={styles.cookTitle}>{recipe.title || 'Cook Mode'}</h2>
        <span style={{ width: '60px' }} />
      </div>

      {/* Progress Bar */}
      <div style={styles.progressBar}>
        <div style={{ ...styles.progressFill, width: `${progress}%` }} />
      </div>

      {/* Step Counter */}
      <div style={styles.stepCounter}>
        Step {currentStep + 1} of {totalSteps}
      </div>

      {/* Current Step */}
      <div style={styles.stepCard}>
        <p style={styles.stepText}>{currentInstruction}</p>
        {timers[currentStep] && (
          <div style={styles.timerDisplay}>
            <span style={styles.timerDigits}>{formatTime(timers[currentStep].remaining)}</span>
            {timers[currentStep].done && <span style={styles.timerDone}>⏰ Done!</span>}
          </div>
        )}
      </div>

      {/* Timer Button */}
      {parseTimer(currentInstruction) && !timers[currentStep]?.active && !timers[currentStep]?.done && (
        <button style={styles.timerBtn} onClick={() => startTimer(currentStep)}>
          ⏱ Start Timer ({formatTime(parseTimer(currentInstruction))})
        </button>
      )}

      {/* Navigation */}
      <div style={styles.stepNav}>
        <button
          style={{ ...styles.stepBtn, opacity: currentStep === 0 ? 0.3 : 1 }}
          disabled={currentStep === 0}
          onClick={() => setCurrentStep(s => s - 1)}
        >
          ← Previous
        </button>
        {currentStep < totalSteps - 1 ? (
          <button style={styles.stepBtnPrimary} onClick={() => setCurrentStep(s => s + 1)}>
            Next →
          </button>
        ) : (
          <button style={styles.stepBtnPrimary} onClick={onBack}>
            ✓ Done!
          </button>
        )}
      </div>

      {/* Ingredients (scaled) */}
      {scaledIngredients.length > 0 && (
        <div style={styles.cookIngredients}>
          <h3 style={styles.cookSectionTitle}>Ingredients (for {scaledServings} servings)</h3>
          <ul style={styles.cookList}>
            {scaledIngredients.map((item, i) => <li key={i}>{typeof item === 'string' ? item : item.text || JSON.stringify(item)}</li>)}
          </ul>
        </div>
      )}
    </div>
  )
}

const styles = {
  root: { minHeight: '100vh', background: COLORS.bg, color: COLORS.text, paddingBottom: '90px' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 20px 16px', borderBottom: `1px solid ${COLORS.border}`, position: 'sticky', top: 0, background: COLORS.bg, zIndex: 100 },
  logo: { fontFamily: "'Playfair Display', serif", fontSize: '28px', fontWeight: 700, letterSpacing: '-0.5px' },
  tagline: { fontSize: '12px', color: COLORS.textMuted },
  iconBtn: { background: 'transparent', border: 'none', color: COLORS.text, fontSize: '22px', cursor: 'pointer', padding: '8px', borderRadius: '12px', position: 'relative' },
  badge: { position: 'absolute', top: '2px', right: '2px', background: COLORS.primary, color: COLORS.text, fontSize: '10px', fontWeight: 700, borderRadius: '10px', padding: '1px 5px', minWidth: '16px', textAlign: 'center' },
  bottomNav: { position: 'fixed', bottom: 0, left: 0, right: 0, display: 'flex', background: COLORS.surface, borderTop: `1px solid ${COLORS.border}`, padding: '8px 24px', paddingBottom: 'max(8px, env(safe-area-inset-bottom))', zIndex: 100 },
  navBtn: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', background: 'transparent', border: 'none', color: COLORS.textMuted, cursor: 'pointer', padding: '8px', borderRadius: '12px', transition: 'all 0.2s', position: 'relative' },
  navBtnActive: { color: COLORS.primary, background: `${COLORS.primary}15` },
  navIcon: { fontSize: '22px' },
  navLabel: { fontSize: '11px', fontWeight: 600, letterSpacing: '0.5px' },
  main: { padding: '20px' },
  searchWrapper: { position: 'relative', marginBottom: '12px' },
  searchIcon: { position: 'absolute', left: '14px', top: '50%', transform: 'translateY(-50%)', fontSize: '16px' },
  searchInput: { width: '100%', padding: '14px 14px 14px 42px', background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: '14px', color: COLORS.text, fontSize: '15px', outline: 'none' },
  filterRow: {
    display: 'flex',
    flexWrap: 'nowrap',
    overflowX: 'auto',
    gap: '8px',
    marginBottom: '12px',
    paddingBottom: '8px',
    WebkitOverflowScrolling: 'touch',
    scrollbarWidth: 'none',
  },
  filterChip: { padding: '6px 14px', background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: '20px', color: COLORS.textSecondary, fontSize: '13px', cursor: 'pointer', transition: 'all 0.15s' },
  filterChipActive: { background: COLORS.primary, borderColor: COLORS.primary, color: COLORS.text },
  clearFilterBtn: { padding: '6px 10px', background: 'transparent', border: 'none', color: COLORS.error, fontSize: '13px', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 },
  nasBar: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '20px', padding: '10px 14px', background: COLORS.surface, borderRadius: '10px', fontSize: '13px', color: COLORS.textSecondary, flexWrap: 'wrap' },
  restoreBtnSmall: { background: 'transparent', border: `1px solid ${COLORS.border}`, color: COLORS.textSecondary, padding: '6px 10px', borderRadius: '8px', fontSize: '12px', cursor: 'pointer' },
  favToggle: { background: 'transparent', border: 'none', fontSize: '13px', cursor: 'pointer', padding: '4px 8px', fontWeight: 500 },
  grid: { display: 'flex', flexDirection: 'column', gap: '12px' },
  emptyState: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 20px', textAlign: 'center' },
  primaryBtn: { width: '100%', padding: '16px', background: COLORS.primary, color: COLORS.text, border: 'none', borderRadius: '14px', fontSize: '16px', fontWeight: 600, cursor: 'pointer' },
  card: { background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: '16px', overflow: 'hidden' },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '16px', cursor: 'pointer' },
  cardPhotoWrapper: { position: 'relative', cursor: 'pointer' },
  cardPhoto: { width: '100%', height: '160px', objectFit: 'cover', display: 'block' },
  photoLink: { position: 'absolute', top: '8px', right: '8px', background: 'rgba(0,0,0,0.7)', color: COLORS.text, padding: '6px 8px', borderRadius: '8px', fontSize: '14px', textDecoration: 'none' },
  sourceLink: { display: 'inline-flex', alignItems: 'center', gap: '6px', color: COLORS.primary, fontSize: '13px', textDecoration: 'none', marginBottom: '8px', fontWeight: 500 },
  cardTitle: { fontFamily: "'Playfair Display', serif", fontSize: '17px', fontWeight: 600, flex: 1 },
  favoriteBtn: { background: 'transparent', border: 'none', fontSize: '20px', cursor: 'pointer', padding: '2px' },
  cardMeta: { display: 'flex', gap: '12px', fontSize: '13px', color: COLORS.textMuted, marginTop: '6px', flexWrap: 'wrap' },
  tag: { background: COLORS.surfaceHover, color: COLORS.textSecondary, padding: '2px 8px', borderRadius: '6px', fontSize: '11px' },
  expandIcon: { fontSize: '12px', color: COLORS.textMuted, transition: 'transform 0.2s', marginTop: '4px' },
  cardBody: { padding: '0 16px 16px', borderTop: `1px solid ${COLORS.border}` },
  cardDesc: { fontSize: '14px', color: COLORS.textSecondary, lineHeight: 1.6, marginTop: '12px' },
  cardSection: { marginTop: '14px' },
  cardSectionTitle: { fontSize: '12px', fontWeight: 600, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' },
  list: { paddingLeft: '20px', lineHeight: 1.8, fontSize: '15px' },
  cardActions: { display: 'flex', gap: '8px', marginTop: '16px', flexWrap: 'wrap' },
  cookBtn: { flex: 1, padding: '10px', background: COLORS.success, color: COLORS.text, border: 'none', borderRadius: '10px', fontSize: '14px', fontWeight: 600, cursor: 'pointer' },
  groceryBtn: { flex: 1, padding: '10px', background: COLORS.secondary + '20', color: COLORS.secondary, border: 'none', borderRadius: '10px', fontSize: '14px', fontWeight: 600, cursor: 'pointer' },
  deleteBtn: { padding: '10px 12px', background: COLORS.error + '15', color: COLORS.error, border: 'none', borderRadius: '10px', fontSize: '14px', cursor: 'pointer' },
  tabToggle: { display: 'flex', background: COLORS.surface, borderRadius: '12px', padding: '4px' },
  tab: { flex: 1, padding: '10px', background: 'transparent', border: 'none', color: COLORS.textSecondary, fontSize: '14px', fontWeight: 500, cursor: 'pointer', borderRadius: '10px', transition: 'all 0.2s' },
  tabActive: { background: COLORS.primary, color: COLORS.text },
  textarea: { width: '100%', padding: '16px', background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: '14px', color: COLORS.text, fontSize: '15px', lineHeight: 1.6, resize: 'vertical', outline: 'none', minHeight: '200px' },
  errorBox: { padding: '12px 16px', background: `${COLORS.error}15`, border: `1px solid ${COLORS.error}30`, borderRadius: '10px', color: COLORS.error, fontSize: '14px' },
  preview: { background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: '16px', padding: '20px' },
  servingScaler: { display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 14px', background: COLORS.surfaceHover, borderRadius: '10px', marginBottom: '14px', flexWrap: 'wrap' },
  servingControls: { display: 'flex', alignItems: 'center', gap: '8px' },
  servingBtn: { width: '32px', height: '32px', borderRadius: '50%', border: `1px solid ${COLORS.border}`, background: COLORS.surface, color: COLORS.text, fontSize: '18px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  metaRow: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '16px' },
  metaChip: { padding: '6px 12px', background: `${COLORS.primary}20`, color: COLORS.primary, borderRadius: '20px', fontSize: '13px', fontWeight: 500 },
  tagChip: { padding: '6px 12px', background: COLORS.surfaceHover, color: COLORS.textSecondary, borderRadius: '20px', fontSize: '12px', fontWeight: 500 },
  section: { marginBottom: '16px' },
  sectionTitle: { fontSize: '13px', fontWeight: 600, color: COLORS.textSecondary, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '10px' },
  saveBtn: { width: '100%', padding: '16px', background: COLORS.success, color: COLORS.text, border: 'none', borderRadius: '14px', fontSize: '16px', fontWeight: 600, cursor: 'pointer', marginTop: '8px' },
  // Cook Mode
  cookMode: { minHeight: '100vh', display: 'flex', flexDirection: 'column' },
  cookHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: `1px solid ${COLORS.border}` },
  cookBackBtn: { background: 'transparent', border: 'none', color: COLORS.primary, fontSize: '15px', cursor: 'pointer', padding: '8px' },
  cookTitle: { fontFamily: "'Playfair Display', serif", fontSize: '18px', fontWeight: 600, textAlign: 'center', flex: 1, padding: '0 12px' },
  progressBar: { height: '4px', background: COLORS.surface, width: '100%' },
  progressFill: { height: '100%', background: COLORS.primary, transition: 'width 0.3s ease' },
  stepCounter: { textAlign: 'center', padding: '20px', fontSize: '14px', color: COLORS.textMuted, fontWeight: 500 },
  stepCard: { background: COLORS.surface, borderRadius: '20px', padding: '32px 24px', margin: '0 20px', textAlign: 'center', border: `1px solid ${COLORS.border}` },
  stepText: { fontSize: '22px', lineHeight: 1.6, fontWeight: 400 },
  timerDisplay: { marginTop: '24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' },
  timerDigits: { fontSize: '48px', fontFamily: "'Roboto Mono', monospace", fontWeight: 700, color: COLORS.primary },
  timerDone: { fontSize: '18px', color: COLORS.success, fontWeight: 600 },
  timerBtn: { margin: '16px auto', display: 'block', padding: '14px 28px', background: COLORS.accent, color: '#000', border: 'none', borderRadius: '12px', fontSize: '15px', fontWeight: 700, cursor: 'pointer' },
  stepNav: { display: 'flex', gap: '12px', padding: '20px', marginTop: 'auto' },
  stepBtn: { flex: 1, padding: '16px', background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: '14px', color: COLORS.text, fontSize: '15px', fontWeight: 600, cursor: 'pointer' },
  stepBtnPrimary: { flex: 1, padding: '16px', background: COLORS.primary, border: 'none', borderRadius: '14px', color: COLORS.text, fontSize: '15px', fontWeight: 600, cursor: 'pointer' },
  cookIngredients: { padding: '20px', margin: '20px', background: COLORS.surface, borderRadius: '16px', border: `1px solid ${COLORS.border}` },
  cookSectionTitle: { fontSize: '14px', fontWeight: 600, color: COLORS.textSecondary, marginBottom: '12px' },
  cookList: { paddingLeft: '20px', lineHeight: 2, fontSize: '15px' },
  // Grocery
  clearBtn: { padding: '8px 16px', background: 'transparent', border: `1px solid ${COLORS.border}`, borderRadius: '10px', color: COLORS.textSecondary, fontSize: '13px', cursor: 'pointer' },
  groceryList: { display: 'flex', flexDirection: 'column', gap: '8px' },
  groceryItem: { display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 16px', background: COLORS.surface, borderRadius: '12px', cursor: 'pointer', transition: 'all 0.15s' },
  groceryItemChecked: { opacity: 0.5, textDecoration: 'line-through' },
  groceryCheck: { width: '24px', height: '24px', borderRadius: '50%', border: `2px solid ${COLORS.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', flexShrink: 0 },
  groceryCheckChecked: { background: COLORS.success, borderColor: COLORS.success, color: COLORS.text },
}
