/* app.js — MiniCodi v2 */
'use strict';

// ════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════
const MAX_FILE_CHARS   = 3000;  // ~750 tokens per file when clipped
const MAX_HISTORY      = 10;    // messages sent to AI
const MAX_CTX_FILES    = 3;     // max full-content files in context
const CTX_TOKEN_BUDGET = 6000;  // total chars across all injected files (~1500 tokens)

// Files always included regardless of relevance scoring
const ENTRY_POINTS = [
  'package.json','tsconfig.json','vite.config.js','vite.config.ts',
  'webpack.config.js','rollup.config.js','.eslintrc.json','.eslintrc.js',
  'tailwind.config.js','tailwind.config.ts',
  'src/main.js','src/main.ts','src/index.js','src/index.ts',
  'src/App.jsx','src/App.tsx','src/App.vue','src/App.svelte',
  'index.js','index.ts','server.js','app.js','app.ts',
  'README.md','ARCHITECTURE.md',
  '.env.example','docker-compose.yml','Dockerfile',
];

// Extensions the AI can meaningfully read
const TEXT_EXTS = /\.(js|ts|jsx|tsx|vue|svelte|html|css|scss|sass|less|json|md|yml|yaml|env|py|rb|go|rs|java|php|sh|bash|zsh|toml|xml|graphql|gql|prisma|sql|tf|hcl)$/i;
// Binaries and generated files to always skip
const SKIP_EXTS = /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|pdf|zip|gz|tar|mp4|mp3|webp|lock|map|min\.js|min\.css)$/i;

// ════════════════════════════════════════════════
// IndexedDB  (bumped to version 2 — migrates existing data)
// ════════════════════════════════════════════════
class DB {
  constructor() { this._db = null; }

  async init() {
    return new Promise((res, rej) => {
      // Version 2: adds githubSha/baseContent/status to files, adds gitSnapshots
      const req = indexedDB.open('MiniCodi', 2);
      req.onerror   = () => rej(req.error);
      req.onsuccess = () => { this._db = req.result; res(); };

      req.onupgradeneeded = e => {
        const db  = e.target.result;
        const old = e.oldVersion; // 0 = fresh, 1 = DevAI_v2 users

        if (!db.objectStoreNames.contains('projects')) {
          db.createObjectStore('projects', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('messages')) {
          const ms = db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
          ms.createIndex('projectId', 'projectId');
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('files')) {
          const fs = db.createObjectStore('files', { keyPath: 'id', autoIncrement: true });
          fs.createIndex('projectId', 'projectId');
          fs.createIndex('projectPath', ['projectId', 'path'], { unique: false });
        }
        // New in v2
        if (!db.objectStoreNames.contains('gitSnapshots')) {
          const gs = db.createObjectStore('gitSnapshots', { keyPath: 'id', autoIncrement: true });
          gs.createIndex('projectId', 'projectId');
        }
        // Migrate existing files: add missing fields
        if (old === 1 && db.objectStoreNames.contains('files')) {
          const tx   = e.target.transaction;
          const store = tx.objectStore('files');
          store.openCursor().onsuccess = function(ev) {
            const cursor = ev.target.result;
            if (!cursor) return;
            const f = cursor.value;
            if (f.githubSha === undefined) {
              f.githubSha   = null;
              f.baseContent = null;
              f.status      = 'new';
              cursor.update(f);
            }
            cursor.continue();
          };
        }
      };
    });
  }

  _tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const tx  = this._db.transaction(store, mode);
      const s   = tx.objectStore(store);
      const req = fn(s);
      req.onsuccess = () => res(req.result);
      req.onerror   = () => rej(req.error);
    });
  }

  getAll(store)    { return this._tx(store, 'readonly',  s => s.getAll()); }
  get(store, key)  { return this._tx(store, 'readonly',  s => s.get(key)); }
  put(store, data) { return this._tx(store, 'readwrite', s => s.put(data)); }
  del(store, key)  { return this._tx(store, 'readwrite', s => s.delete(key)); }
  clear(store)     { return this._tx(store, 'readwrite', s => s.clear()); }

  byIndex(store, idx, val) {
    return new Promise((res, rej) => {
      const tx  = this._db.transaction(store, 'readonly');
      const req = tx.objectStore(store).index(idx).getAll(val);
      req.onsuccess = () => res(req.result);
      req.onerror   = () => rej(req.error);
    });
  }
}

// ════════════════════════════════════════════════
// Workspace  — local file CRUD + status tracking
// ════════════════════════════════════════════════
class Workspace {
  constructor(db) { this.db = db; }

  async listFiles(projectId) {
    return this.db.byIndex('files', 'projectId', projectId);
  }

  async readFile(projectId, path) {
    const all = await this.listFiles(projectId);
    return all.find(f => f.path === path) || null;
  }

  async writeFile(projectId, path, content, meta = {}) {
    const existing = await this.readFile(projectId, path);
    if (existing) {
      const newStatus = existing.status === 'clean'
        ? (content !== existing.baseContent ? 'modified' : 'clean')
        : existing.status; // keep 'new' if was new
      const updated = {
        ...existing,
        content,
        status:    newStatus,
        updatedAt: Date.now(),
        ...meta
      };
      return this.db.put('files', updated);
    } else {
      return this.db.put('files', {
        projectId, path, content,
        githubSha:   meta.githubSha   || null,
        baseContent: meta.baseContent || null,
        status:      meta.status      || 'new',
        updatedAt:   Date.now()
      });
    }
  }

  async deleteFile(projectId, path) {
    const f = await this.readFile(projectId, path);
    if (!f) return;
    if (f.githubSha) {
      // Was on GitHub — mark deleted so push can remove it
      await this.db.put('files', { ...f, status: 'deleted', updatedAt: Date.now() });
    } else {
      await this.db.del('files', f.id);
    }
  }

  async getChanges(projectId) {
    const all = await this.listFiles(projectId);
    return all.filter(f => f.status !== 'clean');
  }

  // Mark all files clean after a successful push
  async markAllClean(projectId) {
    const all = await this.listFiles(projectId);
    for (const f of all) {
      if (f.status === 'deleted') {
        await this.db.del('files', f.id);
      } else if (f.status !== 'clean') {
        await this.db.put('files', {
          ...f,
          status:      'clean',
          baseContent: f.content,
          updatedAt:   Date.now()
        });
      }
    }
  }
}

// ════════════════════════════════════════════════
// GitHub client — REST + Git Data API
// ════════════════════════════════════════════════
class GitHub {
  constructor(token) {
    this.token = token;
    this.base  = 'https://api.github.com';
  }

  async req(path, opts = {}) {
    const r = await fetch(this.base + path, {
      ...opts,
      headers: {
        'Authorization': `token ${this.token}`,
        'Accept':        'application/vnd.github.v3+json',
        ...opts.headers
      }
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.message || `GitHub ${r.status} ${path}`);
    }
    return r.json();
  }

  // ── Browsing ──────────────────────────────────
  getUser()               { return this.req('/user'); }
  getRepos()              { return this.req('/user/repos?sort=updated&per_page=50&affiliation=owner,collaborator'); }
  getContents(o, r, p='') { return this.req(`/repos/${o}/${r}/contents/${p}`); }
  getBranches(o, r)       { return this.req(`/repos/${o}/${r}/branches?per_page=20`); }
  getCommits(o, r, b)     { return this.req(`/repos/${o}/${r}/commits?sha=${b}&per_page=8`); }
  getRepo(o, r)           { return this.req(`/repos/${o}/${r}`); }

  async getFileMeta(o, r, p, b = 'main') {
    // Returns { content, sha } — sha needed for single-file updates
    const d = await this.req(`/repos/${o}/${r}/contents/${p}?ref=${b}`);
    const content = d.encoding === 'base64' ? atob(d.content.replace(/\s/g, '')) : d.content;
    return { content, sha: d.sha };
  }

  // ── Git Data API ──────────────────────────────

  // Get the SHA of branch HEAD
  async getRef(o, r, branch) {
    const d = await this.req(`/repos/${o}/${r}/git/ref/heads/${branch}`);
    return d.object.sha; // commit SHA
  }

  // Get commit → returns { tree: { sha } }
  async getCommit(o, r, sha) {
    return this.req(`/repos/${o}/${r}/git/commits/${sha}`);
  }

