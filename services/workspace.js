import { DB } from './db.js';

export class Workspace {
  constructor() {
    this.db = new DB();
  }

  async init() {
    await this.db.init();
  }

  async listFiles(projectId) {
    return await this.db.byIndex('files', 'projectId', projectId);
  }

  async readFile(projectId, path) {
    const files = await this.listFiles(projectId);
    return files.find(f => f.path === path) || null;
  }

  async writeFile(projectId, path, content) {
    const existing = await this.readFile(projectId, path);
    const now = Date.now();
    
    let status = 'modified';
    let githubSha = existing ? existing.githubSha : null;
    let baseContent = existing ? existing.baseContent : null;

    // If it was a new file being written for the first time, keep it 'new'
    if (existing && existing.status === 'new') status = 'new';
    // If it was deleted and now rewritten, it's modified from base
    if (existing && existing.status === 'deleted') status = 'modified';

    const fileRecord = {
      id: existing ? existing.id : undefined,
      projectId,
      path,
      content,
      githubSha,
      baseContent,
      status,
      updatedAt: now
    };

    return await this.db.put('files', fileRecord);
  }

  async createFile(projectId, path, content) {
    // Check if exists
    const existing = await this.readFile(projectId, path);
    if (existing) {
      return this.writeFile(projectId, path, content);
    }
    return await this.db.put('files', {
      projectId, path, content,
      githubSha: null, baseContent: null, status: 'new',
      updatedAt: Date.now()
    });
  }

  async deleteFile(projectId, path) {
    const existing = await this.readFile(projectId, path);
    if (!existing) return;

    // Soft delete to preserve baseContent for diffing and Git deletion
    existing.status = 'deleted';
    existing.content = null; 
    existing.updatedAt = Date.now();
    await this.db.put('files', existing);
  }

  async getChanges(projectId) {
    const files = await this.listFiles(projectId);
    return files.filter(f => f.status !== 'clean');
  }

  async applyChanges(projectId, changes) {
    // changes: [{ path, action: 'modify'|'create'|'delete', content }]
    for (const change of changes) {
      if (change.action === 'delete') {
        await this.deleteFile(projectId, change.path);
      } else if (change.action === 'create') {
        await this.createFile(projectId, change.path, change.content);
      } else {
        await this.writeFile(projectId, change.path, change.content);
      }
    }
  }

  async saveSnapshot(projectId, branch, commitSha) {
    await this.db.put('gitSnapshots', {
      projectId, branch, commitSha, createdAt: Date.now()
    });
  }

  async getLatestSnapshot(projectId) {
    const snapshots = await this.db.byIndex('gitSnapshots', 'projectId', projectId);
    return snapshots.sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  }
}
