/**
 * Xerago Engineering Dashboard — browser client
 * Shared backend API + JWT auth + Socket.io live sync
 */
(() => {
  const API = '';
  const TOKEN_KEY = 'xerago_jwt';

  // ——— API helper ———
  async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) headers.Authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(API + path, { ...options, headers });
    } catch {
      throw new Error('Cannot reach server. Open http://localhost:3847 (run npm start).');
    }
    const data = await res.json().catch(() => ({}));
    // Do not treat failed login as "session expired"
    if (res.status === 401 && path !== '/api/auth/login') {
      localStorage.removeItem(TOKEN_KEY);
      showLogin();
      throw new Error(data.error || 'Session expired — please sign in again');
    }
    if (!res.ok) throw new Error(data.error || res.statusText || 'Request failed');
    return data;
  }

  // ——— Auth ———
  const XeragoAuth = {
    currentUser: null,
    async init() {
      const token = localStorage.getItem(TOKEN_KEY);
      if (!token) {
        showLogin();
        return false;
      }
      try {
        const { user } = await api('/api/auth/me');
        this.currentUser = user;
        updateUserUI();
        applyRoleGates();
        hideLogin();
        return true;
      } catch {
        showLogin();
        return false;
      }
    },
    getCurrentUser() {
      return this.currentUser;
    },
    isAdmin() {
      return this.currentUser && this.currentUser.accessLevel === 'admin';
    },
    async login(username, password) {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });
      localStorage.setItem(TOKEN_KEY, data.token);
      this.currentUser = data.user;
      updateUserUI();
      applyRoleGates();
      hideLogin();
      if (window.__xeragoSocket) {
        window.__xeragoSocket.emit('join', { userId: data.user.id, accessLevel: data.user.accessLevel });
      }
      return data.user;
    },
    logout() {
      localStorage.removeItem(TOKEN_KEY);
      this.currentUser = null;
      showLogin();
    }
  };

  function updateUserUI() {
    const u = XeragoAuth.currentUser;
    if (!u) return;
    const nameEl = document.getElementById('currentUserName');
    const avatarEl = document.getElementById('currentUserAvatar');
    const labelEl = document.getElementById('myTasksMemberLabel');
    if (nameEl) nameEl.textContent = `${u.name} (${u.role})`;
    if (avatarEl) avatarEl.textContent = u.name.charAt(0);
    if (labelEl) labelEl.textContent = u.name;
    const badge = document.getElementById('accessLevelBadge');
    if (badge) {
      badge.textContent = u.accessLevel === 'admin' ? 'ADMIN' : 'TEAM';
      badge.className = 'brand-tag ' + (u.accessLevel === 'admin' ? 'admin-badge' : 'member-badge');
    }
  }

  function applyRoleGates() {
    const admin = XeragoAuth.isAdmin();
    document.querySelectorAll('[data-admin-only]').forEach((el) => {
      el.style.display = admin ? '' : 'none';
    });
    const createBtns = [
      document.getElementById('createProjectHeaderBtn'),
      ...document.querySelectorAll('[onclick*="createProjectModal"]')
    ];
    createBtns.forEach((btn) => {
      if (!btn) return;
      btn.style.display = admin ? '' : 'none';
    });
    document.body.classList.toggle('is-admin', !!admin);
    document.body.classList.toggle('is-member', !admin);
    const sub = document.getElementById('adminViewSubtitle');
    if (sub) {
      sub.textContent = admin
        ? 'Admin: edit Team Database + review Workflow Templates. Projects/vendors/docs stay in the sidebar.'
        : 'View Team Database & Workflow Templates only. Sidebar has Projects, Vendors, Docs, etc.';
    }
  }

  function showLogin() {
    const overlay = document.getElementById('loginOverlay');
    if (overlay) overlay.classList.add('active');
    document.body.classList.add('logged-out');
  }

  function hideLogin() {
    const overlay = document.getElementById('loginOverlay');
    if (overlay) overlay.classList.remove('active');
    document.body.classList.remove('logged-out');
  }

  // ——— Data layer (API-backed, same shape as old IndexedDB helpers) ———
  const cache = {
    team: [],
    vendors: [],
    projects: [],
    tasks: [],
    blockers: [],
    documents: [],
    activity_log: []
  };

  const XeragoDB = {
    async open() {
      await this.refreshAll();
    },
    async refreshAll() {
      const stores = Object.keys(cache);
      await Promise.all(
        stores.map(async (s) => {
          try {
            cache[s] = await api(`/api/${s}`);
          } catch {
            cache[s] = cache[s] || [];
          }
        })
      );
    },
    async getAll(store) {
      return [...(cache[store] || [])];
    },
    async get(store, id) {
      return (cache[store] || []).find((x) => x.id === id) || null;
    },
    async getArchivedProjects() {
      try {
        const all = await api('/api/projects?includeArchived=1');
        return (all || []).filter((p) => p.archived);
      } catch {
        return [];
      }
    },
    async put(store, item) {
      // Prefer typed endpoints where needed; generic put for local cache only after API calls
      const idx = (cache[store] || []).findIndex((x) => x.id === item.id);
      if (idx >= 0) cache[store][idx] = item;
      else {
        cache[store] = cache[store] || [];
        cache[store].push(item);
      }
      return item;
    },
    async logActivity() {
      /* server writes activity */
    },
    async exportSnapshot() {
      if (!XeragoAuth.isAdmin()) return alert('Admin only');
      const data = await api('/api/admin/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Xerago_Engineering_DB_Backup_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
    },
    async resetToSeed() {
      if (!XeragoAuth.isAdmin()) return alert('Admin only');
      if (!confirm('Reset shared database to seed defaults? This affects the whole team.')) return;
      await api('/api/admin/reset', { method: 'POST', body: '{}' });
      await this.refreshAll();
      location.reload();
    }
  };

  const XeragoRules = {
    async recommendVendors(service) {
      return api(`/api/vendors/recommend?service=${encodeURIComponent(service || '')}`);
    }
  };

  // ——— UI ———
  const UI = (() => {
    let activeView = 'dashboardView';
    let currentDetailProjectId = null;
    let myTasksFilter = 'open';

    async function init() {
      setupNavigation();
      setupModals();
      setupSearch();
      setupLoginForm();
      setupChangePasswordForm();
      document.getElementById('changePasswordBtn')?.addEventListener('click', () => openChangePassword(false));
      await renderActiveView();
      updateStorageMeter();
      maybeForcePasswordChange();
    }

    function setupLoginForm() {
      const form = document.getElementById('loginForm');
      if (!form) return;
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const errEl = document.getElementById('loginError');
        const submitBtn = form.querySelector('[type="submit"]');
        errEl.textContent = '';
        const username = document.getElementById('loginUsername').value.trim();
        const password = document.getElementById('loginPassword').value;
        if (!username || !password) {
          errEl.textContent = 'Enter username (or email) and password';
          return;
        }
        const prev = submitBtn?.textContent;
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = 'Signing in…';
        }
        try {
          await XeragoAuth.login(username, password);
          try {
            await XeragoDB.refreshAll();
          } catch (refreshErr) {
            console.warn('Data refresh after login:', refreshErr);
          }
          await renderActiveView();
          showToast(`Signed in as ${XeragoAuth.getCurrentUser()?.name || username}`);
          maybeForcePasswordChange();
        } catch (err) {
          errEl.textContent = err.message || 'Login failed';
        } finally {
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = prev || 'Sign in';
          }
        }
      });

    }

    function setupNavigation() {
      document.querySelectorAll('.nav-item').forEach((item) => {
        item.addEventListener('click', () => {
          document.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'));
          item.classList.add('active');
          switchView(item.getAttribute('data-view'));
        });
      });

      document.getElementById('userSwitcherBtn')?.addEventListener('click', () => {
        if (confirm('Log out and switch user?')) XeragoAuth.logout();
      });

      document.getElementById('createProjectHeaderBtn')?.addEventListener('click', () => {
        if (!XeragoAuth.isAdmin()) return alert('Only the admin / manager can create projects.');
        openModal('createProjectModal');
      });
    }

    function switchView(viewId) {
      activeView = viewId;
      document.querySelectorAll('.view-panel').forEach((p) => (p.style.display = 'none'));
      const active = document.getElementById(viewId);
      if (active) active.style.display = 'block';
      renderActiveView();
    }

    async function renderActiveView() {
      if (!XeragoAuth.getCurrentUser()) return;
      updateSidebarBadges();
      switch (activeView) {
        case 'dashboardView':
          await renderDashboard();
          await loadDueReminders();
          break;
        case 'projectsView':
          await renderProjectsView();
          break;
        case 'myTasksView':
          await renderMyTasksView();
          break;
        case 'remainingWorkView':
          await renderRemainingWorkView();
          break;
        case 'pmCommandView':
          await renderPMCommandView();
          break;
        case 'vendorsView':
          await renderVendorsView();
          break;
        case 'raciMatrixView':
          await renderRaciMatrixView();
          break;
        case 'blockersHubView':
          await renderBlockersHubView();
          break;
        case 'documentVaultView':
          await renderDocumentVaultView();
          break;
        case 'projectHistoryView':
          await renderProjectHistoryView();
          break;
        case 'adminSettingsView':
          await renderAdminSettingsView();
          break;
        case 'projectDetailCanvasView':
          if (currentDetailProjectId) await openProjectDetail(currentDetailProjectId);
          break;
      }
    }

    async function updateSidebarBadges() {
      const projects = await XeragoDB.getAll('projects');
      const tasks = await XeragoDB.getAll('tasks');
      const blockers = await XeragoDB.getAll('blockers');
      const curUser = XeragoAuth.getCurrentUser();
      const set = (id, v) => {
        const el = document.getElementById(id);
        if (el) el.textContent = v;
      };
      set('sidebarProjectCount', projects.length);
      set('sidebarBlockerCount', blockers.filter((b) => b.status !== 'Resolved').length);
      if (curUser) {
        const myTasks = tasks.filter((t) => t.responsibleId === curUser.id && t.status !== 'Completed');
        set('sidebarMyTaskCount', myTasks.length);
        set('sidebarRemainingCount', tasks.filter((t) => t.status !== 'Completed').length);
      }
    }

    function teamName(id, team) {
      const m = (team || []).find((t) => t.id === id);
      return m ? m.name : '—';
    }

    async function renderDashboard() {
      const [projects, tasks, vendors, blockers, team, logs] = await Promise.all([
        XeragoDB.getAll('projects'),
        XeragoDB.getAll('tasks'),
        XeragoDB.getAll('vendors'),
        XeragoDB.getAll('blockers'),
        XeragoDB.getAll('team'),
        XeragoDB.getAll('activity_log')
      ]);

      const set = (id, v) => {
        const el = document.getElementById(id);
        if (el) el.textContent = v;
      };
      set('kpiActiveProjects', projects.filter((p) => p.status === 'In Progress').length);
      set('kpiTotalProjects', projects.length);
      set('kpiTotalTasks', tasks.length);
      set('kpiTasksInProgress', tasks.filter((t) => t.status === 'In Progress').length);
      set('kpiBlockers', blockers.filter((b) => b.status !== 'Resolved').length);
      set('kpiActiveVendors', vendors.filter((v) => v.status === 'Active').length);
      set('kpiVendorTasks', tasks.filter((t) => t.isExternal).length);

      const workloadGrid = document.getElementById('dashboardTeamWorkloadGrid');
      if (workloadGrid) {
        workloadGrid.innerHTML = team
          .map((member) => {
            const mTasks = tasks.filter((t) => t.responsibleId === member.id);
            const inProg = mTasks.filter((t) => t.status === 'In Progress').length;
            const done = mTasks.filter((t) => t.status === 'Completed').length;
            const rem = mTasks.filter((t) => t.status !== 'Completed').length;
            return `
            <div style="background:var(--bg-input); border:1px solid var(--border-color); padding:1rem; border-radius:10px;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
                <strong style="font-size:0.95rem;">${member.name}</strong>
                <span class="badge badge-primary">${rem} left</span>
              </div>
              <div style="font-size:0.78rem; color:var(--text-muted); margin-bottom:0.75rem;">${member.role}</div>
              <div style="display:flex; justify-content:space-between; font-size:0.75rem;">
                <span>In Progress: <strong style="color:var(--accent-cyan);">${inProg}</strong></span>
                <span>Completed: <strong style="color:var(--accent-emerald);">${done}</strong></span>
              </div>
            </div>`;
          })
          .join('');
      }

      const recentBody = document.getElementById('dashboardRecentProjectsBody');
      if (recentBody) {
        recentBody.innerHTML = projects
          .slice(0, 5)
          .map((p) => {
            const pTasks = tasks.filter((t) => t.projectId === p.id);
            const done = pTasks.filter((t) => t.status === 'Completed').length;
            const pct = pTasks.length ? Math.round((done / pTasks.length) * 100) : 0;
            return `
          <tr style="cursor:pointer;" onclick="UI.openProjectDetail('${p.id}')">
            <td><strong>${escapeHtml(p.name)}</strong></td>
            <td><span class="badge badge-cyan">${escapeHtml(p.type)}</span></td>
            <td>${escapeHtml(teamName(p.managerId, team))}</td>
            <td>
              <div style="display:flex; align-items:center; gap:0.5rem;">
                <div style="flex:1; height:6px; background:var(--bg-input); border-radius:3px; overflow:hidden;">
                  <div style="width:${pct}%; height:100%; background:var(--primary);"></div>
                </div>
                <span style="font-size:0.75rem;">${pct}%</span>
              </div>
            </td>
            <td><span class="badge badge-success">${escapeHtml(p.status)}</span></td>
          </tr>`;
          })
          .join('');
      }

      const logList = document.getElementById('dashboardActivityLogList');
      if (logList) {
        logList.innerHTML = logs
          .slice(-8)
          .reverse()
          .map(
            (l) => `
          <div style="display:flex; justify-content:space-between; padding-bottom:0.4rem; border-bottom:1px solid var(--border-color-light); gap:1rem;">
            <span><strong>${escapeHtml(l.changedBy)}</strong>: ${escapeHtml(l.action)}</span>
            <span style="color:var(--text-dim); font-size:0.75rem; white-space:nowrap;">${formatTime(l.timestamp)}</span>
          </div>`
          )
          .join('');
      }
    }

    async function renderProjectsView() {
      const projects = await XeragoDB.getAll('projects');
      const tasks = await XeragoDB.getAll('tasks');
      const team = await XeragoDB.getAll('team');
      const grid = document.getElementById('projectsGrid');
      if (!grid) return;
      if (!projects.length) {
        grid.innerHTML = `<div class="card" style="grid-column:1/-1; text-align:center; padding:2rem;">
          <h3>No projects yet</h3>
          <p style="color:var(--text-muted); margin:0.5rem 0 1rem;">Admin: create a project — AI / rules will assign work by designation.</p>
          ${XeragoAuth.isAdmin() ? `<button class="btn btn-primary" onclick="UI.openModal('createProjectModal')">+ Create Project</button>` : ''}
        </div>`;
        return;
      }
      grid.innerHTML = projects
        .map((p) => {
          const pTasks = tasks.filter((t) => t.projectId === p.id && t.status !== 'Draft');
          const proposedCount = (p.proposedPlan?.tasks || []).length;
          const done = pTasks.filter((t) => t.status === 'Completed').length;
          const pct = pTasks.length ? Math.round((done / pTasks.length) * 100) : 0;
          const pending = p.status === 'Pending Approval';
          const neededRoles = (p.proposedPlan?.analysis?.neededRoles || []).map((r) => r.role).join(', ');
          return `
            <div class="card" style="cursor:pointer;" onclick="UI.openProjectDetail('${p.id}')">
              <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:0.5rem;">
                <span class="badge badge-primary">${escapeHtml(p.type)}</span>
                <span class="badge ${pending ? 'badge-warning' : 'badge-success'}">${escapeHtml(p.status)}</span>
              </div>
              <h3 style="font-size:1.1rem; margin-bottom:0.4rem;">${escapeHtml(p.name)}</h3>
              <p style="font-size:0.8rem; color:var(--text-muted); margin-bottom:1rem; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">${escapeHtml(p.description)}</p>
              <div style="margin-bottom:0.75rem;">
                <div style="display:flex; justify-content:space-between; font-size:0.75rem; margin-bottom:0.25rem;">
                  <span>${pending ? `AI proposal: ${proposedCount} tasks${neededRoles ? ' · ' + neededRoles : ''} (not created yet)` : `Progress (${done}/${pTasks.length} · ${pTasks.length - done} left)`}</span>
                  <strong>${pending ? '—' : pct + '%'}</strong>
                </div>
                <div style="height:6px; background:var(--bg-input); border-radius:3px; overflow:hidden;">
                  <div style="width:${pending ? 0 : pct}%; height:100%; background:var(--accent-cyan);"></div>
                </div>
              </div>
              <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.75rem; color:var(--text-dim); gap:0.5rem;">
                <span>Target: ${escapeHtml(p.targetDate || 'TBD')} · ${escapeHtml(teamName(p.managerId, team))}</span>
                <span style="display:flex;gap:0.35rem;">
                  ${pending && XeragoAuth.isAdmin() ? `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();UI.reviewProjectPlan('${p.id}')">Verify plan</button>` : ''}
                  ${
                    XeragoAuth.isAdmin()
                      ? `<button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();UI.archiveProject('${p.id}')">Archive</button>
                         <button class="btn btn-secondary btn-sm" style="color:var(--accent-rose);" onclick="event.stopPropagation();UI.deleteProject('${p.id}')">Delete</button>`
                      : ''
                  }
                </span>
              </div>
            </div>`;
        })
        .join('');
    }

    async function openProjectDetail(projId) {
      currentDetailProjectId = projId;
      activeView = 'projectDetailCanvasView';
      document.querySelectorAll('.view-panel').forEach((p) => (p.style.display = 'none'));
      document.getElementById('projectDetailCanvasView').style.display = 'block';

      let proj = await XeragoDB.get('projects', projId);
      if (!proj) {
        try {
          proj = await api(`/api/projects/${projId}`);
        } catch {
          return;
        }
      }
      const tasks = await XeragoDB.getAll('tasks');
      const team = await XeragoDB.getAll('team');
      let pTasks = tasks.filter((t) => t.projectId === projId);
      if (proj.archived) {
        try {
          pTasks = await api(`/api/tasks?projectId=${encodeURIComponent(projId)}`);
        } catch {
          /* keep cache */
        }
      }
      if (!proj) return;

      const proposedCount = (proj.proposedPlan?.tasks || []).length;
      const adminBtns = XeragoAuth.isAdmin()
        ? `<div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
            ${proj.status === 'Pending Approval' || proposedCount ? `<button class="btn btn-primary btn-sm" onclick="UI.reviewProjectPlan('${proj.id}')">Review AI plan &amp; confirm</button>` : ''}
            <button class="btn btn-secondary btn-sm" onclick="UI.regenerateProjectTasks('${proj.id}')">Re-analyze with AI</button>
            <button class="btn btn-secondary btn-sm" onclick="UI.archiveProject('${proj.id}')">Archive</button>
            <button class="btn btn-secondary btn-sm" style="color:var(--accent-rose);" onclick="UI.deleteProject('${proj.id}')">Delete forever</button>
          </div>`
        : '';

      document.getElementById('projectDetailHeaderCard').innerHTML = `
          <div style="display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-wrap:wrap;">
            <div>
              <span class="badge badge-primary" style="margin-bottom:0.4rem;">${escapeHtml(proj.type)}</span>
              <span class="badge ${proj.status === 'Pending Approval' ? 'badge-warning' : 'badge-success'}">${escapeHtml(proj.status)}</span>
              <h2>${escapeHtml(proj.name)}</h2>
              <p style="color:var(--text-muted); font-size:0.875rem;">${escapeHtml(proj.description)}</p>
              ${proj.status === 'Pending Approval' ? `<p style="font-size:0.8rem;color:var(--accent-amber);margin-top:0.35rem;">AI proposed ${proposedCount} tasks — nothing assigned until you confirm.</p>` : ''}
            </div>
            ${adminBtns}
          </div>`;

      renderProjectPipeline(pTasks);
      renderProjectKanban(pTasks, team);
    }

    function stageState(stTasks) {
      if (!stTasks.length) return 'pending';
      const done = stTasks.every((t) => t.status === 'Completed');
      if (done) return 'done';
      const active = stTasks.some((t) =>
        ['In Progress', 'Submitted', 'Assigned', 'Not Started'].includes(t.status)
      );
      return active ? 'active' : 'pending';
    }

    function renderProjectPipeline(pTasks) {
      const stages = [
        'Requirements',
        'Architecture',
        'Components',
        'Schematic',
        'PCB',
        'Mechanical',
        'Firmware',
        'Procurement',
        'Assembly',
        'Testing',
        'Approval'
      ];
      const container = document.getElementById('projectPipelineContainer');
      if (!container) return;

      const visible = stages
        .map((st) => ({ st, tasks: pTasks.filter((t) => t.category === st) }))
        .filter((x) => x.tasks.length > 0);
      const flowStages = visible.length ? visible : stages.map((st) => ({ st, tasks: [] }));

      const completed = pTasks.filter((t) => t.status === 'Completed').length;
      const pct = pTasks.length ? Math.round((completed / pTasks.length) * 100) : 0;

      const flowHtml = flowStages
        .map((item, i) => {
          const state = stageState(item.tasks);
          const doneN = item.tasks.filter((t) => t.status === 'Completed').length;
          const node = `
            <div class="flow-node ${state}">
              <div class="flow-node-bubble">${doneN}/${item.tasks.length || 0}</div>
              <div class="flow-node-label">${escapeHtml(item.st)}</div>
              <div class="flow-node-meta">${state === 'done' ? 'Complete' : state === 'active' ? 'In motion' : item.tasks.length ? 'Waiting' : 'No tasks'}</div>
            </div>`;
          const arrow = i < flowStages.length - 1 ? '<div class="flow-arrow" aria-hidden="true"></div>' : '';
          return node + arrow;
        })
        .join('');

      const detailHtml = flowStages
        .filter((x) => x.tasks.length)
        .map(
          (item) => `
          <div class="pipeline-stage-panel">
            <h4>${escapeHtml(item.st)} <span class="badge badge-primary">${item.tasks.length}</span></h4>
            ${item.tasks
              .map(
                (tk) => `
              <div class="task-card" onclick="UI.openTaskDetailModal('${tk.id}')">
                <div class="task-title">${escapeHtml(tk.name)}</div>
                <div class="task-meta">
                  <span>${tk.isExternal ? 'Vendor' : 'Internal'}</span>
                  <span class="badge ${statusBadge(tk.status)}">${escapeHtml(tk.status)}</span>
                </div>
              </div>`
              )
              .join('')}
          </div>`
        )
        .join('');

      container.innerHTML = `
        <div class="pipeline-flow-wrap">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;gap:0.75rem;flex-wrap:wrap;">
            <strong style="font-size:0.85rem;">Stage flowchart</strong>
            <span style="font-size:0.78rem;color:var(--text-muted);">${completed} / ${pTasks.length} tasks complete · ${pct}%</span>
          </div>
          <div class="pipeline-progress-bar"><span style="width:${pct}%"></span></div>
          <div class="pipeline-flow">${flowHtml || '<p style="color:var(--text-muted);font-size:0.85rem;">No published tasks yet — confirm the AI plan first.</p>'}</div>
        </div>
        <div class="pipeline-stage-detail">${detailHtml || ''}</div>`;
    }

    function renderProjectKanban(pTasks, team) {
      const board = document.getElementById('projectKanbanBoard');
      if (!board) return;
      const columns = ['Draft', 'Assigned', 'Not Started', 'In Progress', 'Submitted', 'Completed'];
      const present = columns.filter((c) => pTasks.some((t) => t.status === c));
      const cols = present.length ? present : ['Assigned', 'In Progress', 'Submitted', 'Completed'];

      board.innerHTML = cols
        .map((status) => {
          const cards = pTasks.filter((t) => t.status === status);
          return `
            <div class="kanban-col" data-status="${escapeHtml(status)}">
              <div class="kanban-col-header">
                <span>${escapeHtml(status)}</span>
                <span class="badge badge-primary">${cards.length}</span>
              </div>
              ${
                cards.length
                  ? cards
                      .map(
                        (t) => `
                <div class="task-card" onclick="UI.openTaskDetailModal('${t.id}')">
                  <div class="task-title">${escapeHtml(t.name)}</div>
                  <div class="task-meta">
                    <span class="badge badge-primary">${escapeHtml(t.category || '')}</span>
                    <span>${escapeHtml(teamName(t.responsibleId, team))}</span>
                  </div>
                </div>`
                      )
                      .join('')
                  : '<div class="kanban-empty">No cards</div>'
              }
            </div>`;
        })
        .join('');
    }

    async function renderMyTasksView() {
      const curUser = XeragoAuth.getCurrentUser();
      const tasks = await XeragoDB.getAll('tasks');
      const projects = await XeragoDB.getAll('projects');
      const team = await XeragoDB.getAll('team');
      let myTasks = tasks.filter((t) => t.responsibleId === curUser.id);

      if (myTasksFilter === 'today') {
        const today = new Date().toISOString().slice(0, 10);
        myTasks = myTasks.filter((t) => t.startDate === today || t.status === 'In Progress');
      } else if (myTasksFilter === 'high') {
        myTasks = myTasks.filter((t) => t.priority === 'High' || t.priority === 'Critical');
      } else if (myTasksFilter === 'blocked') {
        myTasks = myTasks.filter((t) => t.status === 'Blocked');
      } else if (myTasksFilter === 'completed') {
        myTasks = myTasks.filter((t) => t.status === 'Completed');
      } else if (myTasksFilter === 'open') {
        myTasks = myTasks.filter((t) => t.status !== 'Completed');
      }

      const body = document.getElementById('myTasksTableBody');
      body.innerHTML = myTasks.length
        ? myTasks
            .map((t) => {
              const proj = projects.find((p) => p.id === t.projectId);
              const support = (t.supportIds || []).map((id) => teamName(id, team)).join(', ') || '—';
              const due = dueBadgeHtml(t.targetDate, t.status);
              return `
            <tr>
              <td><strong>${escapeHtml(t.name)}</strong><div style="font-size:0.75rem;color:var(--text-dim);">${escapeHtml(t.description || '')}</div>${due}</td>
              <td>${escapeHtml(proj ? proj.name : 'Project')}</td>
              <td><span class="badge badge-primary">${escapeHtml(t.category)}</span></td>
              <td>${escapeHtml(support)}</td>
              <td>${t.isExternal ? 'Vendor' : 'Internal'}</td>
              <td><span class="badge ${statusBadge(t.status)}">${escapeHtml(t.status)}</span></td>
              <td style="display:flex;gap:0.35rem;flex-wrap:wrap;">
                <button class="btn btn-secondary btn-sm" onclick="UI.openTaskDetailModal('${t.id}')">Open</button>
                ${!['Completed', 'Submitted', 'Draft'].includes(t.status) ? `<button class="btn btn-primary btn-sm" onclick="UI.openTaskDetailModal('${t.id}')">Submit + docs</button>` : ''}
                ${t.status === 'Submitted' ? `<span class="badge badge-warning">Awaiting manager</span>` : ''}
              </td>
            </tr>`;
            })
            .join('')
        : `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:2rem;">No tasks for this filter. When the manager assigns work, it appears here live.</td></tr>`;
    }

    async function renderRemainingWorkView() {
      const data = await api('/api/analytics/remaining');
      const container = document.getElementById('remainingWorkContainer');
      if (!container) return;

      container.innerHTML = `
        <div class="kpi-grid" style="margin-bottom:1.5rem;">
          <div class="kpi-card">
            <div class="kpi-title">Unfinished Tasks</div>
            <div class="kpi-value">${data.unfinishedCount}</div>
            <div class="kpi-subtext">Across all projects</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-title">Active Projects</div>
            <div class="kpi-value">${data.byProject.length}</div>
            <div class="kpi-subtext">Gap by designation below</div>
          </div>
        </div>

        <div class="card" style="margin-bottom:1.5rem;">
          <div class="card-header"><div class="card-title">Remaining by teammate / designation</div></div>
          <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap:1rem;">
            ${data.byMember
              .map(
                (row) => `
              <div style="background:var(--bg-input);border:1px solid var(--border-color);padding:1rem;border-radius:10px;">
                <strong>${escapeHtml(row.member.name)}</strong>
                <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:0.5rem;">${escapeHtml(row.member.role)}</div>
                <div style="font-size:0.85rem;">${row.remaining} remaining · ${row.completed} done · ${row.total} total</div>
              </div>`
              )
              .join('')}
          </div>
        </div>

        <div class="card" style="margin-bottom:1.5rem;">
          <div class="card-header"><div class="card-title">Remaining by project</div></div>
          ${data.byProject
            .map(
              (row) => `
            <div style="padding:1rem 0;border-bottom:1px solid var(--border-color-light);">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;">
                <div>
                  <strong style="cursor:pointer;" onclick="UI.openProjectDetail('${row.project.id}')">${escapeHtml(row.project.name)}</strong>
                  <div style="font-size:0.8rem;color:var(--text-muted);">${row.remaining} left of ${row.total} (${row.pct}% done)</div>
                </div>
                <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
                  ${row.byDesignation
                    .filter((d) => d.remaining > 0)
                    .map((d) => `<span class="badge badge-warning">${escapeHtml(d.name)}: ${d.remaining}</span>`)
                    .join('') || '<span class="badge badge-success">All done</span>'}
                </div>
              </div>
            </div>`
            )
            .join('') || '<p style="color:var(--text-muted);">No projects yet.</p>'}
        </div>

        <div class="card">
          <div class="card-header"><div class="card-title">Open task backlog</div></div>
          <div class="data-table-container">
            <table class="data-table">
              <thead><tr><th>Task</th><th>Project</th><th>Assignee</th><th>Status</th><th>Priority</th></tr></thead>
              <tbody>
                ${data.unfinished
                  .slice(0, 40)
                  .map((t) => {
                    const proj = data.byProject.find((p) => p.project.id === t.projectId)?.project;
                    const mem = data.byMember.find((m) => m.member.id === t.responsibleId)?.member;
                    return `<tr>
                      <td><strong>${escapeHtml(t.name)}</strong></td>
                      <td>${escapeHtml(proj?.name || '—')}</td>
                      <td>${escapeHtml(mem ? `${mem.name} (${mem.role})` : 'Unassigned')}</td>
                      <td><span class="badge ${statusBadge(t.status)}">${escapeHtml(t.status)}</span></td>
                      <td>${escapeHtml(t.priority || 'Medium')}</td>
                    </tr>`;
                  })
                  .join('') || '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);">Nothing left — all tasks completed.</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>`;
    }

    async function renderPMCommandView() {
      if (!XeragoAuth.isAdmin()) {
        document.getElementById('pmCommandView').innerHTML = `<div class="card" style="padding:2rem;text-align:center;">
          <h3>PM Command Center</h3>
          <p style="color:var(--text-muted);">Only the admin / manager can access this view.</p>
        </div>`;
        return;
      }
      const tasks = await XeragoDB.getAll('tasks');
      const projects = await XeragoDB.getAll('projects');
      const team = await XeragoDB.getAll('team');
      const blockers = await XeragoDB.getAll('blockers');
      const docs = await XeragoDB.getAll('documents');
      const submitted = tasks.filter((t) => t.status === 'Submitted');
      const pendingPlans = projects.filter((p) => p.status === 'Pending Approval');

      document.getElementById('pmKpiPendingApproval').textContent = submitted.length;
      const plansEl = document.getElementById('pmKpiPendingPlans');
      if (plansEl) plansEl.textContent = pendingPlans.length;
      document.getElementById('pmKpiCriticalBlockers').textContent = blockers.filter((b) => b.status !== 'Resolved').length;
      document.getElementById('pmKpiVendorAssignments').textContent = tasks.filter((t) => t.isExternal && t.status !== 'Draft').length;

      const queue = document.getElementById('pmVerificationQueue');
      if (queue) {
        queue.innerHTML = submitted.length
          ? submitted
              .map((t) => {
                const proj = projects.find((p) => p.id === t.projectId);
                const who = teamName(t.responsibleId, team);
                const tdocs = docs.filter((d) => d.taskId === t.id || (t.documentIds || []).includes(d.id));
                return `<div style="background:var(--bg-input);border:1px solid var(--border-color);padding:0.85rem;border-radius:8px;margin-bottom:0.5rem;">
                  <div style="display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;align-items:flex-start;">
                    <div>
                      <strong>${escapeHtml(t.name)}</strong>
                      <div style="font-size:0.78rem;color:var(--text-muted);">${escapeHtml(proj?.name || '')} · ${escapeHtml(who)} · ${tdocs.length} doc(s)</div>
                      <div style="font-size:0.78rem;margin-top:0.35rem;">${escapeHtml(t.notes || '')}</div>
                    </div>
                    <div style="display:flex;gap:0.4rem;flex-wrap:wrap;">
                      <button class="btn btn-secondary btn-sm" onclick="UI.openTaskDetailModal('${t.id}')">Review docs</button>
                      <button class="btn btn-primary btn-sm" onclick="UI.verifyTask('${t.id}')">Verify complete</button>
                      <button class="btn btn-secondary btn-sm" onclick="UI.rejectTask('${t.id}')">Rework</button>
                    </div>
                  </div>
                </div>`;
              })
              .join('')
          : '<p style="color:var(--text-muted);">No submissions waiting. Live updates appear here when teammates submit.</p>';
      }

      const plansList = document.getElementById('pmPendingPlansList');
      if (plansList) {
        plansList.innerHTML = pendingPlans.length
          ? pendingPlans
              .map((p) => {
                const proposed = (p.proposedPlan?.tasks || []).length;
                const roles = (p.proposedPlan?.analysis?.neededRoles || []).map((r) => r.role).join(', ');
                return `<div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;padding:0.6rem 0;border-bottom:1px solid var(--border-color-light);">
                  <div><strong>${escapeHtml(p.name)}</strong><div style="font-size:0.78rem;color:var(--text-muted);">${proposed} proposed · ${escapeHtml(roles || 'analyzing…')} · not created yet</div></div>
                  <button class="btn btn-primary btn-sm" onclick="UI.reviewProjectPlan('${p.id}')">Review &amp; confirm</button>
                </div>`;
              })
              .join('')
          : '<p style="color:var(--text-muted);">No AI plans waiting for confirmation.</p>';
      }

      const list = document.getElementById('pmBlockerResolutionList');
      const me = XeragoAuth.getCurrentUser();
      if (list) {
        list.innerHTML = blockers.length
          ? blockers
              .map((b) => {
                const isOwner = me && (b.ownerId || b.reportedBy) === me.id;
                const resolved = b.status === 'Resolved';
                let btn = '';
                if (!resolved && isOwner) {
                  btn = `<button class="btn btn-primary btn-sm" onclick="UI.resolveBlocker('${b.id}')">Resolve</button>`;
                } else if (!resolved) {
                  btn = `<span style="font-size:0.72rem;color:var(--text-dim);">Owner: ${escapeHtml(blockerOwnerLabel(b, team))}</span>`;
                } else {
                  btn = `<button class="btn btn-secondary btn-sm" onclick="UI.viewBlockerResolution('${b.id}')">View</button>`;
                }
                return `
          <div style="background:var(--bg-input); border:1px solid var(--border-color); padding:0.85rem; border-radius:8px; margin-bottom:0.5rem; display:flex; justify-content:space-between; align-items:center; gap:0.75rem;">
            <div>
              <strong style="color:var(--accent-rose); font-size:0.9rem;">${escapeHtml(b.description)}</strong>
              <div style="font-size:0.75rem; color:var(--text-muted);">Priority: ${escapeHtml(b.priority)} · ${escapeHtml(b.status)} · Assigned: ${escapeHtml(blockerOwnerLabel(b, team))}</div>
            </div>
            ${btn}
          </div>`;
              })
              .join('')
          : '<p style="color:var(--text-muted);">No blockers reported.</p>';
      }
    }

    async function reviewProjectPlan(projectId) {
      const project = await XeragoDB.get('projects', projectId);
      const tasks = project?.proposedPlan?.tasks || [];
      if (!project || !tasks.length) return alert('No AI proposal found. Create or regenerate a plan first.');
      openPlanReview(project, tasks, project.planEngine || 'analyzer', project.planModel, project.proposedPlan.analysis);
    }

    async function renderVendorsView() {
      const vendors = await XeragoDB.getAll('vendors');
      const grid = document.getElementById('vendorsGrid');
      const isAdmin = XeragoAuth.isAdmin();
      grid.innerHTML = vendors
        .map((v) => {
          const active = v.status === 'Active';
          const adminActions = isAdmin
            ? `<button type="button" class="btn btn-secondary btn-sm" onclick="UI.openVendorModal('${v.id}')">Edit</button>
               <button type="button" class="btn btn-secondary btn-sm" style="color:var(--accent-rose);" onclick="UI.deleteVendor('${v.id}')">Delete</button>`
            : '';
          return `
          <div class="card" style="${active ? '' : 'opacity:0.7;'}">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:0.5rem;">
              <span class="badge badge-cyan">${escapeHtml(v.category)}</span>
              <span class="badge ${active ? 'badge-success' : 'badge-danger'}">${escapeHtml(v.status || 'Active')}</span>
            </div>
            <h3 style="font-size:1.1rem;">${escapeHtml(v.name)}</h3>
            <div style="font-size:0.8rem; color:var(--text-muted); margin-bottom:0.75rem;">${escapeHtml(v.company || 'Independent')} · ${escapeHtml(v.role || '')}</div>
            <div style="font-size:0.78rem; margin-bottom:0.75rem; display:flex; flex-wrap:wrap; gap:0.25rem;">
              ${(v.services || []).map((s) => `<span class="badge badge-primary">${escapeHtml(s)}</span>`).join('')}
            </div>
            <div style="font-size:0.8rem; color:var(--text-muted); margin-bottom:1rem;">
              Rating: ${v.rating || 4}/5 · Lead: ${escapeHtml(v.leadTime || 'Standard')}
            </div>
            <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
              <a href="tel:${escapeHtml(v.mobile || '')}" class="btn btn-secondary btn-sm">Call</a>
              <a href="mailto:${escapeHtml(v.email || '')}" class="btn btn-secondary btn-sm">Email</a>
              ${adminActions}
            </div>
          </div>`;
        })
        .join('') || '<p style="color:var(--text-muted);">No vendors yet.</p>';
    }

    function openVendorModal(vendorId) {
      if (!XeragoAuth.isAdmin()) return alert('Only admin / manager can edit vendors.');
      const form = document.getElementById('addVendorForm');
      form?.reset();
      document.getElementById('vendorId').value = vendorId || '';
      document.getElementById('vendorModalTitle').textContent = vendorId
        ? 'Edit External Contact / Vendor'
        : '+ Add New External Contact / Vendor';
      document.querySelectorAll('#vendorServicesCheckboxes input').forEach((cb) => {
        cb.checked = false;
      });
      if (vendorId) {
        const v = (cache.vendors || []).find((x) => x.id === vendorId);
        if (!v) return alert('Vendor not found');
        document.getElementById('vendorName').value = v.name || '';
        document.getElementById('vendorCompany').value = v.company || '';
        document.getElementById('vendorRole').value = v.role || '';
        document.getElementById('vendorCategory').value = v.category || 'Other';
        document.getElementById('vendorMobile').value = v.mobile || '';
        document.getElementById('vendorWhatsapp').value = v.whatsapp || '';
        document.getElementById('vendorEmail').value = v.email || '';
        document.getElementById('vendorWebsite').value = v.website || '';
        document.getElementById('vendorRating').value = String(v.rating || 4);
        document.getElementById('vendorStatus').value = v.status === 'Inactive' ? 'Inactive' : 'Active';
        document.getElementById('vendorNotes').value = v.notes || '';
        (v.services || []).forEach((s) => {
          const cb = document.querySelector(`#vendorServicesCheckboxes input[value="${s}"]`);
          if (cb) cb.checked = true;
        });
      }
      openModal('addVendorModal');
    }

    async function deleteVendor(vendorId) {
      if (!XeragoAuth.isAdmin()) return alert('Only admin / manager can delete vendors.');
      const v = (cache.vendors || []).find((x) => x.id === vendorId);
      if (!v) return;
      if (!confirm(`Delete vendor "${v.name}"? This cannot be undone.`)) return;
      try {
        await api(`/api/vendors/${vendorId}`, { method: 'DELETE' });
        await XeragoDB.refreshAll();
        showToast('Vendor deleted');
        renderVendorsView();
      } catch (err) {
        alert(err.message);
      }
    }

    async function renderRaciMatrixView() {
      const projects = await XeragoDB.getAll('projects');
      const tasks = await XeragoDB.getAll('tasks');
      const team = await XeragoDB.getAll('team');
      const container = document.getElementById('globalRaciMatrixContainer');
      if (!container) return;
      if (!projects.length) {
        container.innerHTML = '<p style="color:var(--text-muted);">Create a project to see RACI.</p>';
        return;
      }

      container.innerHTML = projects
        .map((proj) => {
          const pTasks = tasks.filter((t) => t.projectId === proj.id && t.status !== 'Draft');
          return `
          <div class="card" style="margin-bottom:1.25rem;">
            <h3 style="margin:0 0 0.75rem;font-size:1rem;">${escapeHtml(proj.name)} <span class="badge badge-primary">${escapeHtml(proj.status)}</span></h3>
            ${
              pTasks.length
                ? `<div class="data-table-container">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Engineering Task / Phase</th>
                    ${team.map((m) => `<th>${escapeHtml(m.name)} (${escapeHtml(m.role)})</th>`).join('')}
                    <th>External Vendor</th>
                  </tr>
                </thead>
                <tbody>
                  ${pTasks
                    .map(
                      (t) => `
                    <tr>
                      <td><strong>${escapeHtml(t.name)}</strong><br><small style="color:var(--text-dim);">${escapeHtml(t.category)}</small></td>
                      ${team
                        .map((m) => {
                          let code = '—';
                          if (t.responsibleId === m.id) code = '<span class="badge badge-primary">RESPONSIBLE (R)</span>';
                          else if (t.supportIds && t.supportIds.includes(m.id)) code = '<span class="badge badge-cyan">SUPPORT (S)</span>';
                          return `<td>${code}</td>`;
                        })
                        .join('')}
                      <td>${t.isExternal ? '<span class="badge badge-warning">EXTERNAL PARTNER</span>' : '—'}</td>
                    </tr>`
                    )
                    .join('')}
                </tbody>
              </table>
            </div>`
                : '<p style="color:var(--text-muted);font-size:0.85rem;">No published tasks yet.</p>'
            }
          </div>`;
        })
        .join('');
    }

    async function renderBlockersHubView() {
      const blockers = await XeragoDB.getAll('blockers');
      const projects = await XeragoDB.getAll('projects');
      const team = await XeragoDB.getAll('team');
      const me = XeragoAuth.getCurrentUser();
      const body = document.getElementById('globalBlockersTableBody');
      body.innerHTML = blockers
        .map((b) => {
          const proj = projects.find((p) => p.id === b.projectId);
          const isOwner = me && (b.ownerId || b.reportedBy) === me.id;
          const resolved = b.status === 'Resolved';
          let action = '—';
          if (!resolved) {
            action = isOwner
              ? `<button class="btn btn-primary btn-sm" onclick="UI.resolveBlocker('${b.id}')">Resolve</button>`
              : `<span style="font-size:0.75rem;color:var(--text-dim);">Waiting on ${escapeHtml(blockerOwnerLabel(b, team))}</span>`;
          } else {
            action = `<button class="btn btn-secondary btn-sm" onclick="UI.viewBlockerResolution('${b.id}')">View resolution</button>`;
          }
          return `
            <tr>
              <td>
                <strong style="color:var(--accent-rose);">${escapeHtml(b.description)}</strong>
                ${
                  resolved && b.resolutionNotes
                    ? `<div style="font-size:0.72rem;color:var(--text-dim);margin-top:0.25rem;">Resolved: ${escapeHtml(b.resolutionNotes).slice(0, 80)}${b.resolutionNotes.length > 80 ? '…' : ''}</div>`
                    : ''
                }
              </td>
              <td>${escapeHtml(proj ? proj.name : '—')}</td>
              <td><strong>${escapeHtml(blockerOwnerLabel(b, team))}</strong></td>
              <td>${escapeHtml(blockerReporterLabel(b, team))}</td>
              <td><span class="badge badge-danger">${escapeHtml(b.priority)}</span></td>
              <td><span class="badge ${resolved ? 'badge-success' : 'badge-warning'}">${escapeHtml(b.status)}</span></td>
              <td>${action}</td>
            </tr>`;
        })
        .join('') || '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);">No blockers.</td></tr>';
    }

    function shareLabel(d) {
      const s = d.sharedWith || 'project';
      if (s === 'team') return 'Entire team';
      if (s === 'users') return `Shared · ${(d.sharedWithIds || []).length} person(s)`;
      if (s === 'private') return 'Private (admin)';
      return 'Project team';
    }

    async function renderDocumentVaultView() {
      const container = document.getElementById('vaultByProjectContainer');
      const mailEl = document.getElementById('vaultMailStatus');
      if (!container) return;

      let byProject = [];
      try {
        const vault = await api('/api/cloud-vault');
        byProject = vault.byProject || [];
        if (mailEl) {
          const m = vault.mail || {};
          mailEl.textContent = m.configured
            ? `Email: SMTP ready (${m.host}) — assignments & shares send mail`
            : 'Email: console mode — set SMTP_HOST / SMTP_USER / SMTP_PASS on the server for real inbox alerts';
        }
      } catch {
        byProject = [];
      }

      if (!byProject.length) {
        container.innerHTML =
          '<p style="color:var(--text-muted);">Vault is empty. Upload here, or attach files when submitting task progress — they show under that project.</p>';
        return;
      }

      const isAdmin = XeragoAuth.isAdmin();
      const team = await XeragoDB.getAll('team');
      container.innerHTML = byProject
        .map((group) => {
          const families = group.families || (group.documents || []).map((d) => ({ latest: d, versions: [d] }));
          const rows = families
            .map((fam) => {
              const d = fam.latest;
              const versions = fam.versions || [d];
              const fromProgress = d.category === 'Task Deliverable' || d.taskId;
              const verOpts = versions
                .map(
                  (v) =>
                    `<option value="${v.id}">${escapeHtml(v.revision || 'Rev A')} · ${escapeHtml(v.dateAdded || '')} · ${escapeHtml(v.uploadedByName || '')}</option>`
                )
                .join('');
              const peopleChecks = team
                .filter((t) => t.status === 'Active' && t.accessLevel !== 'admin')
                .map(
                  (t) =>
                    `<label><input type="checkbox" class="share-person-cb" data-doc="${d.id}" value="${t.id}"> ${escapeHtml(t.name)}</label>`
                )
                .join('');
              return `<tr>
              <td>
                <strong>${escapeHtml(d.name || d.fileName)}</strong>
                <span class="rev-badge">${escapeHtml(d.revision || 'Rev A')}</span>
                <div style="font-size:0.72rem;color:var(--text-dim);">
                  ${escapeHtml(d.uploadedByName || '')}${fromProgress ? ' · from task progress' : ''} · ${escapeHtml(shareLabel(d))}
                </div>
                ${
                  versions.length > 1
                    ? `<div style="margin-top:0.4rem;"><label style="font-size:0.7rem;color:var(--text-dim);">Version history</label>
                       <select class="form-control" style="font-size:0.75rem;padding:0.25rem 0.4rem;" onchange="UI.downloadDocument(this.value)">
                         ${verOpts}
                       </select></div>`
                    : ''
                }
              </td>
              <td><span class="badge badge-primary">${escapeHtml(d.category || 'Artifact')}</span></td>
              <td>${escapeHtml(d.fileSize || '—')}</td>
              <td>${escapeHtml(d.dateAdded || '')}</td>
              <td>
                <div class="vault-actions">
                  <button type="button" class="btn btn-primary btn-sm" onclick="UI.downloadDocument('${d.id}')">Download</button>
                  ${
                    isAdmin
                      ? `<div class="share-menu" id="shareMenu_${d.id}">
                          <button type="button" class="btn btn-secondary btn-sm" onclick="UI.toggleShareMenu('${d.id}', event)">Share ▾</button>
                          <div class="share-menu-panel" id="sharePanel_${d.id}">
                            <button type="button" class="share-menu-item" onclick="event.stopPropagation();UI.quickShareDocument('${d.id}','team')">Entire team</button>
                            <button type="button" class="share-menu-item" onclick="event.stopPropagation();UI.quickShareDocument('${d.id}','project')">This project team</button>
                            <button type="button" class="share-menu-item has-sub" id="shareSubBtn_${d.id}" onclick="UI.toggleShareSubmenu(this, event)">Specific person(s) ▾</button>
                            <div class="share-submenu" id="shareSub_${d.id}" data-doc="${d.id}">${peopleChecks}
                              <button type="button" class="btn btn-primary btn-sm" style="margin-top:0.4rem;width:100%;" onclick="event.stopPropagation();UI.shareSelectedPeople('${d.id}')">Share selected</button>
                            </div>
                            <button type="button" class="share-menu-item" onclick="event.stopPropagation();UI.quickShareDocument('${d.id}','private')">Admin only</button>
                          </div>
                        </div>
                        <button type="button" class="btn btn-secondary btn-sm" style="color:var(--accent-rose);" onclick="UI.deleteVaultDocument('${d.id}')">Delete</button>`
                      : ''
                  }
                </div>
              </td>
            </tr>`;
            })
            .join('');
          return `
          <div class="card" style="margin-bottom:1.25rem;">
            <h3 style="margin:0 0 0.75rem;font-size:1rem;">${escapeHtml(group.projectName)}
              <span class="badge badge-cyan">${families.length} doc(s)</span>
            </h3>
            <div class="data-table-container">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Document / Rev history</th>
                    <th>Category</th>
                    <th>Size</th>
                    <th>Date</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          </div>`;
        })
        .join('');
    }

    function toggleShareMenu(docId, ev) {
      if (ev) {
        ev.preventDefault();
        ev.stopPropagation();
      }
      const menu = document.getElementById(`shareMenu_${docId}`);
      const panel = document.getElementById(`sharePanel_${docId}`);
      const btn = ev?.currentTarget || menu?.querySelector('button');
      if (!menu || !panel) return;

      const wasOpen = menu.classList.contains('open');
      document.querySelectorAll('.share-menu.open').forEach((el) => el.classList.remove('open'));
      document.querySelectorAll('.share-submenu.open').forEach((el) => el.classList.remove('open'));
      document.querySelectorAll('.share-menu-item.has-sub.open').forEach((el) => el.classList.remove('open'));
      if (wasOpen) return;

      menu.classList.add('open');
      // Position dropdown under the Share button (fixed, so table overflow won't clip it)
      const rect = (btn || menu).getBoundingClientRect();
      const width = 250;
      let left = rect.right - width;
      if (left < 8) left = 8;
      if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
      let top = rect.bottom + 6;
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.right = 'auto';
      // Flip up if near bottom of viewport
      requestAnimationFrame(() => {
        const ph = panel.offsetHeight || 200;
        if (top + ph > window.innerHeight - 8) {
          panel.style.top = `${Math.max(8, rect.top - ph - 6)}px`;
        }
      });
    }

    function toggleShareSubmenu(btn, ev) {
      if (ev) {
        ev.preventDefault();
        ev.stopPropagation();
      }
      const sub = btn?.nextElementSibling;
      btn?.classList.toggle('open');
      sub?.classList.toggle('open');
    }

    async function deleteVaultDocument(docId) {
      if (!XeragoAuth.isAdmin()) return alert('Admin only');
      const docs = await XeragoDB.getAll('documents');
      const doc = docs.find((d) => d.id === docId);
      const label = doc ? `${doc.name || doc.fileName} (${doc.revision || 'Rev A'})` : docId;
      if (!confirm(`Delete "${label}" from Cloud Document Vault?\nThis removes the file from the server.`)) return;
      try {
        await api(`/api/documents/${docId}`, { method: 'DELETE' });
        showToast('Document deleted');
        await XeragoDB.refreshAll();
        renderDocumentVaultView();
      } catch (err) {
        alert(err.message);
      }
    }

    async function quickShareDocument(docId, sharedWith) {
      if (!XeragoAuth.isAdmin()) return;
      try {
        await api(`/api/documents/${docId}/share`, {
          method: 'POST',
          body: JSON.stringify({ sharedWith, sharedWithIds: [] })
        });
        showToast(`Shared → ${sharedWith}`);
        document.querySelectorAll('.share-menu.open').forEach((el) => el.classList.remove('open'));
        await XeragoDB.refreshAll();
        renderDocumentVaultView();
      } catch (err) {
        alert(err.message);
      }
    }

    async function shareSelectedPeople(docId) {
      const ids = Array.from(
        document.querySelectorAll(`.share-submenu[data-doc="${docId}"] .share-person-cb:checked`)
      ).map((cb) => cb.value);
      if (!ids.length) return alert('Select at least one person');
      try {
        await api(`/api/documents/${docId}/share`, {
          method: 'POST',
          body: JSON.stringify({ sharedWith: 'users', sharedWithIds: ids })
        });
        showToast(`Shared with ${ids.length} person(s)`);
        document.querySelectorAll('.share-menu.open').forEach((el) => el.classList.remove('open'));
        await XeragoDB.refreshAll();
        renderDocumentVaultView();
      } catch (err) {
        alert(err.message);
      }
    }

    async function openShareModal(docId) {
      if (!XeragoAuth.isAdmin()) return alert('Admin only');
      const docs = await XeragoDB.getAll('documents');
      const doc = docs.find((d) => d.id === docId);
      document.getElementById('shareDocId').value = docId;
      document.getElementById('shareDocLabel').textContent = doc
        ? `${doc.name || doc.fileName} (${doc.revision || 'Rev A'})`
        : docId;
      const team = await XeragoDB.getAll('team');
      document.getElementById('sharePeopleChecks').innerHTML = team
        .filter((t) => t.status === 'Active')
        .map(
          (t) =>
            `<label style="display:flex;gap:0.4rem;align-items:center;font-size:0.8rem;padding:0.25rem 0;"><input type="checkbox" class="share-modal-person" value="${t.id}"> ${escapeHtml(t.name)} (${escapeHtml(t.role)})</label>`
        )
        .join('');
      document.getElementById('shareAudienceSelect').value = 'team';
      document.getElementById('sharePeopleWrap').style.display = 'none';
      openModal('shareDocumentModal');
    }

    async function shareVaultDocument(docId) {
      return openShareModal(docId);
    }

    async function renderProjectHistoryView() {
      const archived = await XeragoDB.getArchivedProjects();
      const completed = (await XeragoDB.getAll('projects')).filter(
        (p) => !p.archived && (p.status === 'Completed' || p.progressPct === 100)
      );
      const container = document.getElementById('projectHistoryContainer');
      const isAdmin = XeragoAuth.isAdmin();
      const card = (p, mode) => `
          <div class="card" style="margin-bottom:1rem;">
            <div style="display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;align-items:flex-start;">
              <div style="cursor:pointer;flex:1;" onclick="UI.openProjectDetail('${p.id}')">
                <h3>${escapeHtml(p.name)} <span class="badge ${mode === 'archived' ? 'badge-warning' : 'badge-success'}">${mode === 'archived' ? 'Archived' : escapeHtml(p.status)}</span></h3>
                <p style="color:var(--text-muted); font-size:0.85rem; margin-bottom:0.5rem;">${escapeHtml(p.description)}</p>
                <div style="font-size:0.75rem; color:var(--text-dim);">Target: ${escapeHtml(p.targetDate || 'TBD')}${p.archivedAt ? ` · Archived ${escapeHtml(String(p.archivedAt).slice(0, 10))}` : ''}</div>
              </div>
              ${
                isAdmin && mode === 'archived'
                  ? `<div style="display:flex;gap:0.35rem;flex-wrap:wrap;">
                      <button class="btn btn-primary btn-sm" onclick="UI.restoreProject('${p.id}')">Restore</button>
                      <button class="btn btn-secondary btn-sm" style="color:var(--accent-rose);" onclick="UI.deleteProject('${p.id}')">Delete forever</button>
                    </div>`
                  : ''
              }
            </div>
          </div>`;
      container.innerHTML =
        `<h4 style="margin:0 0 0.75rem;">Archived (soft-deleted)</h4>` +
        (archived.map((p) => card(p, 'archived')).join('') ||
          '<p style="color:var(--text-muted);margin-bottom:1.25rem;">No archived projects.</p>') +
        `<h4 style="margin:1.25rem 0 0.75rem;">Completed</h4>` +
        (completed.map((p) => card(p, 'done')).join('') ||
          '<p style="color:var(--text-muted);">No completed projects yet.</p>');
    }

    async function archiveProject(projectId) {
      if (!XeragoAuth.isAdmin()) return alert('Admin only');
      const proj = await XeragoDB.get('projects', projectId);
      if (!proj) return;
      if (!confirm(`Archive "${proj.name}"?\nIt will move to History. Tasks & vault files are kept. You can restore later.`)) return;
      try {
        await api(`/api/projects/${projectId}/archive`, { method: 'POST', body: '{}' });
        await XeragoDB.refreshAll();
        currentDetailProjectId = null;
        showToast('Project archived');
        switchView('projectHistoryView');
      } catch (err) {
        alert(err.message);
      }
    }

    async function restoreProject(projectId) {
      if (!XeragoAuth.isAdmin()) return alert('Admin only');
      try {
        await api(`/api/projects/${projectId}/restore`, { method: 'POST', body: '{}' });
        await XeragoDB.refreshAll();
        showToast('Project restored');
        switchView('projectsView');
      } catch (err) {
        alert(err.message);
      }
    }

    async function loadDueReminders() {
      const banner = document.getElementById('dueRemindersBanner');
      try {
        const data = await api('/api/reminders/due?days=3');
        const overdue = data.overdue || [];
        const dueSoon = data.dueSoon || [];
        const proj = data.projectReminders || [];
        if (!overdue.length && !dueSoon.length && !proj.length) {
          if (banner) banner.classList.remove('show', 'overdue');
          return;
        }
        const parts = [];
        if (overdue.length) {
          parts.push(
            `<strong>${overdue.length} overdue</strong>: ${overdue
              .slice(0, 3)
              .map((t) => escapeHtml(t.taskName))
              .join(', ')}${overdue.length > 3 ? '…' : ''}`
          );
        }
        if (dueSoon.length) {
          parts.push(
            `<strong>${dueSoon.length} due in 3 days</strong>: ${dueSoon
              .slice(0, 3)
              .map((t) => escapeHtml(t.taskName))
              .join(', ')}${dueSoon.length > 3 ? '…' : ''}`
          );
        }
        if (proj.length && XeragoAuth.isAdmin()) {
          parts.push(
            `<strong>${proj.length} project target(s)</strong> need attention`
          );
        }
        if (banner) {
          banner.innerHTML = parts.join(' · ') + ` <button class="btn btn-secondary btn-sm" style="margin-left:0.5rem;" onclick="UI.switchView('myTasksView')">Open My Tasks</button>`;
          banner.classList.add('show');
          banner.classList.toggle('overdue', overdue.length > 0);
        }
        if (overdue.length) {
          showToast(`Due dates: ${overdue.length} overdue task(s)`);
        }
      } catch {
        /* ignore */
      }
    }

    async function renderAdminSettingsView() {
      applyRoleGates();
      const team = await XeragoDB.getAll('team');
      const activeCount = team.filter((m) => m.status === 'Active').length;
      const inactiveCount = team.filter((m) => m.status !== 'Active').length;
      const summary = document.getElementById('adminTeamStatusSummary');
      if (summary) {
        summary.innerHTML = `<span class="badge badge-success">Active: ${activeCount}</span> &nbsp; <span class="badge badge-danger">Inactive: ${inactiveCount}</span>`;
      }

      const body = document.getElementById('adminTeamTableBody');
      const isAdmin = XeragoAuth.isAdmin();
      if (body) {
        body.innerHTML = team
          .map((m) => {
            const isActive = m.status === 'Active';
            const statusBadge = isActive
              ? `<span class="badge badge-success">Active</span>`
              : `<span class="badge badge-danger">Inactive</span>`;
            const actions = isAdmin
              ? `<div style="display:flex;gap:0.35rem;flex-wrap:wrap;">
                  <button type="button" class="btn btn-secondary btn-sm" onclick="UI.openTeamMemberModal('${m.id}')">Edit</button>
                  ${
                    isActive
                      ? `<button type="button" class="btn btn-secondary btn-sm" style="color:var(--accent-rose);" onclick="UI.setTeamStatus('${m.id}','Inactive')">Set Inactive</button>`
                      : `<button type="button" class="btn btn-primary btn-sm" onclick="UI.setTeamStatus('${m.id}','Active')">Set Active</button>`
                  }
                </div>`
              : `<span style="font-size:0.75rem;color:var(--text-dim);">View only</span>`;
            return `
          <tr style="${isActive ? '' : 'opacity:0.72;'}">
            <td><strong>${escapeHtml(m.name)}</strong><div style="font-size:0.75rem;color:var(--text-dim);">@${escapeHtml(m.username || '')}</div></td>
            <td>${escapeHtml(m.role)} <span class="badge ${m.accessLevel === 'admin' ? 'badge-danger' : 'badge-cyan'}">${escapeHtml(m.accessLevel || 'member')}</span></td>
            <td>${escapeHtml((m.skills || []).join(', '))}</td>
            <td>${escapeHtml(m.responsibilities || '')}</td>
            <td>${statusBadge}</td>
            <td>${actions}</td>
          </tr>`;
          })
          .join('');
      }

      const hint = document.getElementById('adminTeamEditHint');
      if (hint) {
        hint.textContent = isAdmin
          ? 'You can Edit any row, change designation, and set Active / Inactive.'
          : 'View only — ask admin to change your designation or Active/Inactive status.';
      }

      renderWorkflowTemplatesPanel(team, isAdmin);
      renderMaintenancePanel();
    }

    async function renderMaintenancePanel() {
      const live = document.getElementById('adminMaintenanceLive');
      const roadmap = document.getElementById('adminMaintenanceRoadmap');
      const activityEl = document.getElementById('adminMaintenanceActivity');
      if (!live || !roadmap) return;

      const [projects, tasks, blockers, docs, team, activity] = await Promise.all([
        XeragoDB.getAll('projects'),
        XeragoDB.getAll('tasks'),
        XeragoDB.getAll('blockers'),
        XeragoDB.getAll('documents'),
        XeragoDB.getAll('team'),
        XeragoDB.getAll('activity_log')
      ]);

      const openBlockers = blockers.filter((b) => b.status !== 'Resolved').length;
      const submitted = tasks.filter((t) => t.status === 'Submitted').length;
      const cloudDocs = docs.filter((d) => d.cloudStored || d.storagePath).length;
      const activeTeam = team.filter((t) => t.status === 'Active').length;

      live.innerHTML = `
        <div class="maint-card"><h4>Projects</h4><p>${projects.length} total · ${projects.filter((p) => p.status === 'Pending Approval').length} awaiting plan confirm</p><span class="maint-status maint-live">Live</span></div>
        <div class="maint-card"><h4>Tasks</h4><p>${tasks.filter((t) => t.status !== 'Draft').length} assigned · ${submitted} waiting manager verify</p><span class="maint-status maint-live">Live</span></div>
        <div class="maint-card"><h4>Cloud vault</h4><p>${cloudDocs} file(s) in data/cloud-vault · open blockers ${openBlockers}</p><span class="maint-status maint-live">Live</span></div>
        <div class="maint-card"><h4>Team</h4><p>${activeTeam} Active · ${team.length - activeTeam} Inactive</p><span class="maint-status maint-live">Live</span></div>`;

      const items = [
        { title: 'Single source of truth', body: 'RACI, Blockers, Vault live only under Engineering Network — project canvas keeps Pipeline + Kanban.', status: 'Live', cls: 'maint-live' },
        { title: 'Flowchart pipeline + Kanban', body: 'Stage chart with progress % and status columns for task flow.', status: 'Live', cls: 'maint-live' },
        { title: 'Directed live alerts', body: 'Manager → all teammates; teammate activity → admin only.', status: 'Live', cls: 'maint-live' },
        { title: 'JSON backup / reset', body: 'Export snapshot from Team Database tab (not the same as vault files).', status: 'Live', cls: 'maint-live' },
        { title: 'Project archive & soft-delete', body: 'Archive keeps vault/tasks; History restore; permanent delete optional.', status: 'Live', cls: 'maint-live' },
        { title: 'Due dates & SLA reminders', body: 'Dashboard banner + My Tasks overdue/due-soon badges (3-day window).', status: 'Live', cls: 'maint-live' },
        { title: 'Document versions', body: 'Rev A/B/C auto-bump on same title; version history dropdown in vault.', status: 'Live', cls: 'maint-live' },
        { title: 'Scheduled DB + vault backup', body: 'Nightly copy of xerago-db.json and cloud-vault to a backup folder.', status: 'Later', cls: 'maint-later' },
        { title: 'IoT field maintenance tickets', body: 'Link post-deploy sensor/gateway maintenance checklists to a shipped project.', status: 'Later', cls: 'maint-later' },
        { title: 'ECO / change-request workflow', body: 'Controlled design changes after Approval with re-verify steps.', status: 'Later', cls: 'maint-later' }
      ];

      roadmap.innerHTML = items
        .map(
          (it) => `
        <div class="maint-card">
          <h4>${escapeHtml(it.title)}</h4>
          <p>${escapeHtml(it.body)}</p>
          <span class="maint-status ${it.cls}">${escapeHtml(it.status)}</span>
        </div>`
        )
        .join('');

      if (activityEl) {
        const rows = (activity || []).slice().reverse().slice(0, 25);
        activityEl.innerHTML = rows.length
          ? rows
              .map(
                (a) =>
                  `<div style="padding:0.4rem 0;border-bottom:1px solid var(--border-color);"><strong>${escapeHtml(a.by || 'System')}</strong> · ${escapeHtml(a.message || a.action || '')}<span style="float:right;color:var(--text-dim);">${escapeHtml(a.at || a.date || '')}</span></div>`
              )
              .join('')
          : '<p style="color:var(--text-muted);">No activity yet.</p>';
      }
    }

    function renderWorkflowTemplatesPanel(team, isAdmin) {
      const tpl = document.getElementById('adminWorkflowTemplatesList');
      if (!tpl) return;

      const byRole = (re) => team.find((m) => re.test((m.role || '').toLowerCase()) && m.status === 'Active');
      const pm = byRole(/manager|pm/) || team.find((t) => t.accessLevel === 'admin');
      const pcb = byRole(/pcb/);
      const mech = byRole(/3d|mechanical/);
      const ops = byRole(/operator|electronic/);

      const stages = [
        { phase: '1. Requirements & scope', owner: pm, when: 'Every project', maps: 'Core Command → Projects (create)' },
        { phase: '2. Architecture / electronics', owner: pcb, when: 'If PCB / embedded / electronics detected', maps: 'AI plan → PCB Designer tasks' },
        { phase: '3. Schematic & PCB layout', owner: pcb, when: 'PCB / board / Gerber scope', maps: 'Projects detail → PCB stage' },
        { phase: '4. Mechanical / 3D', owner: mech, when: 'If enclosure / 3D / fixture detected', maps: 'Skips person if not needed' },
        { phase: '5. Firmware', owner: pcb, when: 'If firmware / MCU / IoT detected', maps: 'Same designation as PCB unless separate role' },
        { phase: '6. Procurement & assembly', owner: ops, when: 'If build / prototype / assembly detected', maps: 'My Tasks → Operator' },
        { phase: '7. Testing & validation', owner: ops, when: 'Hardware bring-up projects', maps: 'Submit docs → PM verify' },
        { phase: '8. Manager sign-off', owner: pm, when: 'After teammate submission', maps: 'PM Command Center (admin)' }
      ];

      tpl.innerHTML = `
        <div class="card" style="margin-bottom:1rem;">
          <h4 style="margin-bottom:0.5rem;">End-to-end process (organized)</h4>
          <ol style="margin-left:1.1rem;font-size:0.85rem;color:var(--text-muted);line-height:1.7;">
            <li><strong>Admin</strong> creates project in Core Command → Projects</li>
            <li><strong>AI</strong> uses templates below → proposes only needed Active people</li>
            <li><strong>Admin</strong> confirms plan (tasks created only then)</li>
            <li><strong>Members</strong> work in My Tasks → upload docs → submit</li>
            <li><strong>Admin</strong> verifies in PM Command → complete</li>
          </ol>
          <p style="font-size:0.78rem;color:var(--text-dim);margin-top:0.5rem;">
            Vendors / RACI / Blockers / Cloud Vault stay under <strong>Engineering Network</strong> — not duplicated here.
          </p>
        </div>
        <div class="data-table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>Workflow stage template</th>
                <th>Default designation</th>
                <th>When AI includes it</th>
                <th>Where it shows in app</th>
              </tr>
            </thead>
            <tbody>
              ${stages
                .map((s) => {
                  const owner = s.owner;
                  const status = owner
                    ? `<strong>${escapeHtml(owner.name)}</strong><div style="font-size:0.72rem;color:var(--text-dim);">${escapeHtml(owner.role)} · ${owner.status === 'Active' ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-danger">Inactive</span>'}</div>`
                    : `<span class="badge badge-warning">No Active person for this role</span>`;
                  return `<tr>
                    <td><strong>${escapeHtml(s.phase)}</strong></td>
                    <td>${status}</td>
                    <td style="font-size:0.8rem;color:var(--text-muted);">${escapeHtml(s.when)}</td>
                    <td style="font-size:0.78rem;color:var(--text-dim);">${escapeHtml(s.maps)}</td>
                  </tr>`;
                })
                .join('')}
            </tbody>
          </table>
        </div>
        ${
          isAdmin
            ? `<p style="margin-top:1rem;font-size:0.82rem;">To change who owns a stage, <strong>Edit</strong> that person in <em>Xerago Internal Team Database</em> (designation / Active). AI reads Active team only.</p>`
            : `<p style="margin-top:1rem;font-size:0.82rem;color:var(--accent-amber);">View only. Admin edits the Team Database to change designations.</p>`
        }`;
    }

    function openTeamMemberModal(memberId) {
      if (!XeragoAuth.isAdmin()) return alert('Only admin can edit team members.');
      const form = document.getElementById('addTeamMemberForm');
      form?.reset();
      document.getElementById('tmId').value = memberId || '';
      document.getElementById('tmModalTitle').textContent = memberId ? 'Edit Team Member' : '+ Add Internal Team Member';
      document.getElementById('tmUsername').disabled = !!memberId;
      if (memberId) {
        const m = (cache.team || []).find((t) => t.id === memberId);
        if (!m) return alert('Member not found');
        document.getElementById('tmName').value = m.name || '';
        document.getElementById('tmRole').value = m.role || '';
        document.getElementById('tmUsername').value = m.username || '';
        document.getElementById('tmEmail').value = m.email || '';
        document.getElementById('tmAccessLevel').value = m.accessLevel || 'member';
        document.getElementById('tmStatus').value = m.status === 'Inactive' ? 'Inactive' : 'Active';
        document.getElementById('tmSkills').value = (m.skills || []).join(', ');
        document.getElementById('tmResponsibilities').value = m.responsibilities || '';
        document.getElementById('tmPassword').value = '';
      }
      openModal('addTeamMemberModal');
    }

    async function setTeamStatus(memberId, status) {
      if (!XeragoAuth.isAdmin()) return alert('Only admin can change status.');
      try {
        await api(`/api/team/${memberId}`, { method: 'PUT', body: JSON.stringify({ status }) });
        await XeragoDB.refreshAll();
        showToast(`Member set to ${status}`);
        renderAdminSettingsView();
      } catch (err) {
        alert(err.message);
      }
    }

    function setupModals() {
      document.querySelectorAll('.tab-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const tabId = btn.getAttribute('data-tab');
          if (tabId) {
            const root = btn.closest('.view-panel') || document;
            root.querySelectorAll('.tab-btn[data-tab]').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            root.querySelectorAll('.tab-content').forEach((c) => (c.style.display = 'none'));
            const pane = document.getElementById(tabId);
            if (pane) pane.style.display = 'block';
          }
          const adminTabId = btn.getAttribute('data-admintab');
          if (adminTabId) {
            document.querySelectorAll('#adminSettingsView .tab-btn').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            document.querySelectorAll('.admin-tab-content').forEach((c) => (c.style.display = 'none'));
            document.getElementById(adminTabId).style.display = 'block';
            if (adminTabId === 'adminMaintenance') renderMaintenancePanel();
          }
          const myTab = btn.getAttribute('data-mytab');
          if (myTab) {
            document.querySelectorAll('#myTasksView .tab-btn').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            myTasksFilter = myTab;
            renderMyTasksView();
          }
        });
      });

      document.getElementById('createProjectForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!XeragoAuth.isAdmin()) return alert('Only admin can create projects');
        const submitBtn = e.target.querySelector('[type="submit"]');
        const prev = submitBtn.textContent;
        submitBtn.disabled = true;
        submitBtn.textContent = 'AI generating draft plan…';
        try {
          const payload = {
            name: document.getElementById('projName').value,
            type: document.getElementById('projType').value,
            description: document.getElementById('projDesc').value,
            customer: document.getElementById('projCustomer').value,
            managerId: document.getElementById('projManager').value,
            priority: document.getElementById('projPriority').value,
            targetDate: document.getElementById('projTargetDate').value
          };
          const result = await api('/api/projects', { method: 'POST', body: JSON.stringify(payload) });
          await XeragoDB.refreshAll();
          closeModal('createProjectModal');
          e.target.reset();
          openPlanReview(result.project, result.tasks, result.engine, result.model, result.analysis);
        } catch (err) {
          alert(err.message);
        } finally {
          submitBtn.disabled = false;
          submitBtn.textContent = prev;
        }
      });

      document.getElementById('docShareWith')?.addEventListener('change', () => {
        const wrap = document.getElementById('docShareUsersWrap');
        if (wrap) wrap.style.display = document.getElementById('docShareWith').value === 'users' ? 'block' : 'none';
      });
      document.getElementById('docVersionMode')?.addEventListener('change', () => {
        const wrap = document.getElementById('docVersionOfWrap');
        if (wrap) wrap.style.display = document.getElementById('docVersionMode').value === 'of' ? 'block' : 'none';
      });
      document.getElementById('shareAudienceSelect')?.addEventListener('change', () => {
        const wrap = document.getElementById('sharePeopleWrap');
        if (wrap) wrap.style.display = document.getElementById('shareAudienceSelect').value === 'users' ? 'block' : 'none';
      });
      document.getElementById('shareDocumentForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const docId = document.getElementById('shareDocId').value;
        const sharedWith = document.getElementById('shareAudienceSelect').value;
        let sharedWithIds = [];
        if (sharedWith === 'users') {
          sharedWithIds = Array.from(document.querySelectorAll('.share-modal-person:checked')).map((cb) => cb.value);
          if (!sharedWithIds.length) return alert('Select at least one person in the sub-list');
        }
        try {
          await api(`/api/documents/${docId}/share`, {
            method: 'POST',
            body: JSON.stringify({ sharedWith, sharedWithIds })
          });
          closeModal('shareDocumentModal');
          showToast('Document shared');
          await XeragoDB.refreshAll();
          renderDocumentVaultView();
        } catch (err) {
          alert(err.message);
        }
      });
      document.addEventListener('click', (ev) => {
        if (ev.target.closest('.share-menu')) return;
        document.querySelectorAll('.share-menu.open').forEach((el) => el.classList.remove('open'));
      });

      document.getElementById('uploadDocumentForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const projectId = document.getElementById('docProjectSelect').value;
        const name = document.getElementById('docTitle').value.trim();
        const category = document.getElementById('docCategory').value;
        const fileInput = document.getElementById('docFileInput');
        if (!fileInput?.files?.length) return alert('Select a file to upload');
        const btn = e.target.querySelector('[type="submit"]');
        const prev = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Uploading to cloud…';
        try {
          const documents = await readFilesAsBase64(fileInput.files);
          const file = documents[0];
          const payload = {
            projectId,
            name,
            category,
            fileName: file.fileName,
            mimeType: file.mimeType,
            dataBase64: file.dataBase64,
            fileSize: file.fileSize
          };
          if (XeragoAuth.isAdmin()) {
            payload.sharedWith = document.getElementById('docShareWith')?.value || 'team';
            if (payload.sharedWith === 'users') {
              payload.sharedWithIds = Array.from(
                document.querySelectorAll('#docShareUsersChecks input:checked')
              ).map((cb) => cb.value);
              if (!payload.sharedWithIds.length) {
                alert('Select at least one person in the sub-list');
                return;
              }
            }
            const vMode = document.getElementById('docVersionMode')?.value || 'auto';
            if (vMode === 'new') {
              payload.asNewVersion = false;
              payload.versionOf = null;
              payload.forceNew = true;
            } else if (vMode === 'of') {
              payload.versionOf = document.getElementById('docVersionOf')?.value || null;
              payload.asNewVersion = true;
              if (!payload.versionOf) {
                alert('Pick a base document in the version sub-dropdown');
                return;
              }
            }
          }
          await api('/api/documents/upload', {
            method: 'POST',
            body: JSON.stringify(payload)
          });
          await XeragoDB.refreshAll();
          closeModal('uploadDocumentModal');
          e.target.reset();
          const wrap = document.getElementById('docShareUsersWrap');
          if (wrap) wrap.style.display = 'none';
          const vWrap = document.getElementById('docVersionOfWrap');
          if (vWrap) vWrap.style.display = 'none';
          showToast('Uploaded to Cloud Document Vault');
          switchView('documentVaultView');
        } catch (err) {
          alert(err.message);
        } finally {
          btn.disabled = false;
          btn.textContent = prev;
        }
      });

      document.getElementById('addVendorForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!XeragoAuth.isAdmin()) return alert('Admin only');
        const id = document.getElementById('vendorId').value;
        const checkedServices = [];
        document.querySelectorAll('#vendorServicesCheckboxes input:checked').forEach((cb) => checkedServices.push(cb.value));
        const payload = {
          name: document.getElementById('vendorName').value,
          company: document.getElementById('vendorCompany').value,
          role: document.getElementById('vendorRole').value,
          category: document.getElementById('vendorCategory').value,
          mobile: document.getElementById('vendorMobile').value,
          whatsapp: document.getElementById('vendorWhatsapp').value,
          email: document.getElementById('vendorEmail').value,
          website: document.getElementById('vendorWebsite').value,
          rating: parseInt(document.getElementById('vendorRating').value, 10),
          status: document.getElementById('vendorStatus').value,
          notes: document.getElementById('vendorNotes').value,
          services: checkedServices
        };
        try {
          if (id) {
            await api(`/api/vendors/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
          } else {
            await api('/api/vendors', { method: 'POST', body: JSON.stringify(payload) });
          }
          await XeragoDB.refreshAll();
          closeModal('addVendorModal');
          showToast(id ? 'Vendor updated' : 'Vendor added');
          renderActiveView();
        } catch (err) {
          alert(err.message);
        }
      });

      document.getElementById('addBlockerForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const me = XeragoAuth.getCurrentUser();
        await api('/api/blockers', {
          method: 'POST',
          body: JSON.stringify({
            projectId: document.getElementById('blockerProjectSelect').value,
            description: document.getElementById('blockerDesc').value,
            priority: document.getElementById('blockerPriority').value,
            ownerId: document.getElementById('blockerOwnerSelect').value || me?.id
          })
        });
        await XeragoDB.refreshAll();
        closeModal('addBlockerModal');
        e.target.reset();
        showToast('Blocker reported');
        renderActiveView();
      });

      document.getElementById('resolveBlockerForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const blockerId = document.getElementById('resolveBlockerId').value;
        const notes = document.getElementById('resolveBlockerNotes').value.trim();
        if (!notes) return alert('Describe how you resolved the blocker');
        const btn = e.target.querySelector('[type="submit"]');
        const prev = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Saving…';
        try {
          const fileInput = document.getElementById('resolveBlockerFiles');
          let documents = [];
          if (fileInput?.files?.length) {
            documents = await readFilesAsBase64(fileInput.files);
          }
          await api(`/api/blockers/${blockerId}/resolve`, {
            method: 'POST',
            body: JSON.stringify({ resolutionNotes: notes, documents })
          });
          await XeragoDB.refreshAll();
          closeModal('resolveBlockerModal');
          showToast('Blocker resolved');
          renderActiveView();
        } catch (err) {
          alert(err.message);
        } finally {
          btn.disabled = false;
          btn.textContent = prev;
        }
      });

      document.getElementById('addTeamMemberForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!XeragoAuth.isAdmin()) return alert('Admin only');
        const id = document.getElementById('tmId').value;
        const payload = {
          name: document.getElementById('tmName').value.trim(),
          role: document.getElementById('tmRole').value.trim(),
          username: document.getElementById('tmUsername').value.trim(),
          email: document.getElementById('tmEmail').value.trim(),
          accessLevel: document.getElementById('tmAccessLevel').value,
          status: document.getElementById('tmStatus').value,
          skills: document.getElementById('tmSkills').value,
          responsibilities: document.getElementById('tmResponsibilities').value,
          password: document.getElementById('tmPassword').value
        };
        try {
          if (id) {
            await api(`/api/team/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
          } else {
            await api('/api/team', { method: 'POST', body: JSON.stringify(payload) });
          }
          await XeragoDB.refreshAll();
          closeModal('addTeamMemberModal');
          showToast('Team member saved');
          renderAdminSettingsView();
        } catch (err) {
          alert(err.message);
        }
      });

      document.getElementById('taskDetailForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('taskModalId').value;
        const body = XeragoAuth.isAdmin()
          ? {
              name: document.getElementById('taskModalName').value,
              status: document.getElementById('taskModalStatus').value,
              notes: document.getElementById('taskModalNotes').value,
              responsibleId: document.getElementById('taskModalResponsible').value,
              supportIds: document.getElementById('taskModalSupport').value
                ? [document.getElementById('taskModalSupport').value]
                : [],
              isExternal: document.getElementById('taskModalIsExternal').value === 'true',
              externalVendorId: document.getElementById('taskModalVendorSelect')?.value || null
            }
          : {
              status: document.getElementById('taskModalStatus').value,
              notes: document.getElementById('taskModalNotes').value
            };
        try {
          await api(`/api/tasks/${id}`, { method: 'PUT', body: JSON.stringify(body) });
          await XeragoDB.refreshAll();
          closeModal('taskDetailModal');
          renderActiveView();
          if (currentDetailProjectId) openProjectDetail(currentDetailProjectId);
        } catch (err) {
          alert(err.message);
        }
      });

      populateModalSelects();
    }

    async function populateModalSelects() {
      const team = (await XeragoDB.getAll('team')).filter((t) => t.status === 'Active');
      const projects = await XeragoDB.getAll('projects');
      const managerSelect = document.getElementById('projManager');
      if (managerSelect) {
        managerSelect.innerHTML = team.map((t) => `<option value="${t.id}">${escapeHtml(t.name)} (${escapeHtml(t.role)})</option>`).join('');
      }
      const blockerProjSelect = document.getElementById('blockerProjectSelect');
      if (blockerProjSelect) {
        blockerProjSelect.innerHTML = projects.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
      }
      const blockerOwner = document.getElementById('blockerOwnerSelect');
      if (blockerOwner) {
        const me = XeragoAuth.getCurrentUser();
        const active = team.filter((t) => t.status === 'Active');
        blockerOwner.innerHTML = active
          .map((t) => {
            const login = t.username || t.name;
            const label = `${t.name} (@${login})`;
            const selected = me && t.id === me.id ? ' selected' : '';
            return `<option value="${t.id}"${selected}>${escapeHtml(label)}</option>`;
          })
          .join('');
        // Always default to the logged-in account if present
        if (me?.id) blockerOwner.value = me.id;
      }
      const docProjSelect = document.getElementById('docProjectSelect');
      if (docProjSelect) {
        docProjSelect.innerHTML = projects.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
      }
      const shareChecks = document.getElementById('docShareUsersChecks');
      if (shareChecks) {
        shareChecks.innerHTML = team
          .filter((t) => t.status === 'Active')
          .map(
            (t) =>
              `<label style="display:flex;gap:0.4rem;align-items:center;font-size:0.8rem;padding:0.2rem 0;"><input type="checkbox" value="${t.id}"> ${escapeHtml(t.name)} (${escapeHtml(t.role)})</label>`
          )
          .join('');
      }
      const versionOf = document.getElementById('docVersionOf');
      const projectId = document.getElementById('docProjectSelect')?.value;
      if (versionOf) {
        const docs = (cache.documents || []).filter((d) => !projectId || d.projectId === projectId);
        const latestByGroup = {};
        for (const d of docs) {
          const gid = d.versionGroupId || d.id;
          if (!latestByGroup[gid] || (d.versionIndex || 0) > (latestByGroup[gid].versionIndex || 0)) {
            latestByGroup[gid] = d;
          }
        }
        versionOf.innerHTML = Object.values(latestByGroup)
          .map(
            (d) =>
              `<option value="${d.id}">${escapeHtml(d.name || d.fileName)} (${escapeHtml(d.revision || 'Rev A')})</option>`
          )
          .join('') || '<option value="">No existing docs</option>';
      }
    }

    function openModal(id) {
      const adminModals = ['createProjectModal', 'addVendorModal', 'addTeamMemberModal', 'planReviewModal'];
      if (adminModals.includes(id) && !XeragoAuth.isAdmin()) {
        return alert('Only admin can do this. Team members have view / own-task access only.');
      }
      populateModalSelects();
      document.getElementById(id)?.classList.add('active');
    }

    function promptAddCategory() {
      if (!XeragoAuth.isAdmin()) return alert('Admin only');
      alert('Category editor: add custom labels in a future update. Core workflow categories are built into the AI planner.');
    }

    function closeModal(id) {
      document.getElementById(id)?.classList.remove('active');
    }

    async function openTaskDetailModal(taskId) {
      const task = await XeragoDB.get('tasks', taskId);
      const team = await XeragoDB.getAll('team');
      const docs = await XeragoDB.getAll('documents');
      if (!task) return;

      document.getElementById('taskModalId').value = task.id;
      document.getElementById('taskModalName').value = task.name;
      document.getElementById('taskModalStatus').value = task.status;
      document.getElementById('taskModalNotes').value = task.notes || '';
      const fileInput = document.getElementById('taskModalFiles');
      if (fileInput) fileInput.value = '';

      const respSelect = document.getElementById('taskModalResponsible');
      respSelect.innerHTML = team
        .map((t) => `<option value="${t.id}" ${t.id === task.responsibleId ? 'selected' : ''}>${escapeHtml(t.name)} (${escapeHtml(t.role)})</option>`)
        .join('');
      respSelect.disabled = !XeragoAuth.isAdmin();

      const suppSelect = document.getElementById('taskModalSupport');
      suppSelect.innerHTML =
        '<option value="">None</option>' +
        team.map((t) => `<option value="${t.id}" ${(task.supportIds || [])[0] === t.id ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('');
      suppSelect.disabled = !XeragoAuth.isAdmin();

      document.getElementById('taskModalIsExternal').value = task.isExternal ? 'true' : 'false';
      document.getElementById('taskModalIsExternal').disabled = !XeragoAuth.isAdmin();
      document.getElementById('taskModalName').readOnly = !XeragoAuth.isAdmin();
      document.getElementById('taskModalStatus').disabled = !XeragoAuth.isAdmin() && (task.status === 'Submitted' || task.status === 'Completed');

      const taskDocs = docs.filter((d) => d.taskId === task.id || (task.documentIds || []).includes(d.id));
      const docsEl = document.getElementById('taskExistingDocs');
      if (docsEl) {
        docsEl.innerHTML = taskDocs.length
          ? taskDocs
              .map(
                (d) =>
                  `<div style="font-size:0.8rem;display:flex;justify-content:space-between;gap:0.5rem;">
                    <span>📎 ${escapeHtml(d.fileName || d.name)} <span style="color:var(--text-dim);">by ${escapeHtml(d.uploadedByName || '')}</span></span>
                    <button type="button" class="btn btn-secondary btn-sm" onclick="UI.downloadDocument('${d.id}')">Download</button>
                  </div>`
              )
              .join('')
          : '<span style="font-size:0.78rem;color:var(--text-dim);">No documents yet.</span>';
      }

      const actions = document.getElementById('taskWorkflowActions');
      if (actions) {
        const me = XeragoAuth.getCurrentUser();
        const isOwner = me && task.responsibleId === me.id;
        let html = '';
        if (isOwner && !['Draft', 'Submitted', 'Completed'].includes(task.status)) {
          html += `<button type="button" class="btn btn-primary" onclick="UI.submitTaskWork('${task.id}')">Submit work + docs for manager</button>`;
        }
        if (XeragoAuth.isAdmin() && task.status === 'Submitted') {
          html += `<button type="button" class="btn btn-primary" onclick="UI.verifyTask('${task.id}')">Verify &amp; mark complete</button>`;
          html += `<button type="button" class="btn btn-secondary" onclick="UI.rejectTask('${task.id}')">Send back for rework</button>`;
        }
        if (task.status === 'Submitted') {
          html += `<span class="badge badge-warning">Awaiting manager verification</span>`;
        }
        if (task.status === 'Completed') {
          html += `<span class="badge badge-success">Verified complete by manager</span>`;
        }
        actions.innerHTML = html;
      }

      try {
        const recs = await XeragoRules.recommendVendors(task.category);
        const recList = document.getElementById('vendorRecommendationsList');
        if (recList) {
          recList.innerHTML = (recs || [])
            .slice(0, 3)
            .map(
              (r) => `
            <div style="display:flex; justify-content:space-between; font-size:0.78rem; background:var(--bg-surface); padding:0.4rem; border-radius:6px;">
              <span><strong>${escapeHtml(r.vendor.name)}</strong> (${escapeHtml(r.vendor.company || '')})</span>
              <span>${r.vendor.rating}/5</span>
            </div>`
            )
            .join('');
        }
        const vendors = await XeragoDB.getAll('vendors');
        const vSelect = document.getElementById('taskModalVendorSelect');
        if (vSelect) {
          vSelect.innerHTML = vendors
            .map((v) => `<option value="${v.id}" ${v.id === task.externalVendorId ? 'selected' : ''}>${escapeHtml(v.name)} - ${escapeHtml(v.company || '')}</option>`)
            .join('');
          vSelect.disabled = !XeragoAuth.isAdmin();
        }
      } catch {
        /* ignore */
      }

      toggleTaskVendorSection();
      openModal('taskDetailModal');
    }

    function toggleTaskVendorSection() {
      const isExt = document.getElementById('taskModalIsExternal')?.value === 'true';
      const sec = document.getElementById('taskVendorSection');
      if (sec) sec.style.display = isExt ? 'block' : 'none';
    }

    async function quickCompleteTask(taskId) {
      // Teammates must open task and submit docs — shortcut opens modal
      openTaskDetailModal(taskId);
    }

    function readFilesAsBase64(fileList) {
      const files = Array.from(fileList || []);
      return Promise.all(
        files.map(
          (file) =>
            new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => {
                const result = String(reader.result || '');
                const dataBase64 = result.includes(',') ? result.split(',')[1] : result;
                resolve({
                  fileName: file.name,
                  name: file.name,
                  mimeType: file.type || 'application/octet-stream',
                  fileSize: `${Math.max(1, Math.round(file.size / 1024))} KB`,
                  dataBase64
                });
              };
              reader.onerror = reject;
              reader.readAsDataURL(file);
            })
        )
      );
    }

    async function submitTaskWork(taskId) {
      try {
        const notes = document.getElementById('taskModalNotes').value;
        const files = document.getElementById('taskModalFiles')?.files;
        if (!files || !files.length) {
          return alert('Attach at least one document of the work you completed.');
        }
        const documents = await readFilesAsBase64(files);
        await api(`/api/tasks/${taskId}/submit`, {
          method: 'POST',
          body: JSON.stringify({ notes, documents })
        });
        await XeragoDB.refreshAll();
        closeModal('taskDetailModal');
        showToast('Submitted to manager for verification');
        renderActiveView();
      } catch (err) {
        alert(err.message);
      }
    }

    async function verifyTask(taskId) {
      if (!confirm('Verify this work and mark the task completed?')) return;
      try {
        await api(`/api/tasks/${taskId}/verify`, { method: 'POST', body: '{}' });
        await XeragoDB.refreshAll();
        closeModal('taskDetailModal');
        showToast('Task verified & completed');
        renderActiveView();
      } catch (err) {
        alert(err.message);
      }
    }

    async function rejectTask(taskId) {
      const reason = prompt('What should the teammate fix?', 'Please revise and resubmit with updated documents');
      if (reason == null) return;
      try {
        await api(`/api/tasks/${taskId}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
        await XeragoDB.refreshAll();
        closeModal('taskDetailModal');
        showToast('Sent back for rework');
        renderActiveView();
      } catch (err) {
        alert(err.message);
      }
    }

    async function downloadDocument(docId) {
      try {
        const token = localStorage.getItem(TOKEN_KEY);
        const res = await fetch(`/api/documents/${docId}/download`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {}
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Download failed');
        }
        const type = res.headers.get('Content-Type') || '';
        if (type.includes('application/json')) {
          const doc = await res.json();
          const a = document.createElement('a');
          a.href = `data:${doc.mimeType};base64,${doc.dataBase64}`;
          a.download = doc.fileName || doc.name || 'document';
          a.click();
          return;
        }
        const blob = await res.blob();
        const cd = res.headers.get('Content-Disposition') || '';
        const match = /filename="?([^"]+)"?/.exec(cd);
        const fileName = match ? match[1] : 'document';
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        alert(err.message);
      }
    }

    async function deleteProject(projectId) {
      if (!XeragoAuth.isAdmin()) return alert('Admin only');
      let proj = await XeragoDB.get('projects', projectId);
      if (!proj) {
        const archived = await XeragoDB.getArchivedProjects();
        proj = archived.find((p) => p.id === projectId);
      }
      if (!proj) return;
      if (
        !confirm(
          `Permanently delete "${proj.name}"?\nThis cannot be undone — tasks, blockers, and vault files for this project will be removed.\n\nTip: use Archive for soft-delete.`
        )
      )
        return;
      try {
        await api(`/api/projects/${projectId}`, { method: 'DELETE' });
        await XeragoDB.refreshAll();
        currentDetailProjectId = null;
        showToast('Project permanently deleted');
        switchView('projectsView');
      } catch (err) {
        alert(err.message);
      }
    }

    function openPlanReview(project, tasks, engine, model, analysis) {
      document.getElementById('planReviewProjectId').value = project.id;
      const sub = document.getElementById('planReviewSubtitle');
      const analysisBox = document.getElementById('planReviewAnalysis');
      const summary = analysis?.summary || `"${project.name}" proposed via ${engine}${model ? ' (' + model + ')' : ''}.`;
      if (sub) {
        sub.textContent = `No tasks are created yet. Confirm only after you agree who is needed. Engine: ${engine}${model ? ' / ' + model : ''}.`;
      }
      if (analysisBox) {
        const needed = (analysis?.neededRoles || [])
          .map((r) => `<span class="badge badge-success" title="${escapeHtml(r.reason || '')}">${escapeHtml(r.name)} · ${escapeHtml(r.role)}</span>`)
          .join(' ');
        const skipped = (analysis?.skippedRoles || [])
          .map((s) => `<span class="badge badge-warning" title="${escapeHtml(s.reason || '')}">Skip: ${escapeHtml(s.member?.name || '')} · ${escapeHtml(s.member?.role || '')}</span>`)
          .join(' ');
        analysisBox.innerHTML = `
          <p style="font-size:0.85rem;margin-bottom:0.75rem;">${escapeHtml(summary)}</p>
          <div style="display:flex;flex-wrap:wrap;gap:0.35rem;margin-bottom:0.5rem;"><strong style="width:100%;font-size:0.75rem;color:var(--text-dim);">Needed for this project</strong>${needed || '—'}</div>
          <div style="display:flex;flex-wrap:wrap;gap:0.35rem;"><strong style="width:100%;font-size:0.75rem;color:var(--text-dim);">Not required this time</strong>${skipped || '<span class="badge badge-cyan">Everyone involved</span>'}</div>`;
      }
      const team = cache.team || [];
      const body = document.getElementById('planReviewTableBody');
      body.innerHTML = tasks
        .map((t) => {
          const tid = t.tempId || t.id;
          const options = team
            .map((m) => `<option value="${m.id}" ${m.id === t.responsibleId ? 'selected' : ''}>${escapeHtml(m.name)} (${escapeHtml(m.role)})</option>`)
            .join('');
          return `<tr data-temp-id="${tid}">
            <td><input type="checkbox" class="plan-include" checked title="Include this task"></td>
            <td><strong>${escapeHtml(t.name)}</strong><div style="font-size:0.72rem;color:var(--text-dim);">${escapeHtml(t.description || '')}</div></td>
            <td><span class="badge badge-primary">${escapeHtml(t.category)}</span></td>
            <td><select class="form-control plan-assignee">${options}</select></td>
            <td>
              <select class="form-control plan-priority">
                ${['Low', 'Medium', 'High', 'Critical'].map((p) => `<option value="${p}" ${p === t.priority ? 'selected' : ''}>${p}</option>`).join('')}
              </select>
            </td>
          </tr>`;
        })
        .join('');
      openModal('planReviewModal');
    }

    async function publishPlan() {
      const projectId = document.getElementById('planReviewProjectId').value;
      if (!projectId) return;
      if (!confirm('Confirm this AI plan? Real tasks will be created and sent only to the selected people.')) return;
      const btn = document.getElementById('publishPlanBtn');
      btn.disabled = true;
      btn.textContent = 'Creating tasks…';
      try {
        const taskEdits = {};
        const includedTempIds = [];
        document.querySelectorAll('#planReviewTableBody tr').forEach((tr) => {
          const id = tr.getAttribute('data-temp-id');
          const include = tr.querySelector('.plan-include')?.checked;
          if (include) includedTempIds.push(id);
          taskEdits[id] = {
            responsibleId: tr.querySelector('.plan-assignee').value,
            priority: tr.querySelector('.plan-priority').value
          };
        });
        if (!includedTempIds.length) {
          alert('Select at least one task to create.');
          return;
        }
        const result = await api(`/api/projects/${projectId}/publish-plan`, {
          method: 'POST',
          body: JSON.stringify({ taskEdits, includedTempIds })
        });
        await XeragoDB.refreshAll();
        closeModal('planReviewModal');
        showToast(`Confirmed — created ${result.tasks.length} tasks for selected teammates`);
        switchView('pmCommandView');
      } catch (err) {
        alert(err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Confirm & create tasks';
      }
    }

    async function resolveBlocker(blockerId) {
      const blockers = await XeragoDB.getAll('blockers');
      const team = await XeragoDB.getAll('team');
      const b = blockers.find((x) => x.id === blockerId);
      if (!b) return alert('Blocker not found');
      const me = XeragoAuth.getCurrentUser();
      const ownerId = b.ownerId || b.reportedBy;
      if (!me || me.id !== ownerId) {
        return alert(`Only the assigned owner (${blockerOwnerLabel(b, team)}) can resolve this blocker.`);
      }
      document.getElementById('resolveBlockerId').value = blockerId;
      document.getElementById('resolveBlockerSummary').textContent = b.description || '';
      document.getElementById('resolveBlockerOwnerHint').innerHTML = `Resolving as <strong>${escapeHtml(
        blockerOwnerLabel(b, team)
      )}</strong> — describe how you fixed it; attach files if needed.`;
      document.getElementById('resolveBlockerNotes').value = '';
      const fileInput = document.getElementById('resolveBlockerFiles');
      if (fileInput) fileInput.value = '';
      openModal('resolveBlockerModal');
    }

    async function viewBlockerResolution(blockerId) {
      const blockers = await XeragoDB.getAll('blockers');
      const team = await XeragoDB.getAll('team');
      const b = blockers.find((x) => x.id === blockerId);
      if (!b) return;
      const docs = (await XeragoDB.getAll('documents')).filter(
        (d) => (b.resolutionDocumentIds || []).includes(d.id) || d.blockerId === b.id
      );
      const body = document.getElementById('viewResolutionBody');
      if (!body) return;
      const filesHtml = docs.length
        ? `<ul style="margin:0.5rem 0 0 1.1rem;">${docs
            .map(
              (d) =>
                `<li style="margin-bottom:0.35rem;"><strong>${escapeHtml(d.fileName || d.name)}</strong>
                  <button type="button" class="btn btn-secondary btn-sm" style="margin-left:0.35rem;" onclick="UI.downloadDocument('${d.id}')">Download</button></li>`
            )
            .join('')}</ul>`
        : `<p style="color:var(--text-dim);margin:0.35rem 0 0;">No supporting files attached.</p>`;
      body.innerHTML = `
        <div class="card" style="margin-bottom:0.85rem;padding:0.85rem;">
          <div style="font-size:0.72rem;color:var(--text-dim);margin-bottom:0.25rem;">Original blocker</div>
          <strong style="color:var(--accent-rose);">${escapeHtml(b.description)}</strong>
        </div>
        <p><strong>Assigned resolver:</strong> ${escapeHtml(blockerOwnerLabel(b, team))}</p>
        <p><strong>Reported by:</strong> ${escapeHtml(blockerReporterLabel(b, team))}</p>
        <p><strong>Resolved by:</strong> ${escapeHtml(
          b.resolvedByUsername ? `${b.resolvedByName || ''} (@${b.resolvedByUsername})` : '—'
        )} ${b.resolvedAt ? `· ${escapeHtml(String(b.resolvedAt).replace('T', ' ').slice(0, 19))}` : ''}</p>
        <div style="margin-top:0.85rem;">
          <div style="font-size:0.72rem;color:var(--text-dim);margin-bottom:0.25rem;">How it was resolved</div>
          <div style="background:var(--bg-input);border:1px solid var(--border-color);border-radius:10px;padding:0.85rem;white-space:pre-wrap;">${escapeHtml(
            b.resolutionNotes || '(No description provided)'
          )}</div>
        </div>
        <div style="margin-top:0.85rem;">
          <div style="font-size:0.72rem;color:var(--text-dim);">Supporting files</div>
          ${filesHtml}
        </div>`;
      openModal('viewResolutionModal');
    }

    function openChangePassword(forced) {
      const err = document.getElementById('changePasswordError');
      if (err) err.textContent = '';
      document.getElementById('pwCurrent').value = '';
      document.getElementById('pwNew').value = '';
      document.getElementById('pwConfirm').value = '';
      const hint = document.getElementById('changePasswordHint');
      if (hint) {
        hint.textContent = forced
          ? 'First login: set a new password. It is stored hashed in the server database (not localStorage).'
          : 'Password is saved hashed in the server database (not localStorage).';
      }
      const closeBtn = document.getElementById('changePasswordCloseBtn');
      const cancelBtn = document.getElementById('changePasswordCancelBtn');
      if (closeBtn) closeBtn.style.display = forced ? 'none' : '';
      if (cancelBtn) cancelBtn.style.display = forced ? 'none' : '';
      openModal('changePasswordModal');
    }

    function maybeForcePasswordChange() {
      const u = XeragoAuth.getCurrentUser();
      if (u?.mustChangePassword) openChangePassword(true);
    }

    function setupChangePasswordForm() {
      document.getElementById('changePasswordForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const errEl = document.getElementById('changePasswordError');
        errEl.textContent = '';
        const currentPassword = document.getElementById('pwCurrent').value;
        const newPassword = document.getElementById('pwNew').value;
        const confirm = document.getElementById('pwConfirm').value;
        if (newPassword !== confirm) {
          errEl.textContent = 'New passwords do not match';
          return;
        }
        try {
          const data = await api('/api/auth/change-password', {
            method: 'POST',
            body: JSON.stringify({ currentPassword, newPassword })
          });
          XeragoAuth.currentUser = data.user;
          updateUserUI();
          closeModal('changePasswordModal');
          showToast('Password updated in server database');
        } catch (err) {
          errEl.textContent = err.message || 'Could not change password';
        }
      });
    }

    async function regenerateProjectTasks(projId) {
      if (!XeragoAuth.isAdmin()) return alert('Admin only');
      if (!confirm('Re-analyze this project with AI? The proposal will be replaced. Existing assigned tasks are kept.')) return;
      try {
        const result = await api(`/api/projects/${projId}/regenerate-tasks`, { method: 'POST', body: '{}' });
        await XeragoDB.refreshAll();
        openPlanReview(result.project, result.tasks, result.engine, result.model, result.analysis);
      } catch (err) {
        alert(err.message);
      }
    }

    function setupSearch() {
      document.getElementById('globalSearchInput')?.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();
        if (!query) return;
        // Lightweight: jump to my tasks if query matches "task"
      });
    }

    async function updateStorageMeter() {
      const el = document.getElementById('storageMeterText');
      const fill = document.getElementById('storageMeterFill');
      try {
        const s = await api('/api/cloud-vault/stats');
        const pct = s.maxBytes ? Math.min(100, Math.round((s.usedBytes / s.maxBytes) * 100)) : 0;
        if (el) el.textContent = `Vault ${s.usedMb} MB / ${s.maxMb} MB · ${s.fileCount} file(s)`;
        if (fill) fill.style.width = `${pct}%`;
      } catch {
        if (el) el.textContent = 'Vault stats unavailable';
        if (fill) fill.style.width = '0%';
      }
    }

    return {
      init,
      switchView,
      renderActiveView,
      openModal,
      closeModal,
      openProjectDetail,
      openTaskDetailModal,
      toggleTaskVendorSection,
      quickCompleteTask,
      submitTaskWork,
      verifyTask,
      rejectTask,
      downloadDocument,
      deleteVaultDocument,
      shareVaultDocument,
      openShareModal,
      toggleShareMenu,
      toggleShareSubmenu,
      quickShareDocument,
      shareSelectedPeople,
      archiveProject,
      restoreProject,
      publishPlan,
      reviewProjectPlan,
      deleteProject,
      openTeamMemberModal,
      setTeamStatus,
      openVendorModal,
      deleteVendor,
      promptAddCategory,
      resolveBlocker,
      viewBlockerResolution,
      openChangePassword,
      regenerateProjectTasks,
      exportSnapshot: () => XeragoDB.exportSnapshot(),
      resetDb: () => XeragoDB.resetToSeed()
    };
  })();

  function statusBadge(status) {
    if (status === 'Completed') return 'badge-success';
    if (status === 'In Progress' || status === 'Assigned') return 'badge-cyan';
    if (status === 'Blocked') return 'badge-danger';
    if (status === 'Submitted') return 'badge-warning';
    if (status === 'Draft') return 'badge-primary';
    return 'badge-warning';
  }

  function blockerOwnerLabel(b, team) {
    if (b.ownerUsername || b.ownerName) {
      return b.ownerUsername ? `${b.ownerName || ''} (@${b.ownerUsername})`.trim() : b.ownerName;
    }
    const id = b.ownerId || b.reportedBy;
    const m = (team || []).find((t) => t.id === id);
    if (!m) return '—';
    return m.username ? `${m.name} (@${m.username})` : m.name;
  }

  function blockerReporterLabel(b, team) {
    if (b.reportedByUsername || b.reportedByName) {
      return b.reportedByUsername
        ? `${b.reportedByName || ''} (@${b.reportedByUsername})`.trim()
        : b.reportedByName;
    }
    const m = (team || []).find((t) => t.id === b.reportedBy);
    if (!m) return '—';
    return m.username ? `${m.name} (@${m.username})` : m.name;
  }

  function dueBadgeHtml(targetDate, status) {
    if (!targetDate || status === 'Completed') return '';
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const d = new Date(targetDate);
    if (Number.isNaN(d.getTime())) return '';
    d.setHours(0, 0, 0, 0);
    const diff = Math.round((d - today) / 86400000);
    if (diff < 0) {
      return `<div style="margin-top:0.25rem;"><span class="badge badge-danger">Overdue ${Math.abs(diff)}d · ${escapeHtml(targetDate)}</span></div>`;
    }
    if (diff <= 3) {
      return `<div style="margin-top:0.25rem;"><span class="badge badge-warning">Due in ${diff}d · ${escapeHtml(targetDate)}</span></div>`;
    }
    return `<div style="margin-top:0.25rem;font-size:0.72rem;color:var(--text-dim);">Due ${escapeHtml(targetDate)}</div>`;
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatTime(ts) {
    try {
      return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch {
      return ts;
    }
  }

  function connectSocket() {
    if (typeof io === 'undefined') return;
    const socket = io();
    window.__xeragoSocket = socket;
    socket.on('connect', () => {
      const u = XeragoAuth.getCurrentUser();
      if (u) socket.emit('join', { userId: u.id, accessLevel: u.accessLevel });
    });
    socket.on('data:changed', async () => {
      await XeragoDB.refreshAll();
      UI.renderActiveView();
    });
    socket.on('task:assigned', async (payload) => {
      await XeragoDB.refreshAll();
      const me = XeragoAuth.getCurrentUser();
      if (me && payload?.assigneeId === me.id) {
        showToast(`New task assigned to you: ${payload.task?.name || 'Task'}`);
      }
      UI.renderActiveView();
    });
    // Manager / system → all teammates
    socket.on('notify:team', async (payload) => {
      await XeragoDB.refreshAll();
      UI.renderActiveView();
      if (payload?.message) showToast(payload.message);
    });
    // Teammate activity → admin/manager only
    socket.on('notify:admin', async (payload) => {
      if (!XeragoAuth.isAdmin()) return;
      await XeragoDB.refreshAll();
      UI.renderActiveView();
      if (payload?.message) showToast(payload.message);
      const feed = document.getElementById('pmLiveProgressFeed');
      const pulse = document.getElementById('pmLivePulse');
      if (pulse) pulse.textContent = `Live · ${new Date().toLocaleTimeString()}`;
      if (feed) {
        const line = document.createElement('div');
        line.style.cssText = 'font-size:0.82rem;padding:0.45rem 0.6rem;background:var(--bg-input);border-radius:8px;border:1px solid var(--border-color);';
        line.innerHTML = `<strong>Team</strong> · ${escapeHtml(payload.message || 'Update')} <span style="color:var(--text-dim);float:right;">${new Date().toLocaleTimeString()}</span>`;
        feed.prepend(line);
        while (feed.children.length > 30) feed.removeChild(feed.lastChild);
      }
    });
    socket.on('progress:updated', async (payload) => {
      await XeragoDB.refreshAll();
      UI.renderActiveView();
      if (!XeragoAuth.isAdmin()) return;
      const feed = document.getElementById('pmLiveProgressFeed');
      const pulse = document.getElementById('pmLivePulse');
      if (pulse) pulse.textContent = `Live · ${new Date().toLocaleTimeString()}`;
      if (feed) {
        const line = document.createElement('div');
        line.style.cssText = 'font-size:0.82rem;padding:0.45rem 0.6rem;background:var(--bg-input);border-radius:8px;border:1px solid var(--border-color);';
        const label = payload.verified
          ? 'Manager verified'
          : payload.awaitingVerification
            ? 'Submitted for verification'
            : payload.rejected
              ? 'Sent for rework'
              : 'Progress update';
        line.innerHTML = `<strong>${escapeHtml(payload.by || 'Team')}</strong> · ${label}${payload.task ? ': ' + escapeHtml(payload.task.name) : ''} <span style="color:var(--text-dim);float:right;">${new Date().toLocaleTimeString()}</span>`;
        feed.prepend(line);
        while (feed.children.length > 30) feed.removeChild(feed.lastChild);
      }
    });
  }

  function showToast(msg) {
    let toast = document.getElementById('liveToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'liveToast';
      toast.className = 'live-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3500);
  }

  window.UI = UI;
  window.XeragoAuth = XeragoAuth;
  window.XeragoDB = XeragoDB;

  document.addEventListener('DOMContentLoaded', async () => {
    connectSocket();
    const ok = await XeragoAuth.init();
    if (ok) {
      await XeragoDB.open();
      await UI.init();
      await UI.renderActiveView();
    } else {
      // still wire login UI
      UI.init();
    }
  });
})();