  // Get full recursive tree
  async getTree(o, r, treeSha) {
    return this.req(`/repos/${o}/${r}/git/trees/${treeSha}?recursive=1`);
  }

  // Create a blob from string content
  async createBlob(o, r, content) {
    return this.req(`/repos/${o}/${r}/git/blobs`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ content, encoding: 'utf-8' })
    });
  }

  // Create a new tree on top of baseTreeSha with file changes
  // items: [{ path, mode:'100644', type:'blob', sha }]  or sha=null to delete
  async createTree(o, r, baseTreeSha, items) {
    return this.req(`/repos/${o}/${r}/git/trees`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ base_tree: baseTreeSha, tree: items })
    });
  }

  // Create a commit
  async createCommit(o, r, message, treeSha, parentSha) {
    return this.req(`/repos/${o}/${r}/git/commits`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ message, tree: treeSha, parents: [parentSha] })
    });
  }

  // Move branch HEAD to new commit SHA
  async updateRef(o, r, branch, sha) {
    return this.req(`/repos/${o}/${r}/git/refs/heads/${branch}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sha, force: false })
    });
  }
}

// ════════════════════════════════════════════════
// GitWorkspace — high-level pull / push
// ════════════════════════════════════════════════
class GitWorkspace {
  constructor(db, workspace, gh) {
    this.db        = db;
    this.workspace = workspace;
    this.gh        = gh;
  }

  // Pull all files from GitHub into local workspace
  async pull(projectId, owner, repo, branch, onProgress) {
    // 1. Get HEAD commit SHA
    const commitSha = await this.gh.getRef(owner, repo, branch);
    onProgress?.(`Resolving HEAD: ${commitSha.slice(0, 7)}…`);

    // 2. Get commit → tree SHA
    const commit = await this.gh.getCommit(owner, repo, commitSha);
    const treeSha = commit.tree.sha;

    // 3. Get recursive tree (all files)
    const { tree, truncated } = await this.gh.getTree(owner, repo, treeSha);
    if (truncated) onProgress?.('⚠ Tree truncated — repo may be very large');

    // Only text-like files, skip binaries by extension
    const SKIP_EXT = /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|pdf|zip|gz|tar|mp4|mp3|webp|lock)$/i;
    const textFiles = tree.filter(f => f.type === 'blob' && !SKIP_EXT.test(f.path));

    onProgress?.(`Downloading ${textFiles.length} files…`);

    // Download in batches of 5 to avoid rate limits
    const BATCH = 5;
    let done = 0;
    for (let i = 0; i < textFiles.length; i += BATCH) {
      const batch = textFiles.slice(i, i + BATCH);
      await Promise.all(batch.map(async item => {
        try {
          const { content, sha } = await this.gh.getFileMeta(owner, repo, item.path, branch);
          await this.workspace.writeFile(projectId, item.path, content, {
            githubSha:   sha,
            baseContent: content,
            status:      'clean'
          });
        } catch (e) {
          console.warn(`Skip ${item.path}: ${e.message}`);
        }
        done++;
        onProgress?.(`${done}/${textFiles.length} files`);
      }));
    }

    // 4. Save snapshot
    await this.db.put('gitSnapshots', {
      projectId, owner, repo, branch,
      commitSha, treeSha,
      createdAt: Date.now()
    });

    return { commitSha, fileCount: done };
  }

  // Get latest local snapshot for project
  async getSnapshot(projectId) {
    const snaps = await this.db.byIndex('gitSnapshots', 'projectId', projectId);
    return snaps.sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  }

  // Atomic multi-file push via Git Data API
  async push(projectId, owner, repo, branch, message, onProgress) {
    // 1. Get current remote HEAD
    const remoteHeadSha = await this.gh.getRef(owner, repo, branch);
    onProgress?.('Checking remote…');

    // 2. Conflict check: compare with our snapshot
    const snap = await this.getSnapshot(projectId);
    if (snap && snap.commitSha !== remoteHeadSha) {
      throw new Error(
        `Remote has new commits since your last pull (${remoteHeadSha.slice(0,7)} ≠ ${snap.commitSha.slice(0,7)}). Pull first.`
      );
    }

    // 3. Collect changed files
    const changes = await this.workspace.getChanges(projectId);
    if (!changes.length) throw new Error('No local changes to push.');
    onProgress?.(`${changes.length} changed files — creating blobs…`);

    // 4. Create a blob for each changed (non-deleted) file
    const treeItems = [];
    for (const f of changes) {
      if (f.status === 'deleted') {
        // Deletion: include path with sha null
        treeItems.push({ path: f.path, mode: '100644', type: 'blob', sha: null });
      } else {
        const blob = await this.gh.createBlob(owner, repo, f.content);
        treeItems.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
      }
    }
    onProgress?.('Creating tree…');

    // 5. Get base tree SHA from remote HEAD commit
    const headCommit = await this.gh.getCommit(owner, repo, remoteHeadSha);
    const baseTreeSha = headCommit.tree.sha;

    // 6. Create new tree
    const newTree = await this.gh.createTree(owner, repo, baseTreeSha, treeItems);
    onProgress?.('Creating commit…');

    // 7. Create commit
    const newCommit = await this.gh.createCommit(owner, repo, message, newTree.sha, remoteHeadSha);

    // 8. Update branch ref
    await this.gh.updateRef(owner, repo, branch, newCommit.sha);
    onProgress?.('Updating branch…');

    // 9. Mark all local files clean + update snapshot
    await this.workspace.markAllClean(projectId);
    await this.db.put('gitSnapshots', {
      ...(snap || {}),
      projectId, owner, repo, branch,
      commitSha: newCommit.sha,
      treeSha:   newTree.sha,
      createdAt: Date.now()
    });

    return { commitSha: newCommit.sha, filesChanged: changes.length };
  }
}

// ════════════════════════════════════════════════
// ContextBuilder — whole-project awareness
// ════════════════════════════════════════════════
class ContextBuilder {
  constructor(workspace) { this.workspace = workspace; }

  _clip(content, max = MAX_FILE_CHARS) {
    if (!content || content.length <= max) return content;
    const half = Math.floor(max / 2);
    return content.slice(0, half) + '\n// …[truncated]…\n' + content.slice(-half);
  }

  // Score a file's relevance to the user's message (0–100)
  _score(file, userText, openFilePath, changedPaths) {
    let score = 0;
    const p   = file.path.toLowerCase();
    const q   = (userText || '').toLowerCase();

    // Currently open file = highest priority
    if (file.path === openFilePath) return 100;

    // Changed files are always relevant
    if (changedPaths.has(file.path)) score += 60;

    // Entry points and config files — always useful for understanding project
    if (ENTRY_POINTS.some(e => file.path.endsWith(e) || file.path === e)) score += 40;

    // Filename or directory mentioned in user's message
    const name = p.split('/').pop().replace(/\.\w+$/, '');
    if (q.includes(name) && name.length > 2) score += 50;

    // Path segments mentioned in query (e.g. "components", "auth", "api")
    const segments = p.split('/').slice(0, -1);
    for (const seg of segments) {
      if (seg.length > 2 && q.includes(seg)) score += 20;
    }

    // Feature keywords — if user mentions a feature, match related file names
    const FEATURE_PATTERNS = [
      ['auth','login','session','token','jwt','password','user'],
      ['api','endpoint','route','controller','handler','request'],
      ['component','ui','layout','page','view','screen'],
      ['test','spec','jest','vitest','cypress','playwright'],
      ['style','css','theme','design','tailwind','sass'],
      ['store','state','redux','zustand','context','hook'],
      ['db','database','model','schema','migration','prisma','sql'],
      ['build','deploy','ci','docker','config','env','pipeline'],
      ['util','helper','lib','shared','common','service'],
    ];
    for (const group of FEATURE_PATTERNS) {
      const matchesQuery = group.some(kw => q.includes(kw));
      const matchesFile  = group.some(kw => p.includes(kw));
      if (matchesQuery && matchesFile) score += 35;
    }

    // Prefer smaller files (less token cost for same information)
    const len = (file.content || '').length;
    if (len < 500)  score += 10;
    if (len > 8000) score -= 15;

    // Penalise test files unless user is asking about tests
    if (p.includes('.test.') || p.includes('.spec.')) {
      if (!q.includes('test') && !q.includes('spec')) score -= 20;
    }

    // Penalise lockfiles, generated, dist
    if (p.includes('dist/') || p.includes('.min.') || p.includes('node_modules/')) score = -1;

    return Math.max(0, score);
  }

  // Build the full context block for a message
  async build(projectId, openFilePath, repoInfo, userText) {
    if (!projectId) return '';

    const allFiles    = await this.workspace.listFiles(projectId);
    const changes     = await this.workspace.getChanges(projectId);
    const changedPaths = new Set(changes.map(f => f.path));

    const parts = [];

    // 1. Repo / project header
    if (repoInfo) {
      parts.push(`Repository: ${repoInfo.owner}/${repoInfo.repo} (branch: ${repoInfo.branch})`);
    }

    // 2. Full file tree — always send this so AI knows what exists
    const textFiles = allFiles.filter(f => TEXT_EXTS.test(f.path) && !SKIP_EXTS.test(f.path));
    if (textFiles.length) {
      const tree = textFiles.map(f => {
        const badge = f.status === 'modified' ? ' [M]' : f.status === 'new' ? ' [A]' : f.status === 'deleted' ? ' [D]' : '';
        return `  ${f.path}${badge}`;
      }).join('\n');
      parts.push(`\nProject file tree (${textFiles.length} files):\n${tree}`);
    }

    // 3. Score + select files to include as full content
    const scored = textFiles
      .map(f => ({ f, score: this._score(f, userText, openFilePath, changedPaths) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score);

    // Fill budget greedily from highest-scored files
    let budget   = CTX_TOKEN_BUDGET;
    const chosen = [];
    for (const { f } of scored) {
      if (chosen.length >= MAX_CTX_FILES && !changedPaths.has(f.path) && f.path !== openFilePath) break;
      const content = f.content || '';
      const cost    = Math.min(content.length, MAX_FILE_CHARS);
      if (budget - cost < 0 && chosen.length > 0) continue;
      chosen.push(f);
      budget -= cost;
      if (budget <= 0) break;
    }

    if (chosen.length) {
      parts.push('\n--- Relevant files ---');
      for (const f of chosen) {
        const ext    = f.path.split('.').pop() || '';
        const status = f.status !== 'clean' ? ` [${f.status}]` : '';
        parts.push(`\n\`${f.path}\`${status}\n\`\`\`${ext}\n${this._clip(f.content)}\n\`\`\``);
      }
    }

    // 4. Changed files not already shown — list with diff summary
    const unshownChanges = changes.filter(c => !chosen.find(ch => ch.path === c.path));
    if (unshownChanges.length) {
      parts.push(`\nAlso locally modified (content omitted to save tokens):`);
      for (const f of unshownChanges) {
        parts.push(`• \`${f.path}\` [${f.status}]`);
      }
    }

    return parts.join('\n');
  }
}

