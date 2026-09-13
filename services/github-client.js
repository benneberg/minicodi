export class GitHubClient {
  constructor(token) {
    this.token = token;
    this.base = 'https://api.github.com';
  }

  async _req(endpoint, options = {}) {
    const headers = {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `token ${this.token}`,
      ...options.headers
    };
    const res = await fetch(`${this.base}${endpoint}`, { ...options, headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `GitHub API Error: ${res.status}`);
    }
    return res.json();
  }

  // --- Existing Browsing APIs ---
  async getUser() { return this._req('/user'); }
  async getRepos() { return this._req('/user/repos?sort=updated&per_page=50'); }
  
  async getContents(owner, repo, path = '') {
    return this._req(`/repos/${owner}/${repo}/contents/${path}`);
  }

  async getFile(owner, repo, path) {
    const data = await this._req(`/repos/${owner}/${repo}/contents/${path}`);
    if (data.encoding === 'base64') {
      return atob(data.content.replace(/\s/g, ''));
    }
    return data.content;
  }

  // --- Git Data API Primitives (Step 2) ---
  async getRef(owner, repo, ref) {
    // ref should be 'heads/main' or 'heads/branch-name'
    return this._req(`/repos/${owner}/${repo}/git/ref/${ref}`);
  }

  async getTree(owner, repo, treeSha, recursive = true) {
    const url = `/repos/${owner}/${repo}/git/trees/${treeSha}${recursive ? '?recursive=1' : ''}`;
    return this._req(url);
  }

  async createBlob(owner, repo, content) {
    // GitHub API accepts utf-8 or base64. We use base64 to safely handle any file type.
    const encoded = btoa(unescape(encodeURIComponent(content)));
    return this._req(`/repos/${owner}/${repo}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: encoded, encoding: 'base64' })
    });
  }

  async createTree(owner, repo, tree, baseTreeSha = null) {
    const body = { tree, ...(baseTreeSha ? { base_tree: baseTreeSha } : {}) };
    return this._req(`/repos/${owner}/${repo}/git/trees`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
  }

  async createCommit(owner, repo, message, treeSha, parentSha) {
    return this._req(`/repos/${owner}/${repo}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({ message, tree: treeSha, parents: [parentSha] })
    });
  }

  async updateRef(owner, repo, ref, sha, force = false) {
    return this._req(`/repos/${owner}/${repo}/git/refs/${ref}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha, force })
    });
  }
}
