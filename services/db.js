export class DB {
  constructor() {
    this.dbName = 'MiniCodi';
    this.version = 2;
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        // v1 stores (create if not exists)
        if (!db.objectStoreNames.contains('projects')) {
          db.createObjectStore('projects', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('messages')) {
          const msgStore = db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
          msgStore.createIndex('projectId', 'projectId', { unique: false });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }

        // v2 stores & migrations
        if (!db.objectStoreNames.contains('files')) {
          const fileStore = db.createObjectStore('files', { keyPath: 'id', autoIncrement: true });
          fileStore.createIndex('projectId', 'projectId', { unique: false });
        } else {
          // Migrate existing v1 files to v2 schema
          const tx = event.target.transaction;
          const fileStore = tx.objectStore('files');
          fileStore.openCursor().onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
              const val = cursor.value;
              if (!val.githubSha) val.githubSha = null;
              if (!val.baseContent) val.baseContent = null;
              if (!val.status) val.status = 'clean';
              cursor.update(val);
              cursor.continue();
            }
          };
        }

        if (!db.objectStoreNames.contains('gitSnapshots')) {
          const snapStore = db.createObjectStore('gitSnapshots', { keyPath: 'id', autoIncrement: true });
          snapStore.createIndex('projectId', 'projectId', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve();
      };
      request.onerror = (event) => reject(event.target.error);
    });
  }

  async getAll(store) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async get(store, id) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async put(store, value) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).put(value);
      req.onsuccess = () => resolve(req.result); // returns key/id
      req.onerror = () => reject(req.error);
    });
  }

  async bulkPut(store, values) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readwrite');
      const objStore = tx.objectStore(store);
      let completed = 0;
      let error = null;

      values.forEach(val => {
        const req = objStore.put(val);
        req.onsuccess = () => {
          completed++;
          if (completed === values.length && !error) resolve();
        };
        req.onerror = () => {
          error = req.error;
          reject(error);
        };
      });
      if (values.length === 0) resolve();
    });
  }

  async delete(store, id) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async byIndex(store, indexName, value) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readonly');
      const index = tx.objectStore(store).index(indexName);
      const req = index.getAll(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
}