// ════════════════════════════════════════════════
// LLM clients
// ════════════════════════════════════════════════
class GroqClient {
  constructor(key) { this.key = key; this.base = 'https://api.groq.com/openai/v1'; }

  async getModels() {
    const r = await fetch(`${this.base}/models`, {
      headers: { 'Authorization': `Bearer ${this.key}` }
    });
    if (!r.ok) throw new Error(`Groq models: ${r.status}`);
    const d   = await r.json();
    const ok  = ['llama', 'mixtral', 'gemma', 'qwen', 'deepseek'];
    return d.data
      .filter(m => ok.some(k => m.id.toLowerCase().includes(k)))
      .map(m => ({ id: m.id, label: `${m.id} (Groq)`, provider: 'groq' }));
  }

  async *stream(messages, model, maxTokens) {
    const r = await fetch(`${this.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, stream: true, temperature: 0.3 })
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error?.message || `Groq ${r.status}`);
    }
    yield* parseSSE(r.body);
  }
}

class OpenRouterClient {
  constructor(key) { this.key = key; this.base = 'https://openrouter.ai/api/v1'; }

  async getModels() {
    const r = await fetch(`${this.base}/models`, {
      headers: { 'Authorization': `Bearer ${this.key}` }
    });
    if (!r.ok) throw new Error(`OpenRouter models: ${r.status}`);
    const d = await r.json();
    return d.data
      .filter(m => m.context_length >= 8000)
      .slice(0, 60)
      .map(m => ({ id: m.id, label: `${m.name || m.id} (OR)`, provider: 'openrouter' }));
  }

  async *stream(messages, model, maxTokens) {
    const r = await fetch(`${this.base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': location.href,
        'X-Title': 'MiniCodi'
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, stream: true, temperature: 0.3 })
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error?.message || `OpenRouter ${r.status}`);
    }
    yield* parseSSE(r.body);
  }
}

async function* parseSSE(body) {
  const reader = body.getReader();
  const dec    = new TextDecoder();
  let buf      = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') return;
      try {
        const p = JSON.parse(data);
        const c = p.choices?.[0]?.delta?.content;
        if (c) yield c;
      } catch {}
    }
  }
}

// ════════════════════════════════════════════════
// Expert role prompts (compact)
// ════════════════════════════════════════════════
const ROLES = {
  '':         'You are MiniCodi, a concise AI coding assistant. Give working code with brief explanations. Use markdown code blocks with filenames as comments (e.g. `// filename.js`). Be direct.',
  frontend:   'You are a Frontend Expert. Focus on React/Vue/vanilla JS, CSS, accessibility, performance. Write clean, modern component code.',
  backend:    'You are a Backend Expert. Focus on APIs, databases, auth, Node/Python. Write production-quality server code with error handling.',
  reviewer:   'You are a Code Reviewer focused on production readiness. Check: error handling, security, edge cases, test coverage, documentation. Reference specific lines.',
  architect:  'You are a System Architect. Design scalable systems, choose appropriate tech, explain trade-offs concisely. Think about maintainability.',
  production: 'You are a DevOps/Production Readiness expert. Focus on: CI/CD, environment config, error monitoring, logging, performance, security headers, deployment.'
};

// ════════════════════════════════════════════════
// Sheet / overlay helpers
// ════════════════════════════════════════════════
function openSheet(id)  { document.getElementById(id).classList.add('open'); }
function closeSheet(id) { document.getElementById(id).classList.remove('open'); }

// ════════════════════════════════════════════════
// Markdown renderer
// ════════════════════════════════════════════════
function esc(t) {
  const d = document.createElement('div');
  d.textContent = String(t ?? '');
  return d.innerHTML;
}

