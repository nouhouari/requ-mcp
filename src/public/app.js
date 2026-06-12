/* requ — Alpine.js dashboard component
 * Matches index.html exactly. All method names / property names are canonical here.
 * global Chart, Alpine
 */
document.addEventListener('alpine:init', function () {
  Alpine.data('requApp', function () {
    return {

      // ── Navigation ──────────────────────────────────────────────────────────
      tab: 'overview',

      // ── Global state ────────────────────────────────────────────────────────
      notInitialized: false,

      /** Granular loading flags so each section shows its own skeleton. */
      loading: {
        config: false, summary: false, requirements: false,
        stories: false, components: false, phases: false,
        vcs: false, coverage: false, trend: false, gaps: false,
        global: false,
      },

      // ── Data ────────────────────────────────────────────────────────────────
      config: null,
      summary: null,
      requirements: [],
      stories: [],
      components: [],
      phases: [],
      vcsRefs: [],
      coverage: null,
      trend: null,
      gaps: null,

      // ── Requirement filters ──────────────────────────────────────────────────
      reqSearch: '',
      reqStatusFilter: 'all',
      reqPriorityFilter: 'all',
      reqComponentFilter: 'all',
      reqExpanded: null,
      reqSortBy: 'id',

      // ── Story filters ────────────────────────────────────────────────────────
      storySearch: '',
      storyStatusFilter: 'all',
      storyExpanded: null,

      // ── VCS filters ──────────────────────────────────────────────────────────
      vcsKindFilter: 'all',
      vcsStateFilter: 'all',

      // ── Coverage controls ────────────────────────────────────────────────────
      coveragePhase: null,
      coverageMode: 'cumulative',
      showStoriesDetail: false,

      // ── Charts ───────────────────────────────────────────────────────────────
      _trendChart: null,
      _donutChart: null,

      // ── SSE handle ───────────────────────────────────────────────────────────
      _sse: null,

      // ── Multi-project ─────────────────────────────────────────────────────────────
      projects: [],
      activeProject: null,
      globalSummary: [],

      // ── Export / Import ───────────────────────────────────────────────────────────
      importDialogOpen: false,
      importResult: null,
      importing: false,

      // ── Setup form ─────────────────────────────────────────────────────────────
      setupName: '',
      setupKey: '',
      setupBrief: '',
      setupPhase: '',
      setupSubmitting: false,
      setupError: null,

      // ── Brief inline edit ──────────────────────────────────────────────────────
      briefEditing: false,
      briefDraft: '',
      briefSaving: false,
      briefError: null,

      // =========================================================================
      // Lifecycle
      // =========================================================================

      async init() {
        await this.loadProjects();
        if (this.projects.length > 1) { this.tab = 'global'; }
        await this.loadConfig();
        await this.loadSummary();
        this.setupSSE();
        var loaders = [
          this.loadRequirements(),
          this.loadStories(),
          this.loadComponents(),
          this.loadPhases(),
          this.loadVcsRefs(),
          this.loadCoverage(),
          this.loadTrend(),
          this.loadGaps(),
        ];
        if (this.projects.length > 1) loaders.push(this.loadGlobalSummary());
        await Promise.all(loaders);
      },

      // =========================================================================
      // API helpers
      // =========================================================================

      async _fetch(url) {
        try {
          var res = await window.fetch(url);
          if (res.status === 503) {
            var body = await res.json().catch(function () { return {}; });
            if (body && body.code === 'NOT_INITIALIZED') {
              // Only set to true here; reset happens only when config loads successfully
              // to avoid a race where concurrent loaders write conflicting values.
              this.notInitialized = true;
              return null;
            }
          }
          if (!res.ok) return null;
          return await res.json();
        } catch (_) {
          return null;
        }
      },

      // =========================================================================
      // Loaders
      // =========================================================================

      async loadProjects() {
        // /api/projects never requires ?project= — it lists all loaded projects.
        var d = await this._fetch('/api/projects');
        if (d && Array.isArray(d)) {
          this.projects = d;
          if (d.length > 0 && !this.activeProject) {
            this.activeProject = d[0];
          }
        }
      },

      async loadGlobalSummary() {
        this.loading.global = true;
        try {
          var d = await this._fetch('/api/global');
          if (d && Array.isArray(d)) this.globalSummary = d;
        } finally {
          this.loading.global = false;
        }
      },

      async switchProject(slug) {
        var self = this;
        var found = this.projects.find(function (p) { return p.slug === slug; });
        if (!found || found === this.activeProject) return;
        this.activeProject = found;
        // Reconnect SSE for the new project.
        if (this._sse) { this._sse.close(); this._sse = null; }
        this.setupSSE();
        // Reload all data for the new project.
        await Promise.all([
          self.loadConfig(),
          self.loadSummary(),
          self.loadRequirements(),
          self.loadStories(),
          self.loadComponents(),
          self.loadPhases(),
          self.loadVcsRefs(),
          self.loadCoverage(),
          self.loadTrend(),
          self.loadGaps(),
        ]);
      },

      async loadConfig() {
        this.loading.config = true;
        var d = await this._fetch(this.apiUrl('/api/config'));
        if (d) {
          this.config = d;
          // Single authoritative reset: if config loads, project is initialized.
          this.notInitialized = false;
        }
        this.loading.config = false;
      },

      async loadSummary() {
        this.loading.summary = true;
        var d = await this._fetch(this.apiUrl('/api/summary'));
        if (d) {
          this.summary = d;
          if (!this.coveragePhase && d.activePhase) this.coveragePhase = d.activePhase;
        }
        this.loading.summary = false;
      },

      async loadRequirements() {
        this.loading.requirements = true;
        var d = await this._fetch(this.apiUrl('/api/requirements'));
        if (d) this.requirements = d;
        this.loading.requirements = false;
      },

      async loadStories() {
        this.loading.stories = true;
        var d = await this._fetch(this.apiUrl('/api/stories'));
        if (d) this.stories = d;
        this.loading.stories = false;
      },

      async loadComponents() {
        this.loading.components = true;
        var d = await this._fetch(this.apiUrl('/api/components'));
        if (d) this.components = d;
        this.loading.components = false;
      },

      async loadPhases() {
        this.loading.phases = true;
        var d = await this._fetch(this.apiUrl('/api/phases'));
        if (d) this.phases = d;
        this.loading.phases = false;
      },

      async loadVcsRefs() {
        this.loading.vcs = true;
        var d = await this._fetch(this.apiUrl('/api/vcs'));
        if (d) this.vcsRefs = d;
        this.loading.vcs = false;
      },

      async loadCoverage() {
        this.loading.coverage = true;
        var phase = this.coveragePhase ? ('&phase=' + encodeURIComponent(this.coveragePhase)) : '';
        var d = await this._fetch(this.apiUrl('/api/coverage?mode=' + this.coverageMode + phase));
        if (d) this.coverage = d;
        this.loading.coverage = false;
      },

      async loadTrend() {
        this.loading.trend = true;
        var d = await this._fetch(this.apiUrl('/api/coverage/trend'));
        if (d) this.trend = d;
        this.loading.trend = false;
      },

      async loadGaps() {
        this.loading.gaps = true;
        var phase = this.coveragePhase ? ('&phase=' + encodeURIComponent(this.coveragePhase)) : '';
        var d = await this._fetch(this.apiUrl('/api/coverage/gaps?mode=' + this.coverageMode + phase));
        if (d) this.gaps = d;
        this.loading.gaps = false;
      },

      async refreshCoverage() {
        await Promise.all([this.loadCoverage(), this.loadGaps()]);
      },

      // =========================================================================
      // SSE
      // =========================================================================

      setupSSE() {
        if (this._sse) return;
        var self = this;
        try {
          var es = new EventSource(this.apiUrl('/events'));
          es.onmessage = function (e) {
            try {
              var d = JSON.parse(e.data);
              if (d && typeof d === 'object') {
                var prev = self.summary;
                self.summary = d;
                self.notInitialized = false;
                if (self.tab === 'global') { self.loadGlobalSummary(); }
                if (!prev || d.requirements !== prev.requirements) self.loadRequirements();
                if (!prev || d.stories !== prev.stories) self.loadStories();
                if (!prev || d.components !== prev.components) self.loadComponents();
                if (!prev || d.phases !== prev.phases) self.loadPhases();
                if (!prev || d.vcsRefs !== prev.vcsRefs) self.loadVcsRefs();
                var coverageChanged = !prev ||
                  d.verifiedPct !== prev.verifiedPct ||
                  d.storyCoveragePct !== prev.storyCoveragePct ||
                  d.stories !== prev.stories ||
                  d.requirements !== prev.requirements;
                if (coverageChanged) { self.loadCoverage(); self.loadTrend(); self.loadGaps(); }
              }
            } catch (_) {}
          };
          es.onerror = function () {};
          this._sse = es;
        } catch (_) {}
      },

      // =========================================================================
      // Tab navigation
      // =========================================================================

      navTo(id) {
        this.tab = id;
        if (id === 'global') { this.loadGlobalSummary(); }
      },

      /**
       * Keyboard arrow navigation for the tab list (ARIA tablist pattern).
       * dir=1 → next, dir=-1 → prev, dir=-999 → first, dir=999 → last.
       */
      shiftFocus(dir) {
        var tabs = this.projects.length > 1
          ? ['global', 'overview', 'requirements', 'stories', 'coverage', 'components', 'vcs']
          : ['overview', 'requirements', 'stories', 'coverage', 'components', 'vcs'];
        var idx = tabs.indexOf(this.tab);
        if (dir === -999) { idx = 0; }
        else if (dir === 999) { idx = tabs.length - 1; }
        else { idx = (idx + dir + tabs.length) % tabs.length; }
        this.navTo(tabs[idx]);
        var self = this;
        this.$nextTick(function () {
          var el = document.querySelector('[role="tab"][aria-selected="true"]');
          if (el) el.focus();
        });
      },

      /**
       * Returns the given API path with ?project=<slug> appended when
       * multiple projects are loaded. Handles paths that already have a
       * query string by using '&' instead of '?'.
       */
      apiUrl: function (p) {
        if (this.projects.length <= 1 || !this.activeProject) return p;
        var sep = p.indexOf('?') === -1 ? '?' : '&';
        return p + sep + 'project=' + this.activeProject.slug;
      },

      // =========================================================================
      // Filtered list methods (called as functions in Alpine x-for / x-text)
      // =========================================================================

      filteredRequirements() {
        var self = this;
        var list = this.requirements.slice();
        var q = this.reqSearch ? this.reqSearch.toLowerCase().trim() : '';

        if (q) {
          list = list.filter(function (r) {
            return (
              r.id.toLowerCase().indexOf(q) !== -1 ||
              r.title.toLowerCase().indexOf(q) !== -1 ||
              (r.tags || []).some(function (t) { return t.toLowerCase().indexOf(q) !== -1; })
            );
          });
        }
        if (this.reqStatusFilter !== 'all') {
          list = list.filter(function (r) { return r.status === self.reqStatusFilter; });
        }
        if (this.reqPriorityFilter !== 'all') {
          list = list.filter(function (r) { return r.priority === self.reqPriorityFilter; });
        }
        if (this.reqComponentFilter !== 'all') {
          list = list.filter(function (r) {
            return (r.components || []).indexOf(self.reqComponentFilter) !== -1;
          });
        }

        // Sort
        var priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        var self2 = this;
        list.sort(function (a, b) {
          if (self2.reqSortBy === 'priority') {
            return ((priorityOrder[a.priority] !== undefined ? priorityOrder[a.priority] : 9) -
                    (priorityOrder[b.priority] !== undefined ? priorityOrder[b.priority] : 9));
          }
          if (self2.reqSortBy === 'status') {
            return self2._reqCoverageKey(a).localeCompare(self2._reqCoverageKey(b));
          }
          return a.id.localeCompare(b.id);
        });

        return list;
      },

      filteredStories() {
        var self = this;
        return this.stories.filter(function (s) {
          if (self.storyStatusFilter !== 'all' && s.status !== self.storyStatusFilter) return false;
          if (self.storySearch) {
            var q = self.storySearch.toLowerCase();
            return (
              s.id.toLowerCase().indexOf(q) !== -1 ||
              s.title.toLowerCase().indexOf(q) !== -1
            );
          }
          return true;
        });
      },

      filteredVcs() {
        var self = this;
        return this.vcsRefs.filter(function (v) {
          if (self.vcsKindFilter !== 'all' && v.kind !== self.vcsKindFilter) return false;
          if (self.vcsStateFilter !== 'all' && v.state !== self.vcsStateFilter) return false;
          return true;
        });
      },

      // =========================================================================
      // Component filter options
      // =========================================================================

      reqComponentOptions() {
        var all = [];
        this.requirements.forEach(function (r) {
          (r.components || []).forEach(function (c) {
            if (all.indexOf(c) === -1) all.push(c);
          });
        });
        return all.sort();
      },

      // =========================================================================
      // Coverage lookups
      // =========================================================================

      reqCoverage(req) {
        if (!this.coverage || !this.coverage.requirements) return null;
        for (var i = 0; i < this.coverage.requirements.length; i++) {
          if (this.coverage.requirements[i].id === req.id) return this.coverage.requirements[i];
        }
        return null;
      },

      storyCoverage(story) {
        if (!this.coverage || !this.coverage.stories) return null;
        for (var i = 0; i < this.coverage.stories.length; i++) {
          if (this.coverage.stories[i].id === story.id) return this.coverage.stories[i];
        }
        return null;
      },

      _reqCoverageKey(req) {
        var rc = this.reqCoverage(req);
        if (!rc) return 'c_none';
        if (rc.verified) return 'a_verified';
        if (rc.hasStory) return 'b_hasStory';
        return 'c_none';
      },

      // =========================================================================
      // Badge helpers
      // =========================================================================

      reqStatusBadge(req) {
        var rc = this.reqCoverage(req);
        if (!rc) return { cls: 'badge-slate', icon: '–', label: '–' };
        if (rc.verified) return { cls: 'badge-green', icon: '✓', label: 'verified' };
        if (rc.hasStory) return { cls: 'badge-amber', icon: '~', label: 'has story' };
        return { cls: 'badge-red', icon: '✗', label: 'no story' };
      },

      priorityBadge(p) {
        var map = { critical: 'badge-red', high: 'badge-amber', medium: 'badge-blue', low: 'badge-slate' };
        return map[p] || 'badge-slate';
      },

      storyStatusBadge(s) {
        var map = { draft: 'badge-slate', ready: 'badge-blue', in_progress: 'badge-amber', done: 'badge-green' };
        return map[s] || 'badge-slate';
      },

      vcsBadge(state) {
        if (state === 'merged') return 'badge-green';
        if (state === 'opened') return 'badge-blue';
        return 'badge-slate';
      },

      phaseBadge(status) {
        if (status === 'active' || status === 'completed') return 'badge-green';
        return 'badge-slate';
      },

      coverageBadge(sc) {
        if (!sc) return 'badge-slate';
        if (sc.covered && sc.tested) return 'badge-green';
        if (sc.tested) return 'badge-amber';
        return 'badge-slate';
      },

      coverageLabel(sc) {
        if (!sc) return 'not tracked';
        if (sc.covered && sc.tested) return 'covered';
        if (sc.tested) return 'tested';
        return 'not tested';
      },

      // =========================================================================
      // UI helpers
      // =========================================================================

      /** Return a number from the summary object, defaulting to 0. */
      summaryVal(key) {
        if (!this.summary) return 0;
        var v = this.summary[key];
        return (v !== undefined && v !== null) ? v : 0;
      },

      /** Format a percentage value (number) to one decimal place. */
      pct(v) {
        if (typeof v !== 'number') return '0.0';
        return v.toFixed(1);
      },

      globalTotalReqs: function() {
        return this.globalSummary.reduce(function(s, p) { return s + (p.requirements || 0); }, 0);
      },
      globalTotalStories: function() {
        return this.globalSummary.reduce(function(s, p) { return s + (p.stories || 0); }, 0);
      },
      globalWeightedPct: function(field) {
        var totalReqs = this.globalTotalReqs();
        if (totalReqs === 0) return 0;
        return this.globalSummary.reduce(function(s, p) {
          return s + ((p[field] || 0) * (p.requirements || 0));
        }, 0) / totalReqs;
      },

      activePhaseLabel() {
        if (!this.summary || !this.summary.activePhase) return null;
        var id = this.summary.activePhase;
        for (var i = 0; i < this.phases.length; i++) {
          if (this.phases[i].id === id) return this.phases[i].name || id;
        }
        return id;
      },

      componentName(id) {
        for (var i = 0; i < this.components.length; i++) {
          if (this.components[i].id === id) return this.components[i].name || id;
        }
        return id;
      },

      reqCountForComponent(componentId) {
        var count = 0;
        this.requirements.forEach(function (r) {
          if ((r.components || []).indexOf(componentId) !== -1) count++;
        });
        return count;
      },

      toggleReq(id) {
        this.reqExpanded = (this.reqExpanded === id) ? null : id;
      },

      toggleStory(id) {
        this.storyExpanded = (this.storyExpanded === id) ? null : id;
      },

      sortReqBy(col) {
        this.reqSortBy = col;
      },

      // =========================================================================
      // Chart initialisation
      // =========================================================================

      initTrendChart(canvas) {
        var self = this;
        if (!canvas || typeof Chart === 'undefined') return;
        // Destroy any stale instance so the new canvas gets a fresh Chart.js context
        // (x-if can recycle the canvas reference while _trendChart still holds the old one).
        if (self._trendChart) { self._trendChart.destroy(); self._trendChart = null; }
        var ctx = canvas.getContext('2d');

        self._trendChart = new Chart(ctx, {
          type: 'line',
          data: {
            labels: [],
            datasets: [
              {
                label: 'Verified %',
                data: [],
                borderColor: '#16a34a',
                backgroundColor: 'rgba(22,163,74,0.08)',
                tension: 0.4,
                fill: true,
                pointRadius: 4,
                pointHoverRadius: 6,
              },
              {
                label: 'Story Coverage %',
                data: [],
                borderColor: '#4f46e5',
                backgroundColor: 'rgba(79,70,229,0.07)',
                tension: 0.4,
                fill: true,
                pointRadius: 4,
                pointHoverRadius: 6,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
              y: {
                min: 0, max: 100,
                ticks: { callback: function (v) { return v + '%'; }, font: { size: 11 } },
                grid: { color: 'rgba(0,0,0,0.04)' },
              },
              x: { ticks: { font: { size: 11 } }, grid: { display: false } },
            },
            plugins: {
              legend: {
                position: 'bottom',
                labels: { font: { size: 12 }, usePointStyle: true },
              },
              tooltip: {
                callbacks: {
                  label: function (ctx) {
                    return ' ' + ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(1) + '%';
                  },
                },
              },
            },
          },
        });

        function applyTrend(data) {
          if (!data || !self._trendChart) return;
          self._trendChart.data.labels = data.map(function (p) { return p.phaseName || p.phase; });
          self._trendChart.data.datasets[0].data = data.map(function (p) {
            return p.summary ? Number((p.summary.verifiedPct || 0).toFixed(1)) : 0;
          });
          self._trendChart.data.datasets[1].data = data.map(function (p) {
            return p.summary ? Number((p.summary.storyCoveragePct || 0).toFixed(1)) : 0;
          });
          self._trendChart.update('none');
        }

        this.$watch('trend', applyTrend);
        if (this.trend) applyTrend(this.trend);
      },

      initDonutChart(canvas) {
        var self = this;
        if (!canvas || typeof Chart === 'undefined') return;
        // Same as trendChart: destroy any stale instance before re-init.
        if (self._donutChart) { self._donutChart.destroy(); self._donutChart = null; }
        var ctx = canvas.getContext('2d');

        var COLORS = [
          '#16a34a', '#4f46e5', '#f59e0b', '#ef4444',
          '#06b6d4', '#8b5cf6', '#ec4899', '#14b8a6',
          '#f97316', '#84cc16',
        ];

        self._donutChart = new Chart(ctx, {
          type: 'doughnut',
          data: {
            labels: [],
            datasets: [{
              data: [],
              backgroundColor: [],
              borderWidth: 2,
              borderColor: '#fff',
              hoverOffset: 6,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '65%',
            plugins: {
              legend: {
                position: 'right',
                labels: { font: { size: 11 }, usePointStyle: true, padding: 10 },
              },
              tooltip: {
                callbacks: {
                  label: function (ctx) {
                    return ' ' + ctx.label + ': ' + ctx.raw + '% verified';
                  },
                },
              },
            },
          },
        });

        function applyDonut(data) {
          if (!data || !self._donutChart) return;
          var by = data.byComponent || [];
          self._donutChart.data.labels = by.map(function (c) { return c.component; });
          self._donutChart.data.datasets[0].data = by.map(function (c) {
            return Number((c.verifiedPct || 0).toFixed(1));
          });
          self._donutChart.data.datasets[0].backgroundColor = by.map(function (_, i) {
            return COLORS[i % COLORS.length];
          });
          self._donutChart.update('none');
        }

        this.$watch('coverage', applyDonut);
        if (this.coverage) applyDonut(this.coverage);
      },

      // =========================================================================
      // Export / Import
      // =========================================================================

      exportProject: function() {
        var url = this.apiUrl('/api/export');
        var slug = this.activeProject ? this.activeProject.slug : 'requ';
        var a = document.createElement('a');
        a.href = url;
        a.download = slug + '-export.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      },

      importFile: function(event) {
        var self = this;
        var file = event.target.files[0];
        if (!file) return;
        if (!file.name.endsWith('.json')) {
          this.importResult = { errors: ['Please select a .json file exported from requ.'] };
          return;
        }
        self.importing = true;
        self.importResult = null;
        var inputEl = event.target;
        var reader = new FileReader();
        reader.onload = function(e) {
          var text = e.target.result;
          inputEl.value = ''; // reset so re-selecting same file fires @change again
          fetch(self.apiUrl('/api/import'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: text,
          })
          .then(function(res) {
            return res.json().then(function(data) {
              // jsonError shape is { error: "..." }; normalize to ImportReport shape
              if (!res.ok) {
                return { imported: {}, skipped: {}, errors: [data.error || 'Import failed (HTTP ' + res.status + ')'] };
              }
              return data;
            });
          })
          .then(function(data) {
            self.importing = false;
            self.importResult = data;
            // Reload all data to reflect imported content
            self.loadSummary();
            self.loadRequirements();
            self.loadStories();
            self.loadComponents();
            self.loadPhases();
          })
          .catch(function(err) {
            self.importing = false;
            self.importResult = { errors: [String(err)] };
          });
        };
        reader.readAsText(file);
      },

      importResultSummary: function() {
        var r = this.importResult;
        if (!r) return '';
        var parts = [];
        var imp = r.imported || {};
        var skip = r.skipped || {};
        var total = 0;
        Object.keys(imp).forEach(function(k) { total += imp[k]; });
        if (total > 0) parts.push('Imported ' + total + ' record' + (total !== 1 ? 's' : ''));
        var skipTotal = 0;
        Object.keys(skip).forEach(function(k) { skipTotal += skip[k].length; });
        if (skipTotal > 0) parts.push(skipTotal + ' skipped (already exist)');
        if (r.errors && r.errors.length > 0) parts.push(r.errors.length + ' error' + (r.errors.length !== 1 ? 's' : '') + ': ' + r.errors[0]);
        return parts.length ? parts.join('. ') + '.' : 'Nothing to import.';
      },

      // =========================================================================
      // Init from web UI
      // =========================================================================

      submitInit: function() {
        var self = this;
        if (self.setupSubmitting) return;
        self.setupSubmitting = true;
        self.setupError = null;
        var body = {};
        if (self.setupName) body.name = self.setupName;
        if (self.setupKey) body.key = self.setupKey;
        if (self.setupBrief) body.brief = self.setupBrief;
        if (self.setupPhase) body.initialPhase = self.setupPhase;
        fetch(self.apiUrl('/api/init'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        .then(function(res) {
          return res.json().then(function(data) {
            if (!res.ok) {
              return Promise.reject(data.error || ('Initialization failed (HTTP ' + res.status + ')'));
            }
            return data;
          });
        })
        .then(function() {
          self.setupSubmitting = false;
          return Promise.all([
            self.loadConfig(),
            self.loadSummary(),
            self.loadRequirements(),
            self.loadStories(),
            self.loadComponents(),
            self.loadPhases(),
            self.loadVcsRefs(),
            self.loadCoverage(),
            self.loadTrend(),
            self.loadGaps(),
          ]);
        })
        .catch(function(err) {
          self.setupSubmitting = false;
          self.setupError = String(err);
        });
      },

      // =========================================================================
      // Brief inline edit
      // =========================================================================

      saveBrief: function() {
        var self = this;
        if (self.briefSaving) return;
        self.briefSaving = true;
        self.briefError = null;
        fetch(self.apiUrl('/api/config'), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ brief: self.briefDraft }),
        })
        .then(function(res) {
          return res.json().then(function(data) {
            if (!res.ok) return Promise.reject(data.error || ('Save failed (HTTP ' + res.status + ')'));
            return data;
          });
        })
        .then(function(data) {
          self.briefSaving = false;
          self.briefEditing = false;
          self.config = data;
        })
        .catch(function(err) {
          self.briefSaving = false;
          self.briefError = String(err);
        });
      },

      renderMarkdown: function(text) {
        if (!text) return '';
        if (window.marked) {
          return window.marked.parse(text);
        }
        // safe plain-text fallback
        return text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\n/g, '<br>');
      },

    }; // end return
  }); // end Alpine.data
}); // end addEventListener
