Here is the completed app.js file, updated to reference service scripts loaded from the services/ directory.
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
// IndexedDB  (version 2 — migrates existing data)
// ════════════════════════════════════════════════
class DB {
  constructor() { this._db = null; }

  async init() {
    return new Promise((res, rej) => {
      const req = indexedDB.open('MiniCodi', 2);
      req.onerror   = () => rej(req.error);
      req.onsuccess = () => { this._db = req.result; res(); };

      req.onupgradeneeded = e => {
        const db  = e.target.result;
        const old = e.oldVersion;

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
        if (!db.objectStoreNames.contains('gitSnapshots')) {
          const gs = db.createObjectStore('gitSnapshots', { keyPath: 'id', autoIncrement: true });
          gs.createIndex('projectId', 'projectId');
        }
        if (old === 1 && db.objectStoreNames.contains('files')) {
          const tx    = e.target.transaction;
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
// Workspace — local file CRUD + status tracking
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
        : existing.status;
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
      await this.db.put('files', { ...f, status: 'deleted', updatedAt: Date.now() });
    } else {
      await this.db.del('files', f.id);
    }
  }

  async getChanges(projectId) {
    const all = await this.listFiles(projectId);
    return all.filter(f => f.status !== 'clean');
  }

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
// GitHub Service Client
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

  getUser()               { return this.req('/user'); }
  getRepos()              { return this.req('/user/repos?sort=updated&per_page=50&affiliation=owner,collaborator'); }
  getContents(o, r, p='') { return this.req(`/repos/${o}/${r}/contents/${p}`); }
  getBranches(o, r)       { return this.req(`/repos/${o}/${r}/branches?per_page=20`); }
  getCommits(o, r, b)     { return this.req(`/repos/${o}/${r}/commits?sha=${b}&per_page=8`); }
  getRepo(o, r)           { return this.req(`/repos/${o}/${r}`); }

  async getFileMeta(o, r, p, b = 'main') {
    const d = await this.req(`/repos/${o}/${r}/contents/${p}?ref=${b}`);
    const content = d.encoding === 'base64' ? atob(d.content.replace(/\s/g, '')) : d.content;
    return { content, sha: d.sha };
  }

  async getRef(o, r, branch) {
    const d = await this.req(`/repos/${o}/${r}/git/ref/heads/${branch}`);
    return d.object.sha;
  }

  async getCommit(o, r, sha) {
    return this.req(`/repos/${o}/${r}/git/commits/${sha}`);
  }

  async getTree(o, r, treeSha) {
    return this.req(`/repos/${o}/${r}/git/trees/${treeSha}?recursive=1`);
  }

  async createBlob(o, r, content) {
    return this.req(`/repos/${o}/${r}/git/blobs`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ content, encoding: 'utf-8' })
    });
  }