function renderMd(raw) {
  if (!raw) return '';
  let s = esc(raw);
  s = s.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, lang, code) =>
    `<pre><code class="lang-${lang||''}">${code.trimEnd()}</code></pre>`);
  s = s.replace(/`([^`\n]+)`/g,   '<code>$1</code>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*(.+?)\*/g,     '<em>$1</em>');
  s = s.replace(/^### (.+)$/gm,   '<h3>$1</h3>');
  s = s.replace(/^## (.+)$/gm,    '<h2>$1</h2>');
  s = s.replace(/^# (.+)$/gm,     '<h1>$1</h1>');
  s = s.replace(/^[-*] (.+)$/gm,  '<li>$1</li>');
  s = s.replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>');
  s = s.replace(/<\/ul>\s*<ul>/g, '');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener" style="color:var(--accent)">$1</a>');
  s = s.replace(/\n/g, '<br>');
  return s;
}

// Simple line-level diff (base vs current)
function simpleDiff(base, current) {
  if (!base) return current.split('\n').map(l => `+ ${l}`).join('\n');
  const bLines = (base    || '').split('\n');
  const cLines = (current || '').split('\n');
  const out = [];
  const max = Math.max(bLines.length, cLines.length);
  for (let i = 0; i < max; i++) {
    const b = bLines[i], c = cLines[i];
    if (b === c)        out.push(`  ${c}`);
    else if (b == null) out.push(`+ ${c}`);
    else if (c == null) out.push(`- ${b}`);
    else { out.push(`- ${b}`); out.push(`+ ${c}`); }
  }
  return out.join('\n');
}

// ════════════════════════════════════════════════
// App
// ════════════════════════════════════════════════
class App {
  constructor() {
    this.db             = new DB();
    this.workspace      = null;  // set after db.init
    this.ctx            = null;  // ContextBuilder
    this.cfg            = {};
    this.projects       = [];
    this.currentProjId  = null;
    this.currentProj    = null;  // full project object
    this.messages       = [];
    this.models         = [];
    this.activeRole     = '';
    this.activeTools    = new Set();
    this.isGenerating   = false;
    // GitHub
    this.gh             = null;
    this.ghWorkspace    = null;
    this.ghUser         = null;
    this.repos          = [];
    this.currentRepo    = null;  // { owner, repo, branch }
    // File browser / editor
    this.openFilePath   = null;  // currently open file path
    this.fileBrowserDir = '';    // current directory prefix
  }

  // ── Init ──────────────────────────────────────
  async init() {
    await this.db.init();
    this.workspace = new Workspace(this.db);
    this.ctx       = new ContextBuilder(this.workspace);

    await this._loadSettings();
    await this._loadProjects();
    this._applySettings();
    this._setupNav();
    this._setupChat();
    this._setupGit();
    this._setupSettings();
    this._setupProject();
    this._renderProjects();
    await this._loadModels();

    if (this.cfg.githubToken) {
      this.gh          = new GitHub(this.cfg.githubToken);
      this.ghWorkspace = new GitWorkspace(this.db, this.workspace, this.gh);
      this._tryAutoConnectGit();
    }
    this._toast('MiniCodi ready', 'success');
  }

  // ── Settings ──────────────────────────────────
  async _loadSettings() {
    const rows   = await this.db.getAll('settings');
    this.cfg     = rows.reduce((a, r) => ({ ...a, [r.key]: r.value }), {});
    this.cfg.stream          ??= true;
    this.cfg.autosave        ??= true;
    this.cfg.confirmCommands ??= false;
    this.cfg.maxTokens       ??= 2048;
  }

  _applySettings() {
    document.getElementById('groqKey').value             = this.cfg.groqKey         || '';
    document.getElementById('openrouterKey').value       = this.cfg.openrouterKey   || '';
    document.getElementById('githubTokenSettings').value = this.cfg.githubToken     || '';
    document.getElementById('maxTokens').value           = this.cfg.maxTokens       || 2048;
    document.getElementById('systemPrompt').value        = this.cfg.systemPrompt    || '';
    this._setToggle('togStream',   this.cfg.stream);
    this._setToggle('togAutosave', this.cfg.autosave);
    this._setToggle('togConfirm',  this.cfg.confirmCommands);
  }

  _setToggle(id, val) { document.getElementById(id)?.classList.toggle('on', !!val); }

  toggle(key) {
    this.cfg[key] = !this.cfg[key];
    const map = { stream: 'togStream', autosave: 'togAutosave', confirmCommands: 'togConfirm' };
    this._setToggle(map[key], this.cfg[key]);
  }

  async _saveSettings() {
    const pairs = {
      groqKey:         document.getElementById('groqKey').value.trim(),
      openrouterKey:   document.getElementById('openrouterKey').value.trim(),
      githubToken:     document.getElementById('githubTokenSettings').value.trim(),
      maxTokens:       parseInt(document.getElementById('maxTokens').value) || 2048,
      systemPrompt:    document.getElementById('systemPrompt').value.trim(),
      stream:          this.cfg.stream,
      autosave:        this.cfg.autosave,
      confirmCommands: this.cfg.confirmCommands,
    };
    for (const [key, value] of Object.entries(pairs)) {
      await this.db.put('settings', { key, value });
      this.cfg[key] = value;
    }
    if (pairs.githubToken) {
      this.gh          = new GitHub(pairs.githubToken);
      this.ghWorkspace = new GitWorkspace(this.db, this.workspace, this.gh);
    }
    await this._loadModels();
    this._toast('Settings saved', 'success');
  }

  // ── Navigation ────────────────────────────────
  _setupNav() {
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.addEventListener('click', () => this._switchPanel(btn.dataset.panel));
    });
    document.getElementById('btnSettingsShortcut').addEventListener('click', () => {
      this._switchPanel('settings');
    });
  }

  _switchPanel(name) {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.getElementById(`panel-${name}`)?.classList.add('active');
    document.querySelector(`[data-panel="${name}"]`)?.classList.add('active');
    if (name === 'git')   this._refreshGitUI();
    if (name === 'files') this._renderFileBrowser();
  }

  // ── Models ────────────────────────────────────
  async _loadModels() {
    const sel  = document.getElementById('modelSelect');
    const prev = sel.value;
    sel.innerHTML = '<option value="">Select model…</option>';
    this.models   = [];

    const fallback = [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (Groq)',      provider: 'groq' },
      { id: 'llama-3.1-8b-instant',    label: 'Llama 3.1 8B Fast (Groq)',  provider: 'groq' },
      { id: 'mixtral-8x7b-32768',      label: 'Mixtral 8x7B (Groq)',       provider: 'groq' },
      { id: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet (OR)',     provider: 'openrouter' },
      { id: 'openai/gpt-4o-mini',      label: 'GPT-4o Mini (OR)',          provider: 'openrouter' },
      { id: 'google/gemini-flash-1.5', label: 'Gemini Flash 1.5 (OR)',     provider: 'openrouter' },
    ];

    if (this.cfg.groqKey) {
      try {
        const ms = await new GroqClient(this.cfg.groqKey).getModels();
        this.models.push(...ms);
      } catch (e) { console.warn('Groq models:', e.message); }
    }
    if (this.cfg.openrouterKey) {
      try {
        const ms = await new OpenRouterClient(this.cfg.openrouterKey).getModels();
        this.models.push(...ms);
      } catch (e) { console.warn('OR models:', e.message); }
    }
    if (!this.models.length) this.models = fallback;

    const groups = {};
    for (const m of this.models) (groups[m.provider] ||= []).push(m);
    for (const [prov, ms] of Object.entries(groups)) {
      const og    = document.createElement('optgroup');
      og.label    = prov === 'groq' ? '⚡ Groq' : '🌐 OpenRouter';
      for (const m of ms) {
        const o       = document.createElement('option');
        o.value       = JSON.stringify(m);
        o.textContent = m.label;
        og.appendChild(o);
      }
      sel.appendChild(og);
    }
    if (prev) {
      const opt = [...sel.options].find(o => o.value === prev);
      if (opt) sel.value = prev;
    }
    if (!sel.value && sel.options.length > 1) sel.selectedIndex = 1;
  }

  // ── Projects ──────────────────────────────────
  _setupProject() {
    document.getElementById('btnNewProject').addEventListener('click', () => {
      document.getElementById('sheetProjectTitle').textContent = 'New Project';
      document.getElementById('btnSaveProject').textContent    = 'Create Project';
      document.getElementById('projName').value  = '';
      document.getElementById('projDesc').value  = '';
      document.getElementById('projStack').value = 'vanilla';
      openSheet('sheetProject');
    });
    document.getElementById('btnSaveProject').addEventListener('click', () => this._saveProject());
    document.getElementById('projName').addEventListener('keydown', e => {
      if (e.key === 'Enter') this._saveProject();
    });
  }

  async _loadProjects() {
    this.projects = await this.db.getAll('projects');
    this.projects.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async _saveProject() {
    const name = document.getElementById('projName').value.trim();
    if (!name) { this._toast('Name required', 'error'); return; }
    const proj = {
      name,
      desc:      document.getElementById('projDesc').value.trim(),
      stack:     document.getElementById('projStack').value,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    const id = await this.db.put('projects', proj);
    await this._loadProjects();
    this._renderProjects();
    closeSheet('sheetProject');
    this._toast('Project created', 'success');
    this._selectProject(id);
  }

  async _deleteProject(id) {
    if (!confirm('Delete this project and all its data?')) return;
    await this.db.del('projects', id);
    const msgs  = await this.db.byIndex('messages',     'projectId', id);
    const files = await this.db.byIndex('files',        'projectId', id);
    const snaps = await this.db.byIndex('gitSnapshots', 'projectId', id);
    for (const m of msgs)  await this.db.del('messages',     m.id);
    for (const f of files) await this.db.del('files',        f.id);
    for (const s of snaps) await this.db.del('gitSnapshots', s.id);
    if (this.currentProjId === id) {
      this.currentProjId = null;
      this.currentProj   = null;
      this.messages      = [];
      this.openFilePath  = null;
    }
    await this._loadProjects();
    this._renderProjects();
    this._toast('Project deleted');
  }

  _renderProjects() {
    const list  = document.getElementById('projectsList');
    const empty = document.getElementById('projectsEmpty');
    if (!this.projects.length) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    list.innerHTML = this.projects.map(p => `
      <div class="project-card ${this.currentProjId === p.id ? 'active' : ''}"
           onclick="app._selectProject(${p.id})">
        <div class="project-card-info">
          <div class="project-card-name">${esc(p.name)}</div>
          <div class="project-card-meta">${esc(p.desc || 'No description')} · ${p.stack} · ${this._ago(p.updatedAt)}</div>
        </div>
        <div class="project-card-actions" onclick="event.stopPropagation()">
          <button class="btn-sm danger" onclick="app._deleteProject(${p.id})">Delete</button>
        </div>
      </div>
    `).join('');
  }

  async _selectProject(id) {
    this.currentProjId = id;
    this.currentProj   = await this.db.get('projects', id);
    this.openFilePath  = null;
    this._renderProjects();
    this._toast(`Opened: ${this.currentProj.name}`, 'success');
    this._switchPanel('chat');
    await this._loadMessages();
    this._renderMessages();
    this._updateCtxIndicator('');
  }

  // ── File Browser ──────────────────────────────
  async _renderFileBrowser() {
    const panel = document.getElementById('panel-files');
    if (!panel) return;

    if (!this.currentProjId) {
      panel.innerHTML = `
        <div class="section-title">Files</div>
        <div class="empty-state">
          <div class="empty-icon">📁</div>
          <div class="empty-title">No project selected</div>
          <div class="empty-desc">Open a project first.</div>
        </div>`;
      return;
    }

    const files   = await this.workspace.listFiles(this.currentProjId);
    const changes = files.filter(f => f.status !== 'clean');

    // Build directory tree
    const dir   = this.fileBrowserDir;
    const inDir = files.filter(f => f.path.startsWith(dir) && f.status !== 'deleted');

    // Get unique subdirs in current dir
    const subdirs = new Set();
    const dirFiles = [];
    for (const f of inDir) {
      const rel  = f.path.slice(dir.length);
      const sep  = rel.indexOf('/');
      if (sep > -1) subdirs.add(rel.slice(0, sep));
      else dirFiles.push(f);
    }

    const statusBadge = s => {
      if (s === 'modified') return '<span style="color:var(--warning);font-size:10px;margin-left:4px">M</span>';
      if (s === 'new')      return '<span style="color:var(--positive);font-size:10px;margin-left:4px">A</span>';
      if (s === 'deleted')  return '<span style="color:var(--danger);font-size:10px;margin-left:4px">D</span>';
      return '';
    };

    const breadcrumb = dir
      ? `<button class="btn-sm" onclick="app._cdUp()" style="margin-bottom:10px">← ${dir || '/'}</button>`
      : '';

    const subDirHTML = [...subdirs].sort().map(d => `
      <div class="file-item" onclick="app._cdInto('${esc(dir + d)}/')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="color:var(--accent)">
          <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
        </svg>
        ${esc(d)}/
      </div>
    `).join('');

    const fileHTML = dirFiles.sort((a,b) => a.path.localeCompare(b.path)).map(f => `
      <div class="file-item ${this.openFilePath === f.path ? 'active' : ''}"
           onclick="app._openWorkspaceFile('${esc(f.path)}')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="color:var(--text-tertiary)">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
        </svg>
        <span class="truncate">${esc(f.path.slice(dir.length))}</span>
        ${statusBadge(f.status)}
      </div>
    `).join('');

    const changesBar = changes.length
      ? `<div class="changes-bar">
           <span>${changes.length} change${changes.length > 1 ? 's' : ''}</span>
           <button class="btn-sm" onclick="app._showChanges()">Review</button>
           <button class="btn-sm" onclick="openSheet('sheetCommit')">Push…</button>
         </div>`
      : '';

    panel.innerHTML = `
      <div class="section-title">Files
        <span style="font-size:13px;font-weight:400;color:var(--text-tertiary);margin-left:8px">${esc(this.currentProj?.name || '')}</span>
      </div>
      ${changesBar}
      <div style="margin-bottom:10px;display:flex;gap:6px;flex-wrap:wrap;">
        <button class="btn-sm" onclick="app._newFile()">+ New file</button>
        <button class="btn-sm" onclick="app._exportZip()">⬇ Export ZIP</button>
      </div>
      ${breadcrumb}
      <div id="fileTreeBrowser">
        ${subDirHTML}
        ${fileHTML}
        ${!subdirs.size && !dirFiles.length ? '<div class="text-tertiary text-sm">No files here.</div>' : ''}
      </div>
      ${this.openFilePath ? this._renderEditorHTML() : ''}
    `;

    // Re-attach editor events after render
    if (this.openFilePath) this._attachEditorEvents();
  }

  _cdInto(dir) { this.fileBrowserDir = dir; this._renderFileBrowser(); }
  _cdUp()      {
    const parts = this.fileBrowserDir.split('/').filter(Boolean);
    parts.pop();
    this.fileBrowserDir = parts.length ? parts.join('/') + '/' : '';
    this._renderFileBrowser();
  }

  async _openWorkspaceFile(path) {
    this.openFilePath = path;
    this._renderFileBrowser();
  }

  _renderEditorHTML() {
    return `
      <div class="editor-wrap" id="editorWrap">
        <div class="editor-header">
          <span class="font-mono text-sm truncate">${esc(this.openFilePath)}</span>
          <div style="display:flex;gap:6px;">
            <button class="btn-sm" id="btnSaveFile">Save</button>
            <button class="btn-sm" id="btnSendToChat">→ Chat</button>
            <button class="btn-sm danger" id="btnDeleteFile">Delete</button>
            <button class="btn-sm" onclick="app._closeEditor()">✕</button>
          </div>
        </div>
        <textarea class="editor-textarea" id="editorTextarea" spellcheck="false"></textarea>
      </div>
    `;
  }

  async _attachEditorEvents() {
    const f = await this.workspace.readFile(this.currentProjId, this.openFilePath);
    const ta = document.getElementById('editorTextarea');
    if (ta && f) ta.value = f.content;

    document.getElementById('btnSaveFile')?.addEventListener('click', async () => {
      const content = document.getElementById('editorTextarea')?.value || '';
      await this.workspace.writeFile(this.currentProjId, this.openFilePath, content);
      await this.db.put('projects', { ...this.currentProj, updatedAt: Date.now() });
      this._toast(`Saved: ${this.openFilePath}`, 'success');
      this._renderFileBrowser();
    });

    document.getElementById('btnSendToChat')?.addEventListener('click', async () => {
      const content = document.getElementById('editorTextarea')?.value || '';
      const ext  = this.openFilePath.split('.').pop();
      const msg  = {
        projectId: this.currentProjId,
        role:      'user',
        content:   `File: \`${this.openFilePath}\`\n\`\`\`${ext}\n${content}\n\`\`\`\n\nPlease review this file for production readiness.`,
        timestamp: Date.now()
      };
      if (this.cfg.autosave) msg.id = await this.db.put('messages', msg);
      this.messages.push(msg);
      this._switchPanel('chat');
      this._renderMessages();
    });

    document.getElementById('btnDeleteFile')?.addEventListener('click', async () => {
      if (!confirm(`Delete ${this.openFilePath}?`)) return;
      await this.workspace.deleteFile(this.currentProjId, this.openFilePath);
      this.openFilePath = null;
      this._renderFileBrowser();
      this._toast('File deleted locally', 'warning');
    });
  }

  _closeEditor() {
    this.openFilePath = null;
    this._renderFileBrowser();
  }

  async _newFile() {
    const path = prompt('File path (e.g. src/utils.js):');
    if (!path) return;
    await this.workspace.writeFile(this.currentProjId, path, '');
    this.openFilePath = path;
    this._renderFileBrowser();
  }

  async _showChanges() {
    const changes = await this.workspace.getChanges(this.currentProjId);
    const sheet   = document.getElementById('sheetChanges');
    if (!sheet) { openSheet('sheetCommit'); return; }
    document.getElementById('changesBody').innerHTML = changes.map(f => `
      <div style="margin-bottom:16px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
          <code style="font-size:13px">${esc(f.path)}</code>
          <span style="color:${f.status==='modified'?'var(--warning)':f.status==='new'?'var(--positive)':'var(--danger)'}">
            ${f.status}
          </span>
          <button class="btn-sm danger" onclick="app._revertFile(${f.id})">Revert</button>
        </div>
        <pre class="diff-view">${esc(simpleDiff(f.baseContent, f.status==='deleted'?null:f.content))}</pre>
      </div>
    `).join('');
    openSheet('sheetChanges');
  }

  async _revertFile(fileId) {
    if (!confirm('Revert this file to its last pulled state?')) return;
    const f = await this.db.get('files', fileId);
    if (!f) return;
    if (f.status === 'new') {
      await this.db.del('files', fileId);
    } else {
      await this.db.put('files', { ...f, content: f.baseContent, status: 'clean', updatedAt: Date.now() });
    }
    if (this.openFilePath === f.path) this.openFilePath = null;
    this._renderFileBrowser();
    this._toast('File reverted', 'success');
  }

  // ── Chat ──────────────────────────────────────
  _setupChat() {
    document.getElementById('roleTabs').addEventListener('click', e => {
      const tab = e.target.closest('.role-tab');
      if (!tab) return;
      document.querySelectorAll('.role-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      this.activeRole = tab.dataset.role;
    });

    document.querySelectorAll('.tool-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.tool;
        if (this.activeTools.has(t)) { this.activeTools.delete(t); btn.classList.remove('on'); }
        else { this.activeTools.add(t); btn.classList.add('on'); }
      });
    });

    document.getElementById('sendBtn').addEventListener('click', () => this._send());
    document.getElementById('chatInput').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._send(); }
    });
    document.getElementById('chatInput').addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 100) + 'px';
    });
  }

  async _loadMessages() {
    if (!this.currentProjId) { this.messages = []; return; }
    this.messages = await this.db.byIndex('messages', 'projectId', this.currentProjId);
    this.messages.sort((a, b) => a.timestamp - b.timestamp);
  }

  _renderMessages() {
    const el = document.getElementById('chatMessages');
    if (!this.messages.length) {
      el.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🤖</div>
          <div class="empty-title">Start coding with AI</div>
          <div class="empty-desc">Pull a repo or open a file, then ask the AI to review or improve it.</div>
        </div>`;
      return;
    }
    el.innerHTML = this.messages.map(m => this._msgHTML(m)).join('');
    el.scrollTop = el.scrollHeight;
  }

  _msgHTML(m) {
    const isUser = m.role === 'user';
    return `
      <div class="message ${m.role}">
        <div class="msg-avatar">${isUser ? 'You' : 'AI'}</div>
        <div class="msg-body">
          <div class="msg-name">${isUser ? 'You' : 'Assistant'}</div>
          <div class="msg-bubble">${renderMd(m.content)}</div>
        </div>
      </div>`;
  }

  async _send() {
    if (this.isGenerating) return;
    const input = document.getElementById('chatInput');
    const text  = input.value.trim();
    if (!text) return;

    if (!this.currentProjId) {
      this._toast('Select a project first', 'warning');
      this._switchPanel('projects');
      return;
    }

    const selEl = document.getElementById('modelSelect');
    if (!selEl.value) { this._toast('Select a model first', 'warning'); return; }
    const model = JSON.parse(selEl.value);

    const apiKey = model.provider === 'groq' ? this.cfg.groqKey : this.cfg.openrouterKey;
    if (!apiKey) {
      this._toast(`Add your ${model.provider === 'groq' ? 'Groq' : 'OpenRouter'} API key in Settings`, 'error');
      this._switchPanel('settings');
      return;
    }

    // Save + render user message
    const userMsg = {
      projectId: this.currentProjId,
      role:      'user',
      content:   text,
      timestamp: Date.now()
    };
    if (this.cfg.autosave) userMsg.id = await this.db.put('messages', userMsg);
    this.messages.push(userMsg);

    input.value       = '';
    input.style.height = 'auto';

    // Build whole-project context — AI sees the full file tree + relevant files
    const ctxText = await this.ctx.build(
      this.currentProjId,
      this.openFilePath,
      this.currentRepo || null,
      text
    );

    // Show what's in context to the user
    this._updateCtxIndicator(text);

    const sysLines = [ROLES[this.activeRole] || ROLES['']];
    // Critical instruction: always output full files with path header so Apply button works
    sysLines.push(
      '\nIMPORTANT: When writing or modifying any file, always output the COMPLETE file content ' +
      '(never partial snippets) in a fenced code block whose FIRST LINE is a comment with the ' +
      'file path, like this:\n' +
      '```js\n// src/components/Button.jsx\n...full content...\n```\n' +
      'Use the exact path from the project file tree. This allows changes to be applied directly.'
    );
    if (ctxText)               sysLines.push('\n--- Project Context ---\n' + ctxText);
    if (this.cfg.systemPrompt) sysLines.push('\n' + this.cfg.systemPrompt);

    const histSlice = this.messages.slice(-MAX_HISTORY).map(m => ({
      role:    m.role,
      content: m.content.length > MAX_FILE_CHARS
        ? m.content.slice(0, MAX_FILE_CHARS / 2) + '\n…\n' + m.content.slice(-MAX_FILE_CHARS / 2)
        : m.content
    }));

    const apiMsgs = [{ role: 'system', content: sysLines.join('\n') }, ...histSlice];

    // Render bubbles
    const el = document.getElementById('chatMessages');
    el.querySelector('.empty-state')?.remove();
    const userEl = document.createElement('div');
    userEl.innerHTML = this._msgHTML(userMsg);
    el.appendChild(userEl.firstElementChild);

    const aEl = document.createElement('div');
    aEl.className = 'message assistant';
    aEl.innerHTML = `
      <div class="msg-avatar">AI</div>
      <div class="msg-body">
        <div class="msg-name">Assistant</div>
        <div class="msg-bubble" id="streamBubble">
          <div class="loading-dots"><span></span><span></span><span></span></div>
        </div>
      </div>`;
    el.appendChild(aEl);
    el.scrollTop = el.scrollHeight;

    const bubble      = document.getElementById('streamBubble');
    this.isGenerating = true;
    document.getElementById('sendBtn').disabled = true;

    let full = '';
    try {
      const client = model.provider === 'groq'
        ? new GroqClient(apiKey)
        : new OpenRouterClient(apiKey);

      for await (const chunk of client.stream(apiMsgs, model.id, this.cfg.maxTokens)) {
        full        += chunk;
        bubble.innerHTML = renderMd(full);
        el.scrollTop = el.scrollHeight;
      }
      if (!full) full = '*(No response — check your API key and model)*';
    } catch (err) {
      full             = `**Error:** ${err.message}`;
      bubble.innerHTML = renderMd(full);
      this._toast(err.message, 'error');
    }

    // Save assistant message
    const aMsg = {
      projectId: this.currentProjId,
      role:      'assistant',
      content:   full,
      timestamp: Date.now()
    };
    if (this.cfg.autosave) aMsg.id = await this.db.put('messages', aMsg);
    this.messages.push(aMsg);

    // Inject Apply buttons for any file blocks in the response
    await this._tryExtractFiles(full, bubble);

    this.isGenerating = false;
    document.getElementById('sendBtn').disabled = false;
  }

  // After AI responds: find all file code blocks and inject Apply buttons
  async _tryExtractFiles(content, bubbleEl) {
    // Pattern: ```lang\n// path/to/file.ext\n...code...```
    const rx = /```(\w*)\n\/\/ ?([\w\-./]+\.\w+)\n([\s\S]*?)```/g;
    let m;
    let found = false;
    while ((m = rx.exec(content)) !== null) {
      const [, , path] = m;
      found = true;

      // Find the rendered <pre> blocks in the bubble and inject Apply button after each
      // We tag them by data attribute so we can match them
      if (bubbleEl) {
        const pres = bubbleEl.querySelectorAll('pre');
        for (const pre of pres) {
          const codeText = pre.textContent || '';
          // Match this pre to the extracted path via first-line comment
          const firstLine = codeText.split('\n')[0].trim();
          if (firstLine === `// ${path}` || firstLine === `// ${path.replace(/^\//, '')}`) {
            if (!pre.nextSibling?.classList?.contains('apply-btn-wrap')) {
              const wrap = document.createElement('div');
              wrap.className = 'apply-btn-wrap';
              wrap.innerHTML = `
                <button class="apply-btn" data-path="${esc(path)}">
                  ✓ Apply to <code>${esc(path)}</code>
                </button>`;
              wrap.querySelector('.apply-btn').addEventListener('click', () =>
                this._applyFileFromChat(path, codeText.replace(/^\/\/ [\w\-./]+\n/, '').trimEnd(), wrap)
              );
              pre.parentNode.insertBefore(wrap, pre.nextSibling);
            }
          }
        }
      }
    }
    return found;
  }

  async _applyFileFromChat(path, code, wrapEl) {
    if (!this.currentProjId) { this._toast('No project open', 'error'); return; }
    await this.workspace.writeFile(this.currentProjId, path, code);
    this._toast(`Applied → ${path}`, 'success');
    // Update button to show applied state
    if (wrapEl) {
      wrapEl.innerHTML = `<span class="apply-btn applied">✓ Applied to <code>${esc(path)}</code></span>`;
    }
  }

  // Export workspace as ZIP (for projects not linked to GitHub)
  async _exportZip() {
    if (!this.currentProjId) { this._toast('No project open', 'error'); return; }
    this._toast('Building ZIP…');
    try {
      if (!window.JSZip) {
        await new Promise((res, rej) => {
          const s  = document.createElement('script');
          s.src    = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
          s.onload = res; s.onerror = rej;
          document.head.appendChild(s);
        });
      }
      const zip   = new JSZip();
      const files = await this.workspace.listFiles(this.currentProjId);
      const alive = files.filter(f => f.status !== 'deleted');
      for (const f of alive) {
        zip.file(f.path, f.content || '');
      }
      const blob     = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      const projName = this.currentProj?.name || 'project';
      const url      = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), {
        href:     url,
        download: `${projName}-${Date.now()}.zip`
      }).click();
      URL.revokeObjectURL(url);
      this._toast(`Exported ${alive.length} files as ZIP`, 'success');
    } catch (e) {
      this._toast(`ZIP export failed: ${e.message}`, 'error');
    }
  }

  // ── GitHub ────────────────────────────────────
  _setupGit() {
    document.getElementById('btnConnectGit').addEventListener('click',    () => this._connectGit());
    document.getElementById('btnDisconnectGit').addEventListener('click', () => this._disconnectGit());
    document.getElementById('btnPull').addEventListener('click',          () => this._pull());
    document.getElementById('btnPush').addEventListener('click',          () => openSheet('sheetCommit'));
    document.getElementById('btnCommit').addEventListener('click',        () => openSheet('sheetCommit'));
    document.getElementById('btnDoCommit').addEventListener('click',      () => this._push());
    document.getElementById('zipUpload').addEventListener('change',       e  => this._loadZip(e.target.files[0]));
  }

  async _connectGit() {
    const token = document.getElementById('githubTokenInput').value.trim()
      || document.getElementById('githubTokenSettings').value.trim()
      || this.cfg.githubToken;
    if (!token) { this._toast('Enter a GitHub token', 'error'); return; }

    try {
      this.gh          = new GitHub(token);
      this.ghWorkspace = new GitWorkspace(this.db, this.workspace, this.gh);
      this.ghUser      = await this.gh.getUser();
      this.repos       = await this.gh.getRepos();
      await this.db.put('settings', { key: 'githubToken', value: token });
      this.cfg.githubToken = token;
      document.getElementById('githubTokenSettings').value = token;
      this._showGitConnected();
      this._toast(`Connected as ${this.ghUser.login}`, 'success');
    } catch (e) {
      this._toast(`GitHub: ${e.message}`, 'error');
    }
  }

  async _tryAutoConnectGit() {
    try {
      this.ghUser  = await this.gh.getUser();
      this.repos   = await this.gh.getRepos();
      this.ghWorkspace = new GitWorkspace(this.db, this.workspace, this.gh);
      this._showGitConnected();
    } catch {}
  }

  _showGitConnected() {
    document.getElementById('gitNotConnected').classList.add('hidden');
    document.getElementById('gitConnected').classList.remove('hidden');
    document.getElementById('gitUserName').textContent  = this.ghUser.name || this.ghUser.login;
    document.getElementById('gitUserLogin').textContent = `@${this.ghUser.login}`;
    this._renderRepoList();
  }

  _disconnectGit() {
    this.gh = null; this.ghUser = null; this.repos = []; this.currentRepo = null;
    this.cfg.githubToken = '';
    this.db.put('settings', { key: 'githubToken', value: '' });
    document.getElementById('gitNotConnected').classList.remove('hidden');
    document.getElementById('gitConnected').classList.add('hidden');
    document.getElementById('githubTokenInput').value    = '';
    document.getElementById('githubTokenSettings').value = '';
    this._toast('Disconnected from GitHub');
  }

  _renderRepoList() {
    const el = document.getElementById('repoList');
    el.innerHTML = this.repos.map(r => `
      <div class="repo-card ${this.currentRepo?.repo === r.name ? 'selected' : ''}"
           onclick="app._selectRepo('${esc(r.owner.login)}','${esc(r.name)}','${r.default_branch}')">
        <div class="repo-name">${esc(r.full_name)}</div>
        <div class="repo-meta">${r.private ? '🔒 Private' : '🌐 Public'} · ${r.default_branch}</div>
      </div>
    `).join('');
  }

  async _selectRepo(owner, repo, branch) {
    this.currentRepo = { owner, repo, branch };
    this._renderRepoList();
    document.getElementById('repoDetail').classList.remove('hidden');
    document.getElementById('repoDetailName').textContent = `${owner}/${repo}`;
    document.getElementById('fileTree').innerHTML = '<div class="text-tertiary text-sm">Loading…</div>';
    document.getElementById('commitList').innerHTML = '';

    try {
      const [commits, branches] = await Promise.all([
        this.gh.getCommits(owner, repo, branch),
        this.gh.getBranches(owner, repo)
      ]);

      // Branch picker
      document.getElementById('repoDetailName').textContent =
        `${owner}/${repo} · ${branches.length} branch${branches.length>1?'es':''} · ${commits.length} commits`;

      // Show top-level files (lazy)
      const contents = await this.gh.getContents(owner, repo);
      const treeEl   = document.getElementById('fileTree');
      treeEl.innerHTML = contents.map(item => `
        <div class="file-item" onclick="app._browseGitItem('${esc(item.path)}','${item.type}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
               style="color:${item.type==='dir'?'var(--accent)':'var(--text-tertiary)'}">
            ${item.type === 'dir'
              ? '<path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>'
              : '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>'}
          </svg>
          <span class="truncate">${esc(item.name)}</span>
        </div>
      `).join('');

      document.getElementById('commitList').innerHTML = commits.slice(0, 6).map(c => `
        <div style="padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;">
          <div style="font-weight:500">${esc(c.commit.message.split('\n')[0])}</div>
          <div class="text-tertiary" style="font-size:11px;margin-top:2px">
            ${esc(c.commit.author.name)} · ${this._ago(new Date(c.commit.author.date))}
          </div>
        </div>
      `).join('');

      // Check if project is linked — offer to pull
      if (this.currentProjId) {
        const snap = await this.ghWorkspace?.getSnapshot(this.currentProjId);
        if (!snap) {
          this._toast(`Tip: tap Pull to download ${owner}/${repo} into your project`, 'info');
        }
      }
    } catch (e) {
      this._toast(e.message, 'error');
      document.getElementById('fileTree').innerHTML =
        `<div class="text-danger text-sm">${esc(e.message)}</div>`;
    }
  }

  async _browseGitItem(path, type) {
    if (!this.currentRepo) return;
    const { owner, repo } = this.currentRepo;
    if (type === 'dir') {
      // Show directory contents inline
      try {
        const contents = await this.gh.getContents(owner, repo, path);
        document.getElementById('fileTree').innerHTML =
          `<div class="file-item" onclick="app._selectRepo('${esc(owner)}','${esc(repo)}','${this.currentRepo.branch}')">
             <span style="color:var(--text-tertiary)">← back</span>
           </div>` +
          contents.map(item => `
            <div class="file-item" onclick="app._browseGitItem('${esc(item.path)}','${item.type}')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                   style="color:${item.type==='dir'?'var(--accent)':'var(--text-tertiary)'}">
                ${item.type === 'dir'
                  ? '<path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>'
                  : '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>'}
              </svg>
              <span class="truncate">${esc(item.name)}</span>
            </div>
          `).join('');
      } catch (e) { this._toast(e.message, 'error'); }
      return;
    }
    // File — read into chat
    try {
      const { content } = await this.gh.getFileMeta(owner, repo, path, this.currentRepo.branch);
      const truncated   = content.length > MAX_FILE_CHARS;
      const clipped     = truncated ? content.slice(0, MAX_FILE_CHARS) + '\n…[truncated]…' : content;
      const ext         = path.split('.').pop();
      const msg = {
        projectId: this.currentProjId || 0,
        role:      'user',
        content:   `GitHub file: \`${path}\`\n\`\`\`${ext}\n${clipped}\n\`\`\`\n\nPlease review this file for production readiness.`,
        timestamp: Date.now()
      };
      if (this.currentProjId && this.cfg.autosave) msg.id = await this.db.put('messages', msg);
      this.messages.push(msg);
      this._switchPanel('chat');
      this._renderMessages();
      if (truncated) this._toast(`File truncated to ${MAX_FILE_CHARS} chars`, 'warning');
    } catch (e) { this._toast(e.message, 'error'); }
  }

  // ── Pull ──────────────────────────────────────
  async _pull() {
    if (!this.currentRepo) { this._toast('Select a repository first', 'error'); return; }
    if (!this.currentProjId) { this._toast('Select a project first — it will hold the pulled files', 'warning'); return; }
    if (!this.ghWorkspace)   { this._toast('Not connected to GitHub', 'error'); return; }

    const { owner, repo, branch } = this.currentRepo;
    const changes = await this.workspace.getChanges(this.currentProjId);
    if (changes.length && !confirm(`You have ${changes.length} local change(s). Pull will overwrite modified clean files. Continue?`)) return;

    // Progress shown via toasts
    let lastToast = null;
    const onProgress = msg => {
      if (lastToast) lastToast.remove?.();
      this._toast(msg);
    };

    try {
      const { commitSha, fileCount } = await this.ghWorkspace.pull(
        this.currentProjId, owner, repo, branch, onProgress
      );
      // Link project to repo
      await this.db.put('projects', {
        ...this.currentProj,
        githubOwner:  owner,
        githubRepo:   repo,
        githubBranch: branch,
        updatedAt:    Date.now()
      });
      this.currentProj = await this.db.get('projects', this.currentProjId);
      this._toast(`✓ Pulled ${fileCount} files @ ${commitSha.slice(0,7)}`, 'success');
    } catch (e) {
      this._toast(`Pull failed: ${e.message}`, 'error');
    }
  }

  // ── Push ──────────────────────────────────────
  async _push() {
    const msg = document.getElementById('commitMsg').value.trim();
    if (!msg) { this._toast('Enter a commit message', 'error'); return; }

    const repo = this.currentRepo || (this.currentProj
      ? { owner: this.currentProj.githubOwner, repo: this.currentProj.githubRepo, branch: this.currentProj.githubBranch }
      : null);

    if (!repo?.owner) { this._toast('No repository linked. Pull a repo first.', 'error'); return; }
    if (!this.ghWorkspace) { this._toast('Not connected to GitHub', 'error'); return; }

    closeSheet('sheetCommit');

    const onProgress = m => this._toast(m);
    try {
      const { commitSha, filesChanged } = await this.ghWorkspace.push(
        this.currentProjId, repo.owner, repo.repo, repo.branch, msg, onProgress
      );
      document.getElementById('commitMsg').value = '';
      this._toast(`✓ Pushed ${filesChanged} file(s) — ${commitSha.slice(0,7)}`, 'success');
      // Refresh commit list if git panel is open
      this._selectRepo(repo.owner, repo.repo, repo.branch);
    } catch (e) {
      this._toast(`Push failed: ${e.message}`, 'error');
    }
  }

  _refreshGitUI() {
    if (this.ghUser) this._showGitConnected();
  }

  // ── ZIP ───────────────────────────────────────
  async _loadZip(file) {
    if (!file) return;
    this._toast('Reading ZIP…');
    try {
      if (!window.JSZip) {
        await new Promise((res, rej) => {
          const s    = document.createElement('script');
          s.src      = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
          s.onload   = res; s.onerror = rej;
          document.head.appendChild(s);
        });
      }
      const zip  = await JSZip.loadAsync(file);
      const proj = {
        name:      file.name.replace('.zip', ''),
        desc:      'Loaded from ZIP',
        stack:     'other',
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      const projId = await this.db.put('projects', proj);
      let count    = 0;
      for (const [path, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue;
        if (path.startsWith('__MACOSX') || path.endsWith('.DS_Store')) continue;
        try {
          const content = await entry.async('string');
          await this.workspace.writeFile(projId, path, content, { status: 'new' });
          count++;
        } catch {}
      }
      await this._loadProjects();
      this._renderProjects();
      this._toast(`ZIP loaded: ${count} files`, 'success');
      this._selectProject(projId);
    } catch (e) {
      this._toast(`ZIP error: ${e.message}`, 'error');
    }
  }

  // ── Settings ──────────────────────────────────
  _setupSettings() {
    document.getElementById('btnSaveSettings').addEventListener('click',  () => this._saveSettings());
    document.getElementById('btnExport').addEventListener('click',        () => this._exportData());
    document.getElementById('btnImport').addEventListener('click',        () =>
      document.getElementById('importFile').click());
    document.getElementById('importFile').addEventListener('change',      e  => this._importData(e.target.files[0]));
    document.getElementById('btnClearAll').addEventListener('click',      () => this._clearAll());
  }

  async _exportData() {
    const data = {
      projects:     await this.db.getAll('projects'),
      messages:     await this.db.getAll('messages'),
      files:        await this.db.getAll('files'),
      gitSnapshots: await this.db.getAll('gitSnapshots'),
      exportedAt:   new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), { href: url, download: `minicodi-${Date.now()}.json` }).click();
    URL.revokeObjectURL(url);
    this._toast('Data exported', 'success');
  }

  async _importData(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.projects)     for (const p of data.projects)     await this.db.put('projects',     p);
      if (data.messages)     for (const m of data.messages)     await this.db.put('messages',     m);
      if (data.files)        for (const f of data.files)        await this.db.put('files',        f);
      if (data.gitSnapshots) for (const s of data.gitSnapshots) await this.db.put('gitSnapshots', s);
      await this._loadProjects();
      this._renderProjects();
      this._toast('Data imported', 'success');
    } catch (e) {
      this._toast('Import failed: ' + e.message, 'error');
    }
    document.getElementById('importFile').value = '';
  }

  async _clearAll() {
    if (!confirm('Delete ALL data permanently?')) return;
    for (const s of ['projects','messages','files','settings','gitSnapshots']) await this.db.clear(s);
    this.projects = []; this.messages = []; this.currentProjId = null; this.currentProj = null; this.cfg = {};
    this._renderProjects();
    this._toast('All data cleared');
  }

  // ── Context indicator ─────────────────────────
  async _updateCtxIndicator(userText) {
    const el = document.getElementById('ctxIndicator');
    if (!el || !this.currentProjId) return;
    const allFiles    = await this.workspace.listFiles(this.currentProjId);
    const textFiles   = allFiles.filter(f => TEXT_EXTS.test(f.path) && !SKIP_EXTS.test(f.path));
    const changes     = await this.workspace.getChanges(this.currentProjId);
    const changedPaths = new Set(changes.map(f => f.path));

    // Re-score to show which files will be included
    const scored = textFiles
      .map(f => ({ f, score: this.ctx._score(f, userText, this.openFilePath, changedPaths) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_CTX_FILES + 2);

    if (!textFiles.length) {
      el.textContent = '';
      return;
    }
    const names = scored.slice(0, 4).map(({ f }) => f.path.split('/').pop()).join(', ');
    const more  = scored.length > 4 ? ` +${scored.length - 4}` : '';
    el.innerHTML = `<strong>AI sees:</strong> ${textFiles.length} file tree · ${scored.length} files in context (${names}${more})`;
  }

  // ── Toast ─────────────────────────────────────
  _toast(msg, type = 'info') {
    const wrap = document.getElementById('toasts');
    const t    = document.createElement('div');
    t.className = `toast ${type}`;
    const icon  = type==='success' ? '✓' : type==='error' ? '✗' : type==='warning' ? '⚠' : 'ℹ';
    t.innerHTML = `<span>${icon}</span><span>${esc(msg)}</span>`;
    wrap.appendChild(t);
    setTimeout(() => {
      t.style.opacity   = '0';
      t.style.transform = 'translateY(-8px)';
      setTimeout(() => t.remove(), 280);
    }, 3500);
    return t;
  }

  // ── Helpers ───────────────────────────────────
  _ago(ts) {
    const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }
}

// ════════════════════════════════════════════════
// Boot
// ════════════════════════════════════════════════
const app = new App();
app.init();
