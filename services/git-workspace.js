import { Workspace } from './workspace.js';
import { DB } from './db.js';

export class GitWorkspace {
  constructor() {
    this.workspace = new Workspace();
    this.db = new DB();
  }

  async init() {
    await this.workspace.init();
  }

  /**
   * Pulls the repository state into the local IndexedDB workspace.
   * @param {number} projectId - The local project ID
   * @param {GitHubClient} ghClient - Authenticated GitHub client
   */
  async pull(projectId, ghClient) {
    const project = await this.db.get('projects', projectId);
    if (!project || !project.githubOwner || !project.githubRepo || !project.githubBranch) {
      throw new Error('Project is not linked to a GitHub repository/branch.');
    }

    const { githubOwner: owner, githubRepo: repo, githubBranch: branch } = project;
    const ref = `heads/${branch}`;

    // 1. Resolve branch to get current commit SHA
    const refData = await ghClient.getRef(owner, repo, ref);
    const commitSha = refData.object.sha;

    // 2. Get recursive tree to find all files
    // Note: We need the tree of the commit, not the ref. 
    // The ref points to a commit. We need to get the commit to get its tree, 
    // OR we can assume the ref object is a commit and fetch it, but GitHub's 
    // getRef returns { object: { sha, type: 'commit', url } }.
    // Let's fetch the commit to get the tree SHA.
    const commitData = await ghClient._req(`/repos/${owner}/${repo}/git/commits/${commitSha}`);
    const treeSha = commitData.tree.sha;

    const treeData = await ghClient.getTree(owner, repo, treeSha, true);
    
    // Filter only blobs (files), ignore directories and submodules
    const filesToPull = treeData.tree.filter(item => item.type === 'blob');

    // 3. Download file contents and prepare workspace records
    const workspaceFiles = [];
    
    // Process in batches to avoid overwhelming the browser/network
    const batchSize = 5;
    for (let i = 0; i < filesToPull.length; i += batchSize) {
      const batch = filesToPull.slice(i, i + batchSize);
      const promises = batch.map(async (item) => {
        try {
          const content = await ghClient.getFile(owner, repo, item.path);
          return {
            projectId,
            path: item.path,
            content,
            githubSha: item.sha,
            baseContent: content,
            status: 'clean',
            updatedAt: Date.now()
          };
        } catch (err) {
          console.warn(`Failed to pull ${item.path}:`, err.message);
          return null;
        }
      });
      
      const results = await Promise.all(promises);
      workspaceFiles.push(...results.filter(r => r !== null));
    }

    // 4. Bulk write to IndexedDB (replaces old files for this project to ensure clean state)
    // First, clear existing files for this project to avoid stale 'deleted' files lingering
    const existingFiles = await this.workspace.listFiles(projectId);
    for (const f of existingFiles) {
      await this.db.delete('files', f.id);
    }
    
    // Then bulk insert the fresh pull
    if (workspaceFiles.length > 0) {
      await this.db.bulkPut('files', workspaceFiles);
    }

    // 5. Save Git Snapshot
    await this.workspace.saveSnapshot(projectId, branch, commitSha);

    return {
      pulledCount: workspaceFiles.length,
      commitSha,
      branch
    };
  }
}
