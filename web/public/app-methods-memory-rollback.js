(function attachHmAppMemoryRollbackMethods(globalObj) {
  function createMethods() {
    return {
      openRollbackModal() {
        const now = new Date();
        const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, 16);
        this.rollbackCutoffLocal = local;
        this.rollbackPreview = null;
        this.showRollbackModal = true;
        this.loadRollbackBackups();
      },

      async loadRollbackBackups() {
        if (!this.selectedAgent) return;
        try {
          const response = await fetch(`/api/agents/${this.selectedAgent}/memory/rollback/backups`);
          const data = await response.json();
          if (!response.ok || !data.success) return;
          this.rollbackLastBackupId = data.backups?.[0]?.backupId || '';
        } catch (e) {
          console.error('Failed to load rollback backups:', e);
        }
      },

      async previewRollback() {
        if (!this.selectedAgent || this.rollbackPreviewInProgress) return;
        if (!this.rollbackCutoffIso) {
          this.rollbackMessage = 'Invalid cutoff datetime';
          return;
        }
        this.rollbackPreviewInProgress = true;
        this.rollbackMessage = '';
        this.rollbackPreview = null;
        try {
          const response = await fetch(`/api/agents/${this.selectedAgent}/memory/rollback/preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cutoffTs: this.rollbackCutoffIso })
          });
          const data = await response.json();
          if (!response.ok || !data.success) {
            throw new Error(data.error || `HTTP ${response.status}`);
          }
          this.rollbackPreview = data.preview;
        } catch (e) {
          console.error('Rollback preview failed:', e);
          this.rollbackMessage = `Rollback preview failed: ${e.message}`;
        } finally {
          this.rollbackPreviewInProgress = false;
        }
      },

      async applyRollback() {
        if (!this.selectedAgent || this.rollbackApplyInProgress) return;
        if (!this.rollbackCutoffIso) {
          this.rollbackMessage = 'Invalid cutoff datetime';
          return;
        }
        if (!this.rollbackPreview) {
          this.rollbackMessage = 'Preview is required before apply';
          return;
        }
        this.rollbackApplyInProgress = true;
        this.rollbackMessage = '';
        try {
          const response = await fetch(`/api/agents/${this.selectedAgent}/memory/rollback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cutoffTs: this.rollbackCutoffIso })
          });
          const data = await response.json();
          if (!response.ok || !data.success) {
            throw new Error(data.error || `HTTP ${response.status}`);
          }
          this.rollbackLastBackupId = data.backupId || '';
          this.rollbackMessage = `Rollback applied. Backup: ${this.rollbackLastBackupId || 'N/A'}`;
          await Promise.all([
            this.loadAgentData(),
            this.loadMessageDates(),
            this.loadAgents()
          ]);
        } catch (e) {
          console.error('Rollback apply failed:', e);
          this.rollbackMessage = `Rollback apply failed: ${e.message}`;
        } finally {
          this.rollbackApplyInProgress = false;
        }
      },

      async restoreRollback() {
        if (!this.selectedAgent || !this.rollbackLastBackupId || this.rollbackRestoreInProgress) return;

        this.rollbackRestoreInProgress = true;
        this.rollbackMessage = '';
        try {
          const response = await fetch(
            `/api/agents/${this.selectedAgent}/memory/rollback/restore/${encodeURIComponent(this.rollbackLastBackupId)}`,
            { method: 'POST' }
          );
          const data = await response.json();
          if (!response.ok || !data.success) {
            throw new Error(data.error || `HTTP ${response.status}`);
          }
          this.rollbackMessage = 'Rollback restore completed';
          await Promise.all([
            this.loadAgentData(),
            this.loadMessageDates(),
            this.loadAgents(),
            this.loadRollbackBackups()
          ]);
        } catch (e) {
          console.error('Rollback restore failed:', e);
          this.rollbackMessage = `Rollback restore failed: ${e.message}`;
        } finally {
          this.rollbackRestoreInProgress = false;
        }
      }
    };
  }

  globalObj.HmAppMemoryRollbackMethods = { createMethods };
}(window));