  async createTree(o, r, baseTreeSha, items) {
    return this.req(`/repos/${o}/${r}/git/trees`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ base_tree: baseTreeSha, tree: items })
    });
  }

  async createCommit(o, r, message, treeSha, parentSha) {
    return this.req(`/repos/${o}/${r}/git/commits`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ message, tree: treeSha, parents: [parentSha] })
    });
  }

  async updateRef(o, r, branch, sha) {
    return this.req(`/repos/${o}/${r}/git/refs/heads/${branch}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sha, force: false })
    });
  }
}

// ════════════════════════════════════════════════
// Git Workspace Integration
// ════════════════════════════════════════════════
class GitWorkspace {
  constructor(db, workspace, gh) {
    this.db        = db;
    this.workspace = workspace;
    this.gh        = gh;
  }

  async pull(projectId, owner, repo, branch, onProgress) {
    const commitSha = await this.gh.getRef(owner, repo, branch);
    onProgress?.(`Resolving HEAD: ${commitSha.slice(0, 7)}…`);

    const commit  = await this.gh.getCommit(owner, repo, commitSha);
    const treeSha = commit.tree.sha;

    const { tree, truncated } = await this.gh.getTree(owner, repo, treeSha);
    if (truncated) onProgress?.('⚠ Tree truncated — repo may be very large');

    const SKIP_EXT  = /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|pdf|zip|gz|tar|mp4|mp3|webp|lock)$/i;
    const textFiles = tree.filter(f => f.type === 'blob' && !SKIP_EXT.test(f.path));

    onProgress?.(`Downloading ${textFiles.length} files…`);

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

    await this.db.put('gitSnapshots', {
      projectId, owner, repo, branch,
      commitSha, treeSha,
      createdAt: Date.now()
    });

    return { commitSha, fileCount: done };
  }

  async getSnapshot(projectId) {
    const snaps = await this.db.byIndex('gitSnapshots', 'projectId', projectId);
    return snaps.sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  }

  async push(projectId, owner, repo, branch, message, onProgress) {
    const remoteHeadSha = await this.gh.getRef(owner, repo, branch);
    onProgress?.('Checking remote…');

    const snap = await this.getSnapshot(projectId);
    if (snap && snap.commitSha !== remoteHeadSha) {
      throw new Error(
        `Remote has new commits since your last pull (${remoteHeadSha.slice(0,7)} ≠ ${snap.commitSha.slice(0,7)}). Pull first.`
      );
    }

    const changes = await this.workspace.getChanges(projectId);
    if (!changes.length) throw new Error('No local changes to push.');
    onProgress?.(`${changes.length} changed files — creating blobs…`);

    const treeItems = [];
    for (const f of changes) {
      if (f.status === 'deleted') {
        treeItems.push({ path: f.path, mode: '100644', type: 'blob', sha: null });
      } else {
        const blob = await this.gh.createBlob(owner, repo, f.content);
        treeItems.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
      }
    }
    onProgress?.('Creating tree…');

    const headCommit  = await this.gh.getCommit(owner, repo, remoteHeadSha);
    const baseTreeSha = headCommit.tree.sha;

    const newTree   = await this.gh.createTree(owner, repo, baseTreeSha, treeItems);
    onProgress?.('Creating commit…');

    const newCommit = await this.gh.createCommit(owner, repo, message, newTree.sha, remoteHeadSha);
    await this.gh.updateRef(owner, repo, branch, newCommit.sha);
    onProgress?.('Updating branch…');

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
// Context Builder
// ════════════════════════════════════════════════
class ContextBuilder {
  constructor(workspace) { this.workspace = workspace; }

  _clip(content, max = MAX_FILE_CHARS) {
    if (!content || content.length <= max) return content;
    const half = Math.floor(max / 2);
    return content.slice(0, half) + '\n// …[truncated]…\n' + content.slice(-half);
  }

  _score(file, userText, openFilePath, changedPaths) {
    let score = 0;
    const p   = file.path.toLowerCase();
    const q   = (userText || '').toLowerCase();

    if (file.path === openFilePath) return 100;
    if (changedPaths.has(file.path)) score += 60;
    if (ENTRY_POINTS.some(e => file.path.endsWith(e) || file.path === e)) score += 40;

    const name = p.split('/').pop().replace(/\.\w+$/, '');
    if (q.includes(name) && name.length > 2) score += 50;

    const segments = p.split('/').slice(0, -1);
    for (const seg of segments) {
      if (seg.length > 2 && q.includes(seg)) score += 20;
    }

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

    const len = (file.content || '').length;
    if (len < 500)  score += 10;
    if (len > 8000) score -= 15;

    if (p.includes('.test.') || p.includes('.spec.')) {
      if (!q.includes('test') && !q.includes('spec')) score -= 20;
    }

    if (p.includes('dist/') || p.includes('.min.') || p.includes('node_modules/')) score = -1;

    return Math.max(0, score);
  }

  async build(projectId, openFilePath, repoInfo, userText) {
    if (!projectId) return '';

    const allFiles     = await this.workspace.listFiles(projectId);
    const changes      = await this.workspace.getChanges(projectId);
    const changedPaths = new Set(changes.map(f => f.path));

    const parts = [];

    if (repoInfo) {
      parts.push(`Repository: ${repoInfo.owner}/${repoInfo.repo} (branch: ${repoInfo.branch})`);
    }

    const textFiles = allFiles.filter(f => TEXT_EXTS.test(f.path) && !SKIP_EXTS.test(f.path));
    if (textFiles.length) {
      const tree = textFiles.map(f => {
        const badge = f.status === 'modified' ? ' [M]' : f.status === 'new' ? ' [A]' : f.status === 'deleted' ? ' [D]' : '';
        return `  ${f.path}${badge}`;
      }).join('\n');
      parts.push(`\nProject file tree (${textFiles.length} files):\n${tree}`);
    }

    const scored = textFiles
      .map(f => ({ f, score: this._score(f, userText, openFilePath, changedPaths) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score);

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
// LLM API Clients
// ════════════════════════════════════════════════
class GroqClient {
  constructor(key) { this.key = key; this.base = 'https://api.groq.com/openai/v1'; }

  async getModels() {
    const r = await fetch(`${this.base}/models`, {
      headers: { 'Authorization': `Bearer ${this.key}` }
    });
    if (!r.ok) throw new Error(`Groq models: ${r.status}`);
    const d  = await r.json();
    const ok = ['llama', 'mixtral', 'gemma', 'qwen', 'deepseek'];
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
// Roles
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
// Sheet Helpers & Markdown Renderer
// ════════════════════════════════════════════════
function openSheet(id)  { document.getElementById(id).classList.add('open'); }
function closeSheet(id) { document.getElementById(id).classList.remove('open'); }

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
// Application Orchestrator
// ════════════════════════════════════════════════
class App {
  constructor() {
    this.db             = new DB();
    this.workspace      = null;
    this.ctx            = null;
    this.cfg            = {};
    this.projects       = [];
    this.currentProjId  = null;
    this.currentProj    = null;
    this.messages       = [];
    this.models         = [];
    this.activeRole     = '';
    this.activeTools    = new Set();
    this.isGenerating   = false;
    this.gh             = null;
    this.ghWorkspace    = null;
    this.ghUser         = null;
    this.repos          = [];
    this.currentRepo    = null;
    this.openFilePath   = null;
    this.fileBrowserDir = '';
  }

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

    const dir   = this.fileBrowserDir;
    const inDir = files.filter(f => f.path.startsWith(dir) && f.status !== 'deleted');

    const subdirs  = new Set();
    const dirFiles = [];
    for (const f of inDir) {
      const rel = f.path.slice(dir.length);
      const sep = rel.indexOf('/');
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
    const f  = await this.workspace.readFile(this.currentProjId, this.openFilePath);
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
    const path = prompt('File path (e.g. services/api.js):');
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
      this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });
  }

  async _loadMessages() {
    if (!this.currentProjId) { this.messages = []; return; }
    this.messages = await this.db.byIndex('messages', 'projectId', this.currentProjId);
    this.messages.sort((a, b) => a.timestamp - b.timestamp);
  }

  _renderMessages() {
    const wrap = document.getElementById('chatMessages');
    if (!wrap) return;

    if (!this.messages.length) {
      wrap.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">💬</div>
          <div class="empty-title">Start a conversation</div>
          <div class="empty-desc">Ask for code, code reviews, architectural advice, or implementation steps.</div>
        </div>`;
      return;
    }

    wrap.innerHTML = this.messages.map(m => `
      <div class="message ${m.role}">
        <div class="msg-avatar">${m.role === 'user' ? 'U' : 'AI'}</div>
        <div class="msg-body">
          <div class="msg-name">${m.role === 'user' ? 'You' : 'MiniCodi'}</div>
          <div class="msg-bubble">${renderMd(m.content)}</div>
        </div>
      </div>
    `).join('');

    this._injectApplyButtons();
    wrap.scrollTop = wrap.scrollHeight;
  }

  _injectApplyButtons() {
    const wrap = document.getElementById('chatMessages');
    if (!wrap || !this.currentProjId) return;

    wrap.querySelectorAll('.message.assistant .msg-bubble pre').forEach(pre => {
      if (pre.nextElementSibling?.classList.contains('apply-btn-wrap')) return;

      const code = pre.querySelector('code')?.textContent || '';
      const match = code.match(/^(?:\/\/\s*|#\s*|<!--\s*)([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)/);
      const filePath = match ? match[1] : null;

      const btnWrap = document.createElement('div');
      btnWrap.className = 'apply-btn-wrap';

      if (filePath) {
        btnWrap.innerHTML = `
          <button class="apply-btn" onclick="app._applyCodeBlock(this, '${esc(filePath)}')">
            <span>Apply to</span> <code>${esc(filePath)}</code>
          </button>`;
      } else {
        btnWrap.innerHTML = `
          <button class="apply-btn" onclick="app._applyCodeBlockPrompt(this)">
            <span>Apply to file…</span>
          </button>`;
      }
      pre.after(btnWrap);
    });
  }

  async _applyCodeBlock(btn, path) {
    const pre = btn.closest('.apply-btn-wrap')?.previousElementSibling;
    const code = pre?.querySelector('code')?.textContent || '';
    if (!code) return;

    const cleanCode = code.replace(/^(?:\/\/\s*|#\s*|<!--\s*)[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+\s*(?:-->)?\n?/, '');

    await this.workspace.writeFile(this.currentProjId, path, cleanCode);
    await this.db.put('projects', { ...this.currentProj, updatedAt: Date.now() });

    btn.classList.add('applied');
    btn.innerHTML = `✓ Applied to <code>${esc(path)}</code>`;
    this._toast(`Updated: ${path}`, 'success');
  }

  async _applyCodeBlockPrompt(btn) {
    const path = prompt('File path to write this code to:');
    if (!path) return;
    await this._applyCodeBlock(btn, path);
  }

  async _send() {
    if (this.isGenerating) return;
    const input = document.getElementById('chatInput');
    const text  = input.value.trim();
    if (!text) return;

    if (!this.currentProjId) {
      this._toast('Create or select a project first', 'warning');
      return;
    }

    const selStr = document.getElementById('modelSelect').value;
    if (!selStr) {
      this._toast('Select an AI model', 'warning');
      return;
    }
    const modelObj = JSON.parse(selStr);

    input.value = '';
    input.style.height = 'auto';

    const userMsg = {
      projectId: this.currentProjId,
      role:      'user',
      content:   text,
      timestamp: Date.now()
    };
    if (this.cfg.autosave) userMsg.id = await this.db.put('messages', userMsg);
    this.messages.push(userMsg);
    this._renderMessages();

    this.isGenerating = true;
    const sendBtn = document.getElementById('sendBtn');
    sendBtn.disabled = true;

    const snap = await this.ghWorkspace?.getSnapshot(this.currentProjId);
    const repoInfo = snap ? { owner: snap.owner, repo: snap.repo, branch: snap.branch } : null;

    this._updateCtxIndicator('Building context…');
    const ctxString = await this.ctx.build(this.currentProjId, this.openFilePath, repoInfo, text);
    this._updateCtxIndicator(ctxString ? 'Context injected' : '');

    const rolePrompt   = ROLES[this.activeRole] || ROLES[''];
    const customPrompt = this.cfg.systemPrompt ? `\n\nUser System Instructions: ${this.cfg.systemPrompt}` : '';
    const systemContent = rolePrompt + customPrompt + (ctxString ? `\n\n--- CURRENT PROJECT CONTEXT ---\n${ctxString}` : '');

    const apiMsgs = [
      { role: 'system', content: systemContent },
      ...this.messages.slice(-MAX_HISTORY).map(m => ({ role: m.role, content: m.content }))
    ];

    const assistantMsg = {
      projectId: this.currentProjId,
      role:      'assistant',
      content:   '',
      timestamp: Date.now()
    };
    this.messages.push(assistantMsg);

    const wrap = document.getElementById('chatMessages');
    const aiDiv = document.createElement('div');
    aiDiv.className = 'message assistant';
    aiDiv.innerHTML = `
      <div class="msg-avatar">AI</div>
      <div class="msg-body">
        <div class="msg-name">MiniCodi</div>
        <div class="msg-bubble"><div class="loading-dots"><span></span><span></span><span></span></div></div>
      </div>
    `;
    wrap.appendChild(aiDiv);
    wrap.scrollTop = wrap.scrollHeight;
    const bubble = aiDiv.querySelector('.msg-bubble');

    try {
      let client;
      if (modelObj.provider === 'groq') {
        if (!this.cfg.groqKey) throw new Error('Groq API Key missing in Settings');
        client = new GroqClient(this.cfg.groqKey);
      } else {
        if (!this.cfg.openrouterKey) throw new Error('OpenRouter API Key missing in Settings');
        client = new OpenRouterClient(this.cfg.openrouterKey);
      }

      let fullText = '';
      for await (const chunk of client.stream(apiMsgs, modelObj.id, this.cfg.maxTokens)) {
        fullText += chunk;
        bubble.innerHTML = renderMd(fullText);
        wrap.scrollTop = wrap.scrollHeight;
      }

      assistantMsg.content = fullText;
      if (this.cfg.autosave) assistantMsg.id = await this.db.put('messages', assistantMsg);
      this._injectApplyButtons();

    } catch (e) {
      bubble.innerHTML = `<span style="color:var(--danger)">Error: ${esc(e.message)}</span>`;
      assistantMsg.content = `Error: ${e.message}`;
    } finally {
      this.isGenerating = false;
      sendBtn.disabled  = false;
      this._updateCtxIndicator('');
    }
  }

  _updateCtxIndicator(text) {
    const el = document.getElementById('ctxIndicator');
    if (el) el.textContent = text;
  }

  _setupGit() {
    document.getElementById('btnConnectGit').addEventListener('click', async () => {
      const token = document.getElementById('githubTokenInput').value.trim();
      if (!token) { this._toast('Token required', 'error'); return; }
      await this.db.put('settings', { key: 'githubToken', value: token });
      this.cfg.githubToken = token;
      this.gh          = new GitHub(token);
      this.ghWorkspace = new GitWorkspace(this.db, this.workspace, this.gh);
      await this._connectGit();
    });

    document.getElementById('btnDisconnectGit').addEventListener('click', async () => {
      await this.db.del('settings', 'githubToken');
      this.cfg.githubToken = null;
      this.gh              = null;
      this.ghWorkspace     = null;
      this.ghUser          = null;
      this.repos           = [];
      this.currentRepo     = null;
      document.getElementById('gitNotConnected').classList.remove('hidden');
      document.getElementById('gitConnected').classList.add('hidden');
      this._toast('Disconnected from GitHub');
    });

    document.getElementById('btnPull').addEventListener('click', () => this._doPull());
    document.getElementById('btnCommit').addEventListener('click', () => openSheet('sheetCommit'));
    document.getElementById('btnPush').addEventListener('click', () => openSheet('sheetCommit'));
    document.getElementById('btnDoCommit').addEventListener('click', () => this._doPush());

    document.getElementById('zipUpload').addEventListener('change', e => this._handleZipUpload(e));
  }

  async _tryAutoConnectGit() {
    if (!this.cfg.githubToken) return;
    try {
      await this._connectGit();
    } catch (e) {
      console.warn('Auto GitHub connect failed:', e.message);
    }
  }

  async _connectGit() {
    try {
      this.ghUser = await this.gh.getUser();
      document.getElementById('gitNotConnected').classList.add('hidden');
      document.getElementById('gitConnected').classList.remove('hidden');
      document.getElementById('gitUserName').textContent  = this.ghUser.name || this.ghUser.login;
      document.getElementById('gitUserLogin').textContent = `@${this.ghUser.login}`;
      await this._loadRepos();
    } catch (e) {
      this._toast(`GitHub connection failed: ${e.message}`, 'error');
    }
  }

  async _loadRepos() {
    this.repos = await this.gh.getRepos();
    const list = document.getElementById('repoList');
    list.innerHTML = this.repos.map(r => `
      <div class="repo-card ${this.currentRepo?.repo === r.name ? 'selected' : ''}"
           onclick="app._selectRepo('${r.owner.login}', '${r.name}', '${r.default_branch}')">
        <div class="repo-name">${esc(r.full_name)}</div>
        <div class="repo-meta">${r.private ? '🔒 Private' : '🌐 Public'} · ${r.default_branch} · ${this._ago(new Date(r.updated_at).getTime())}</div>
      </div>
    `).join('');
  }

  async _selectRepo(owner, repo, branch) {
    this.currentRepo = { owner, repo, branch };
    document.getElementById('repoDetail').classList.remove('hidden');
    document.getElementById('repoDetailName').textContent = `${owner}/${repo} (${branch})`;
    this._loadRepos();

    if (!this.currentProjId) {
      const p = {
        name:      repo,
        desc:      `Imported from GitHub ${owner}/${repo}`,
        stack:     'other',
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      const id = await this.db.put('projects', p);
      await this._loadProjects();
      this.currentProjId = id;
      this.currentProj   = p;
    }

    try {
      const commits = await this.gh.getCommits(owner, repo, branch);
      document.getElementById('commitList').innerHTML = commits.map(c => `
        <div style="font-size:12px;padding:6px 0;border-bottom:1px solid var(--border);">
          <div class="font-mono text-accent">${c.sha.slice(0, 7)} — ${esc(c.commit.message.split('\n')[0])}</div>
          <div class="text-tertiary">${c.commit.author.name} · ${this._ago(new Date(c.commit.author.date).getTime())}</div>
        </div>
      `).join('');
    } catch (e) {
      console.warn('Commits load failed:', e.message);
    }
  }

  async _doPull() {
    if (!this.currentProjId || !this.currentRepo) {
      this._toast('Select a project and GitHub repository first', 'warning');
      return;
    }
    const { owner, repo, branch } = this.currentRepo;
    const btn = document.getElementById('btnPull');
    btn.disabled = true;

    try {
      const res = await this.ghWorkspace.pull(this.currentProjId, owner, repo, branch, msg => {
        this._toast(msg, 'warning');
      });
      this._toast(`Pulled ${res.fileCount} files (${res.commitSha.slice(0,7)})`, 'success');
      this._renderFileBrowser();
    } catch (e) {
      this._toast(`Pull failed: ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async _doPush() {
    if (!this.currentProjId || !this.currentRepo) {
      this._toast('Select a project and GitHub repository first', 'warning');
      return;
    }
    const msg = document.getElementById('commitMsg').value.trim();
    if (!msg) { this._toast('Commit message required', 'error'); return; }

    const { owner, repo, branch } = this.currentRepo;
    const btn = document.getElementById('btnDoCommit');
    btn.disabled = true;

    try {
      const res = await this.ghWorkspace.push(this.currentProjId, owner, repo, branch, msg, status => {
        this._toast(status, 'warning');
      });
      closeSheet('sheetCommit');
      closeSheet('sheetChanges');
      document.getElementById('commitMsg').value = '';
      this._toast(`Pushed commit ${res.commitSha.slice(0,7)}`, 'success');
      this._renderFileBrowser();
    } catch (e) {
      this._toast(`Push failed: ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async _handleZipUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    if (typeof JSZip === 'undefined') {
      this._toast('JSZip library not loaded. Ensure JSZip script is included.', 'error');
      return;
    }

    try {
      const zip = await JSZip.loadAsync(file);
      const projName = file.name.replace(/\.zip$/i, '');

      const p = {
        name:      projName,
        desc:      'Imported from ZIP archive',
        stack:     'other',
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      const projId = await this.db.put('projects', p);
      await this._loadProjects();
      this._selectProject(projId);

      let count = 0;
      for (const [path, zipEntry] of Object.entries(zip.files)) {
        if (zipEntry.dir || SKIP_EXTS.test(path)) continue;
        const content = await zipEntry.async('string');
        await this.workspace.writeFile(projId, path, content, { status: 'clean', baseContent: content });
        count++;
      }

      this._toast(`Imported ZIP with ${count} files`, 'success');
      this._renderFileBrowser();

    } catch (err) {
      this._toast(`Failed to load ZIP: ${err.message}`, 'error');
    }
  }

  async _exportZip() {
    if (!this.currentProjId) return;
    if (typeof JSZip === 'undefined') {
      this._toast('JSZip library required to export ZIP', 'error');
      return;
    }

    const files = await this.workspace.listFiles(this.currentProjId);
    const zip   = new JSZip();

    for (const f of files) {
      if (f.status !== 'deleted' && f.content != null) {
        zip.file(f.path, f.content);
      }
    }

    const blob = await zip.generateAsync({ type: 'blob' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = `${this.currentProj.name || 'project'}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
    this._toast('Exported ZIP archive', 'success');
  }

  _refreshGitUI() {
    if (this.cfg.githubToken && !this.ghUser) {
      this._connectGit();
    }
  }

  _setupSettings() {
    document.getElementById('btnSaveSettings').addEventListener('click', () => this._saveSettings());
    document.getElementById('btnExport').addEventListener('click', () => this._exportData());
    document.getElementById('btnImport').addEventListener('click', () => document.getElementById('importFile').click());
    document.getElementById('importFile').addEventListener('change', e => this._importData(e));
    document.getElementById('btnClearAll').addEventListener('click', () => this._clearAllData());
  }

  async _exportData() {
    const data = {
      projects:  await this.db.getAll('projects'),
      messages:  await this.db.getAll('messages'),
      settings:  await this.db.getAll('settings'),
      files:     await this.db.getAll('files'),
      snapshots: await this.db.getAll('gitSnapshots'),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = `minicodi-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    this._toast('Exported configuration & project data', 'success');
  }

  async _importData(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (data.projects)  for (const p of data.projects)  await this.db.put('projects', p);
      if (data.messages)  for (const m of data.messages)  await this.db.put('messages', m);
      if (data.settings)  for (const s of data.settings)  await this.db.put('settings', s);
      if (data.files)     for (const f of data.files)     await this.db.put('files', f);
      if (data.snapshots) for (const s of data.snapshots) await this.db.put('gitSnapshots', s);

      await this._loadSettings();
      await this._loadProjects();
      this._applySettings();
      this._renderProjects();
      this._toast('Import successful', 'success');
    } catch (err) {
      this._toast(`Import failed: ${err.message}`, 'error');
    }
  }

  async _clearAllData() {
    if (!confirm('Clear all projects, settings, and workspace data? This cannot be undone.')) return;
    await this.db.clear('projects');
    await this.db.clear('messages');
    await this.db.clear('settings');
    await this.db.clear('files');
    await this.db.clear('gitSnapshots');

    this.cfg           = {};
    this.projects      = [];
    this.currentProjId = null;
    this.currentProj   = null;
    this.messages      = [];
    this.openFilePath  = null;

    this._applySettings();
    this._renderProjects();
    this._renderMessages();
    this._renderFileBrowser();
    this._toast('All data cleared');
  }

  _toast(msg, type = 'info') {
    const wrap  = document.getElementById('toasts');
    if (!wrap) return;
    const t     = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    wrap.appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
      t.style.transform = 'translateY(-10px)';
      setTimeout(() => t.remove(), 250);
    }, 3000);
  }

  _ago(ms) {
    const sec = Math.floor((Date.now() - ms) / 1000);
    if (sec < 60)   return 'just now';
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  }
}

// Instantiate and attach global instance
const app = new App();
window.app = app;
document.addEventListener('DOMContentLoaded', () => app.init());

