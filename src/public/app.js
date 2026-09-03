/* requ — Alpine.js dashboard component
 * Matches index.html exactly. All method names / property names are canonical here.
 * global Chart, Alpine
 */
document.addEventListener('alpine:init', function () {
  // Non-reactive registry for Chart.js instances. Storing a Chart on the Alpine
  // component proxies the entire instance through Alpine reactivity; Chart.js'
  // own deep internal mutations then recurse through the proxy, producing
  // "Maximum call stack size exceeded" and corrupting its layout object
  // ("Cannot set properties of undefined (setting 'fullSize')"). Keeping the
  // instances in this closure variable keeps them raw and non-reactive.
  var CHARTS = { trend: null, donut: null };

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
        global: false, screens: false, adrs: false,
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
      screens: [],
      uiCoverage: null,
      adrs: [],

      // ── Screens (UI specs) ───────────────────────────────────────────────────
      screenSearch: '',
      screenPlatformFilter: 'all',
      screenStatusFilter: 'all',
      screenStaleOnly: false,
      screenDetailOpen: false,
      screenDetail: null,
      screenHtml: '',
      screenHighlight: true,

      // ── Requirement filters ──────────────────────────────────────────────────
      reqSearch: '',
      reqStatusFilter: 'all',
      reqPriorityFilter: 'all',
      reqComponentFilter: 'all',
      reqPhaseFilter: 'all',
      reqExpanded: null,
      reqSortBy: 'id',

      // ── Story filters ────────────────────────────────────────────────────────
      storySearch: '',
      storyStatusFilter: 'all',
      storyPhaseFilter: 'all',
      storyExpanded: null,

      // ── Story detail modal ───────────────────────────────────────────────────
      storyDetailOpen: false,
      storyDetail: null,
      storyDetailLoading: false,

      // ── Allure report status (per active project) ────────────────────────────
      allureStatus: { available: false, url: '/allure/' },

      // ── Decisions (ADRs) ─────────────────────────────────────────────────────
      adrSearch: '',
      adrStatusFilter: 'all',
      adrDetailOpen: false,
      adrDetail: null,
      adrHtml: '',
      adrLoading: false,

      // ── VCS filters ──────────────────────────────────────────────────────────
      vcsKindFilter: 'all',
      vcsStateFilter: 'all',

      // ── Scenarios ────────────────────────────────────────────────────────────
      scenarios: [],
      scenariosTotal: 0,
      scenariosPage: 1,
      scenariosPageSize: 25,
      scenariosSearch: '',
      scenariosTag: '',
      // Phase scope for the Scenarios tab. '' = every scenario, whatever phase.
      // A scenario belongs to a phase through the stories it is tagged to, so
      // `scenariosMode` decides whether earlier phases count (cumulative) or
      // only the selected one (strict) — same semantics as the Coverage tab.
      scenariosPhase: '',
      scenariosMode: 'cumulative',
      scenariosLoading: false,
      scenariosExpanded: null,
      scenariosNote: '',
      scenariosExecuting: false,

      // ── Coverage controls ────────────────────────────────────────────────────
      coveragePhase: null,
      coverageMode: 'cumulative',
      showStoriesDetail: false,

      // ── Scenario viewer (gherkin) ─────────────────────────────────────────────
      /** testKey of the currently-open scenario, or null. */
      scenarioOpenId: null,
      /** Cache keyed by scenario testKey → { state, html, valid }. */
      scenarioContent: {},
      /** Tag-expression filter (cucumber syntax) and the resolved match set. */
      scenarioTagFilter: '',
      scenarioTagMatchIds: null,
      scenarioTagError: '',

      // ── Coverage Trend chart controls ────────────────────────────────────────
      // Independent from coverageMode (which drives the Coverage tab): the trend
      // chart on the Overview tab has its own strict/cumulative toggle. Defaults
      // to 'cumulative' since it is more representative of real project progress
      // at a glance; 'strict' remains available for a rigorous per-phase view.
      trendMode: 'cumulative',

      // ── Charts ───────────────────────────────────────────────────────────────
      // NOTE: live Chart.js instances live in the non-reactive CHARTS closure
      // object (see top of alpine:init), NOT on this reactive component — that
      // is what prevents the reactivity-recursion crashes.
      // $watch must be registered exactly once per chart, regardless of how many
      // times x-if recycles the canvas / re-fires x-init. Stacking watchers is
      // what produced the "Maximum call stack size exceeded" cascades.
      _trendWatched: false,
      _donutWatched: false,

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
      briefExpanded: false,
      briefOverflows: false,

      // ── Server version ─────────────────────────────────────────────────────────
      appVersion: '',

      // ── Specification versions (baselines) ────────────────────────────────────
      // `activeVersion` is what every tab reads through: apiUrl() appends it to
      // each request, so switching it re-scopes the whole dashboard at once.
      versions: [],
      versionMeta: { currentVersion: null, draftVersion: null },
      activeVersion: '',
      versionsLoading: false,
      diffFrom: '',
      diffTo: '',
      diff: null,
      diffLoading: false,
      diffError: '',

      // =========================================================================
      // Lifecycle
      // =========================================================================

      async init() {
        var vd = await this._fetch('/api/version');
        if (vd && vd.version) this.appVersion = vd.version;
        await this.loadProjects();
        if (this.projects.length > 1) { this.tab = 'global'; }
        await this.loadVersions();
        await this.loadConfig();
        await this.loadSummary();
        this.setupSSE();
        var loaders = [
          this.loadRequirements(),
          this.loadStories(),
          this.loadComponents(),
          this.loadPhases(),
          this.loadVcsRefs(),
          this.loadAdrs(),
          this.loadCoverage(),
          this.loadTrend(),
          this.loadGaps(),
          this.loadAllureStatus(),
        ];
        if (this.projects.length > 1) loaders.push(this.loadGlobalSummary());
        await Promise.all(loaders);

        this.$watch('scenariosSearch', function () { this.scenariosPage = 1; this.loadScenarios(); }.bind(this));
        this.$watch('scenariosTag',    function () { this.scenariosPage = 1; this.loadScenarios(); }.bind(this));
        this.$watch('scenariosPhase',  function () { this.scenariosPage = 1; this.loadScenarios(); }.bind(this));
        this.$watch('scenariosMode',   function () { this.scenariosPage = 1; this.loadScenarios(); }.bind(this));

        // Coverage phase/mode require a server round-trip (unlike the client-side
        // requirement/story filters), so re-fetch whenever either selection changes.
        var self = this;
        this.$watch('coveragePhase', function () { self.refreshCoverage(); });
        this.$watch('coverageMode', function () { self.refreshCoverage(); });
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

      // =========================================================================
      // Specification versions
      // =========================================================================

      async loadVersions() {
        this.versionsLoading = true;
        // Read the registry unscoped: apiUrl() would otherwise pin the request
        // to the version being listed, which is circular.
        var p = '/api/versions';
        if (this.projects.length > 1 && this.activeProject) p += '?project=' + this.activeProject.slug;
        var d = await this._fetch(p);
        if (d) {
          this.versions = d.versions || [];
          this.versionMeta = { currentVersion: d.currentVersion, draftVersion: d.draftVersion };
          if (!this.activeVersion) {
            this.activeVersion = d.currentVersion || d.draftVersion ||
              (this.versions.length ? this.versions[this.versions.length - 1].version : '');
          }
          if (!this.diffTo && this.versions.length > 1) {
            var pair = this.defaultDiffPair();
            this.diffFrom = pair.from;
            this.diffTo   = pair.to;
          }
        }
        this.versionsLoading = false;
      },

      /** Re-read every tab through another baseline. */
      async switchVersion(version) {
        if (!version || version === this.activeVersion) return;
        this.activeVersion = version;
        await Promise.all([
          this.loadConfig(),
          this.loadSummary(),
          this.loadRequirements(),
          this.loadStories(),
          this.loadComponents(),
          this.loadPhases(),
          this.loadAdrs(),
          this.loadCoverage(),
          this.loadTrend(),
          this.loadGaps(),
        ]);
        if (this.tab === 'scenarios') this.loadScenarios();
        if (this.tab === 'screens') this.loadScreens();
      },

      /** Default comparison: the previous baseline against the newest one. */
      defaultDiffPair() {
        if (this.versions.length < 2) return { from: '', to: '' };
        return {
          from: this.versions[this.versions.length - 2].version,
          to:   this.versions[this.versions.length - 1].version,
        };
      },

      diffIsPristine() {
        var d = this.defaultDiffPair();
        return !this.diff && !this.diffError &&
          this.diffFrom === d.from && this.diffTo === d.to;
      },

      /** Clear the result and put both selects back to the default pair. */
      resetDiff() {
        var d = this.defaultDiffPair();
        this.diffFrom = d.from;
        this.diffTo = d.to;
        this.diff = null;
        this.diffError = '';
        this.diffLoading = false;
      },

      async loadDiff() {
        if (!this.diffFrom || !this.diffTo || this.diffFrom === this.diffTo) return;
        this.diffLoading = true;
        this.diffError = '';
        this.diff = null;
        var p = '/api/versions/diff?from=' + encodeURIComponent(this.diffFrom) + '&to=' + encodeURIComponent(this.diffTo);
        if (this.projects.length > 1 && this.activeProject) p += '&project=' + this.activeProject.slug;
        try {
          var res = await window.fetch(p);
          var body = await res.json();
          if (!res.ok) { this.diffError = body && body.error ? body.error : 'Comparison failed'; }
          else { this.diff = body; }
        } catch (e) {
          this.diffError = String(e);
        }
        this.diffLoading = false;
      },

      /** Entity types with at least one difference, so an unchanged type is hidden. */
      diffEntityNames() {
        if (!this.diff) return [];
        var sum = this.diff.summary || {};
        return Object.keys(sum).filter(function (k) {
          return sum[k].added > 0 || sum[k].removed > 0 || sum[k].modified > 0;
        });
      },

      diffIsIdentical() {
        return this.diffEntityNames().length === 0;
      },

      /** One-line rendering of a field value for the diff list. */
      brief(v) {
        if (v === undefined || v === null) return '∅';
        var s = typeof v === 'string' ? v : JSON.stringify(v);
        s = s.replace(/\s+/g, ' ').trim();
        return s.length > 80 ? s.slice(0, 80) + '…' : (s || '∅');
      },

      shortDate(iso) {
        if (!iso) return '—';
        var d = new Date(iso);
        return isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
      },

      async switchProject(slug) {
        var self = this;
        var found = this.projects.find(function (p) { return p.slug === slug; });
        if (!found || found === this.activeProject) return;
        this.activeProject = found;
        // Reset the phase filter so it is re-derived from the new project's
        // active phase (set by loadSummary). Without this reset, a phase id
        // from the previous project (e.g. P14) would be passed to
        // loadCoverage() for the new project, returning 0 passing scenarios
        // because that phase does not exist in the new project.
        this.coveragePhase = null;
        // Same for the Scenarios tab: a phase id from the previous project would
        // match nothing here and silently empty the list.
        this.scenariosPhase = '';
        // Reconnect SSE for the new project.
        if (this._sse) { this._sse.close(); this._sse = null; }
        this.setupSSE();
        // Load config + summary first so that coveragePhase is set to the new
        // project's activePhase before loadCoverage() reads it.
        this.activeVersion = '';
        this.versions = [];
        this.diff = null;
        await this.loadVersions();
        await Promise.all([self.loadConfig(), self.loadSummary()]);
        // Now load the remaining data in parallel using the correct coveragePhase.
        await Promise.all([
          self.loadRequirements(),
          self.loadStories(),
          self.loadComponents(),
          self.loadPhases(),
          self.loadVcsRefs(),
          self.loadCoverage(),
          self.loadTrend(),
          self.loadGaps(),
          self.loadAllureStatus(),
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

      async loadAllureStatus() {
        var d = await this._fetch(this.apiUrl('/api/allure-status'));
        if (d && typeof d === 'object') {
          this.allureStatus = { available: !!d.available, url: d.url || '/allure/' };
        } else {
          this.allureStatus = { available: false, url: '/allure/' };
        }
      },

      async loadPhases() {
        this.loading.phases = true;
        var d = await this._fetch(this.apiUrl('/api/phases'));
        if (d) this.phases = d;
        this.loading.phases = false;
        this.syncCoveragePhaseSelect();
      },

      /**
       * Re-assert the Coverage phase <select> against `coveragePhase`.
       *
       * The options come from `phases` via x-for, but `coveragePhase` is set
       * earlier — loadSummary() seeds it from the project's active phase before
       * /api/phases has answered. At that moment the only option in the DOM is
       * "All phases", so the browser silently drops the assignment and the
       * control reads "All phases" while the data below it is phase-filtered.
       * Alpine never re-runs x-model just because x-for added options, so the
       * value has to be re-applied once they exist.
       *
       * Also drops a phase id this project does not have (e.g. left over from
       * the previously selected project), which would otherwise filter
       * everything down to zero against a phase that cannot match.
       */
      syncCoveragePhaseSelect() {
        var want = this.coveragePhase;
        if (want && !this.phases.some(function (p) { return p.id === want; })) {
          this.coveragePhase = null;
          return;
        }
        var self = this;
        this.$nextTick(function () {
          var el = document.getElementById('coverage-phase');
          if (el && el.value !== (self.coveragePhase || '')) el.value = self.coveragePhase || '';
        });
      },

      async loadVcsRefs() {
        this.loading.vcs = true;
        var d = await this._fetch(this.apiUrl('/api/vcs'));
        if (d) this.vcsRefs = d;
        this.loading.vcs = false;
      },

      async loadCoverage() {
        this.loading.coverage = true;
        // Always send phase= (empty => "All phases"), else the server defaults to the active phase.
        var phase = '&phase=' + encodeURIComponent(this.coveragePhase || '');
        var d = await this._fetch(this.apiUrl('/api/coverage?mode=' + this.coverageMode + phase));
        if (d) this.coverage = d;
        this.loading.coverage = false;
      },

      async loadTrend() {
        this.loading.trend = true;
        var d = await this._fetch(this.apiUrl('/api/coverage/trend?mode=' + this.trendMode));
        if (d) this.trend = d;
        this.loading.trend = false;
      },

      /**
       * Switch the Coverage Trend chart between 'strict' (each phase counts
       * only scenarios explicitly attached to it) and 'cumulative' (inherits
       * scenarios from prior phases). Persists for the session and re-applies
       * on every subsequent refresh/re-render (SSE updates, project switch, etc.)
       * because loadTrend() always reads the current trendMode.
       */
      setTrendMode(mode) {
        if (this.trendMode === mode) return;
        this.trendMode = mode;
        this.loadTrend();
      },

      async loadGaps() {
        this.loading.gaps = true;
        // Always send phase= (empty => "All phases"), else the server defaults to the active phase.
        var phase = '&phase=' + encodeURIComponent(this.coveragePhase || '');
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
                // The event stream is not version-scoped, so it always describes
                // the project's current version. Adopting it while another
                // baseline is selected would make the header contradict the tab
                // below it; re-read the scoped summary instead.
                if (self.activeVersion &&
                    self.activeVersion !== self.versionMeta.currentVersion) {
                  self.loadSummary();
                } else {
                  self.summary = d;
                }
                self.notInitialized = false;
                if (self.tab === 'global') { self.loadGlobalSummary(); }
                if (!prev || d.requirements !== prev.requirements) self.loadRequirements();
                if (!prev || d.stories !== prev.stories) self.loadStories();
                if (!prev || d.components !== prev.components) self.loadComponents();
                if (!prev || d.phases !== prev.phases) self.loadPhases();
                if (!prev || d.vcsRefs !== prev.vcsRefs) self.loadVcsRefs();
                if (!prev || d.adrs !== prev.adrs) self.loadAdrs();
                var coverageChanged = !prev ||
                  d.verifiedPct !== prev.verifiedPct ||
                  d.verifiedPctCumulative !== prev.verifiedPctCumulative ||
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
      // Screens (UI specifications)
      // =========================================================================

      /** Screens + the UI consistency checks, both scoped to the active project. */
      loadScreens: async function () {
        this.loading.screens = true;
        try {
          var self = this;
          var results = await Promise.all([
            fetch(this.apiUrl('/api/screens')).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
            fetch(this.apiUrl('/api/ui-coverage')).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
          ]);
          self.screens = (results[0] && results[0].screens) || [];
          self.uiCoverage = results[1];
        } finally {
          this.loading.screens = false;
        }
      },

      filteredScreens: function () {
        var self = this;
        var q = this.screenSearch.trim().toLowerCase();
        return this.screens.filter(function (sc) {
          if (self.screenPlatformFilter !== 'all' && sc.platform !== self.screenPlatformFilter) return false;
          if (self.screenStatusFilter !== 'all' && sc.status !== self.screenStatusFilter) return false;
          if (self.screenStaleOnly && !sc.stale) return false;
          if (q && (sc.id + ' ' + sc.name + ' ' + (sc.description || '')).toLowerCase().indexOf(q) === -1) return false;
          return true;
        });
      },

      screenStatusBadge: function (status) {
        if (status === 'validated_ops') return 'badge-green';
        if (status === 'reviewed_qa')   return 'badge-blue';
        if (status === 'obsolete')      return 'badge-slate';
        return 'badge-amber';
      },

      /** Issues raised for one screen by the UI consistency checks. */
      issuesForScreen: function (id) {
        if (!this.uiCoverage) return [];
        return (this.uiCoverage.issues || []).filter(function (i) { return i.screen === id; });
      },

      async loadAdrs() {
        this.loading.adrs = true;
        var d = await this._fetch(this.apiUrl('/api/adrs'));
        if (d) this.adrs = d.adrs || [];
        this.loading.adrs = false;
      },

      filteredAdrs() {
        var self = this;
        var q = (this.adrSearch || '').toLowerCase();
        return this.adrs.filter(function (a) {
          if (self.adrStatusFilter !== 'all' && a.status !== self.adrStatusFilter) return false;
          if (q && (a.id + '\n' + a.title).toLowerCase().indexOf(q) === -1) return false;
          return true;
        });
      },

      adrBadge: function (status) {
        if (status === 'accepted')   return 'badge-green';
        if (status === 'superseded') return 'badge-slate';
        return 'badge-amber';
      },

      /**
       * Open the decision reader. Unlike the mockup viewer this renders in the
       * page rather than a sandboxed iframe: mermaid needs scripts to draw, and
       * `sandbox=""` forbids them. The markdown is sanitized before insertion,
       * then mermaid draws the fenced diagrams in place.
       */
      openAdr: async function (id) {
        this.adrDetailOpen = true;
        this.adrDetail = null;
        this.adrHtml = '';
        this.adrLoading = true;
        try {
          this.adrDetail = await fetch(this.apiUrl('/api/adrs/' + encodeURIComponent(id)))
            .then(function (r) { return r.ok ? r.json() : null; });
          var md = await fetch(this.apiUrl('/api/adrs/' + encodeURIComponent(id) + '/content'))
            .then(function (r) { return r.ok ? r.text() : ''; });
          this.adrHtml = this.renderMarkdownWithDiagrams(md);
        } catch (e) {
          this.adrHtml = '';
        }
        this.adrLoading = false;
        this.runMermaid();
      },

      closeAdr: function () {
        this.adrDetailOpen = false;
        this.adrDetail = null;
        this.adrHtml = '';
      },

      /**
       * Markdown → sanitized HTML, with ```mermaid fences turned into
       * <pre class="mermaid"> blocks for runMermaid() to draw. The fence bodies
       * are held back from the sanitizer and re-inserted as text afterwards, so
       * diagram source survives intact without widening what HTML is allowed.
       */
      renderMarkdownWithDiagrams: function (md) {
        if (!md) return '';
        var blocks = [];
        var stripped = md.replace(/```mermaid\r?\n([\s\S]*?)```/g, function (_m, body) {
          blocks.push(body);
          return '\n\nREQU_MERMAID_' + (blocks.length - 1) + '_END\n\n';
        });
        var html = this.renderMarkdown(stripped);
        if (window.DOMPurify) html = window.DOMPurify.sanitize(html);
        return html.replace(/REQU_MERMAID_(\d+)_END/g, function (_m, i) {
          var src = blocks[Number(i)] || '';
          var escaped = src
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
          return '<pre class="mermaid">' + escaped + '</pre>';
        });
      },

      /**
       * Draw any mermaid blocks now in the DOM. mermaid is an ES module loaded
       * from a CDN, so it can still be in flight when a decision is opened —
       * retry on a bounded schedule rather than leaving the diagrams as text
       * forever (same bounded-retry shape as initTrendChart). Until it lands the
       * fence is displayed as readable source, so nothing is lost either way.
       */
      runMermaid: function (attempt) {
        var self = this;
        var tries = attempt || 0;
        this.$nextTick(function () {
          var nodes = document.querySelectorAll('.adr-content pre.mermaid:not([data-processed])');
          if (!nodes.length) return;
          if (!window.mermaid) {
            if (tries < 20) setTimeout(function () { self.runMermaid(tries + 1); }, 150);
            return;
          }
          try {
            window.mermaid.run({ nodes: Array.prototype.slice.call(nodes) });
          } catch (e) {
            /* a malformed diagram must not take the reader down */
          }
        });
      },

      /**
       * Open the mockup viewer. The HTML is fetched and rendered inside a fully
       * sandboxed iframe via srcdoc (no scripts, no same-origin) — requ renders
       * mockups, it never executes them.
       */
      openScreen: async function (id) {
        this.screenDetailOpen = true;
        this.screenDetail = null;
        this.screenHtml = '';
        try {
          var detail = await fetch(this.apiUrl('/api/screens/' + encodeURIComponent(id))).then(function (r) { return r.ok ? r.json() : null; });
          this.screenDetail = detail;
          var html = await fetch(this.apiUrl('/api/screens/' + encodeURIComponent(id) + '/html')).then(function (r) { return r.ok ? r.text() : ''; });
          this.screenHtml = html;
        } catch (e) {
          this.screenHtml = '';
        }
      },

      closeScreen: function () {
        this.screenDetailOpen = false;
        this.screenDetail = null;
        this.screenHtml = '';
      },

      /**
       * The mockup as rendered in the viewer. Highlighting is pure CSS appended to
       * the document (traced elements outlined and labelled with their
       * `data-req-el`, untraced ones flagged red), so nothing script-based ever
       * runs inside the frame.
       */
      screenSrcdoc: function () {
        if (!this.screenHtml) return '';
        if (!this.screenHighlight) return this.screenHtml;
        // Ids show on hover so the labels never cover the mockup; only untraced
        // elements (the ones the checks flag) are labelled permanently.
        var css = [
          '<style id="requ-highlight">',
          '[data-req-el]{outline:2px dashed #6366f1!important;outline-offset:2px;position:relative!important;}',
          '[data-req-el]:hover::after,[data-req-el]:not([data-req-stories])::after{',
          'content:attr(data-req-el);position:absolute;top:-9px;left:0;z-index:2147483647;',
          'background:#4f46e5;color:#fff;font:600 9px/1.4 ui-monospace,monospace;padding:1px 4px;border-radius:3px;',
          'pointer-events:none;white-space:nowrap;}',
          '[data-req-el]:not([data-req-stories]){outline-color:#ef4444!important;}',
          '[data-req-el]:not([data-req-stories])::after{background:#dc2626;content:attr(data-req-el) " · no story";}',
          '</style>',
        ].join('');
        return this.screenHtml + css;
      },

      /** Jump from a screen to one of the stories it materializes. */
      goToStory: function (storyId) {
        this.closeScreen();
        this.storySearch = storyId;
        this.navTo('stories');
      },

      // =========================================================================
      // Tab navigation
      // =========================================================================

      navTo(id) {
        this.tab = id;
        if (id === 'global')     { this.loadGlobalSummary(); }
        if (id === 'scenarios')  { this.loadScenarios(); }
        if (id === 'screens')    { this.loadScreens(); }
        if (id === 'adrs')       { this.loadAdrs(); }
        if (id === 'versions')   { this.loadVersions(); }
        // The Overview canvases use x-show (not x-if), so their x-init only ever
        // fires once at page load. If the 'overview' tab wasn't the active tab at
        // that moment (e.g. multi-project installs default to 'global' — see
        // init()), the canvases were 0×0 and initTrendChart/initDonutChart gave
        // up after their bounded retry, leaving CHARTS.trend/donut permanently
        // null. Re-invoking here — now that x-show has revealed the panel — is a
        // safe no-op when the chart is already live (see the "already bound"
        // guard in each init function) and is what actually creates it otherwise.
        if (id === 'overview') {
          var self = this;
          this.$nextTick(function () {
            self.initTrendChart(self.$refs.trendCanvas);
            self.initDonutChart(self.$refs.donutCanvas);
          });
        }
      },

      /**
       * Keyboard arrow navigation for the tab list (ARIA tablist pattern).
       * dir=1 → next, dir=-1 → prev, dir=-999 → first, dir=999 → last.
       */
      shiftFocus(dir) {
        var tabs = this.projects.length > 1
          ? ['global', 'overview', 'requirements', 'adrs', 'stories', 'screens', 'coverage', 'components', 'vcs', 'scenarios', 'versions']
          : ['overview', 'requirements', 'adrs', 'stories', 'screens', 'coverage', 'components', 'vcs', 'scenarios', 'versions'];
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
        var out = p;
        if (this.projects.length > 1 && this.activeProject) {
          out += (out.indexOf('?') === -1 ? '?' : '&') + 'project=' + this.activeProject.slug;
        }
        // Scope every read to the selected baseline. Omitted while the project
        // has a single version, so the request looks exactly as it always did.
        if (this.activeVersion && this.versions.length > 1) {
          out += (out.indexOf('?') === -1 ? '?' : '&') + 'version=' + encodeURIComponent(this.activeVersion);
        }
        return out;
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
        if (this.reqPhaseFilter !== 'all') {
          list = list.filter(function (r) {
            return self.reqPhaseFilter === '(none)' ? !r.phase : r.phase === self.reqPhaseFilter;
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
          if (self.storyPhaseFilter !== 'all') {
            var phs = self.storyPhases(s);
            if (self.storyPhaseFilter === '(none)' ? phs.length > 0 : phs.indexOf(self.storyPhaseFilter) === -1) return false;
          }
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

      // ── Scenario viewer (gherkin) ─────────────────────────────────────────────

      /** Stable key for a scenario coverage entry. */
      scenarioKey: function (sc) {
        return sc.id || ((sc.feature || '') + '::' + (sc.name || ''));
      },

      /** Apply the active tag-match filter to a story's scenario list. */
      visibleScenarios: function (scenarios) {
        var list = scenarios || [];
        if (!this.scenarioTagMatchIds) return list;
        var ids = this.scenarioTagMatchIds;
        var self = this;
        return list.filter(function (sc) { return ids.has(self.scenarioKey(sc)); });
      },

      /** Toggle the inline gherkin panel for a scenario; lazy-load its content. */
      toggleScenario: function (sc) {
        var key = this.scenarioKey(sc);
        if (this.scenarioOpenId === key) { this.scenarioOpenId = null; return; }
        this.scenarioOpenId = key;
        if (!this.scenarioContent[key]) this.loadScenario(sc);
      },

      async loadScenario(sc) {
        var key = this.scenarioKey(sc);
        this.scenarioContent[key] = { state: 'loading' };
        var d = await this._fetch(this.apiUrl('/api/scenarios/' + encodeURIComponent(key)));
        if (!d) { this.scenarioContent[key] = { state: 'error' }; return; }
        var content = d.content || '';
        var background = d.background || '';
        if (!content.trim()) { this.scenarioContent[key] = { state: 'none', valid: d.valid }; return; }
        this.scenarioContent[key] = {
          state: 'ready',
          html: this.highlightGherkin(content),
          backgroundHtml: background.trim() ? this.highlightGherkin(background) : '',
          valid: d.valid,
        };
      },

      /** Produce highlighted, HTML-escaped markup for gherkin content. */
      highlightGherkin: function (text) {
        try {
          if (window.hljs && window.hljs.getLanguage && window.hljs.getLanguage('gherkin')) {
            return window.hljs.highlight(text, { language: 'gherkin' }).value;
          }
        } catch (_) { /* fall through to escaped plain text */ }
        return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      },

      /** Resolve the tag expression to a set of matching scenario ids via the API. */
      async applyTagFilter() {
        var expr = (this.scenarioTagFilter || '').trim();
        this.scenarioTagError = '';
        if (!expr) { this.clearTagFilter(); return; }
        try {
          var res = await window.fetch(this.apiUrl('/api/scenarios?content=false&tags=' + encodeURIComponent(expr)));
          if (res.status === 400) {
            var body = await res.json().catch(function () { return {}; });
            this.scenarioTagError = (body && body.error) || 'Invalid tag expression';
            return;
          }
          if (!res.ok) { this.scenarioTagError = 'Failed to apply filter'; return; }
          var data = await res.json();
          var ids = new Set();
          (data.scenarios || []).forEach(function (s) { ids.add(s.id); });
          this.scenarioTagMatchIds = ids;
        } catch (_) {
          this.scenarioTagError = 'Failed to apply filter';
        }
      },

      clearTagFilter: function () {
        this.scenarioTagFilter = '';
        this.scenarioTagMatchIds = null;
        this.scenarioTagError = '';
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

      /**
       * Project-global count of linked scenarios (all stories, every phase).
       * Read from the cumulative coverage payload so the KPI card reflects the
       * whole project. Both helpers use the SAME source and the SAME condition
       * (cumulative coverage loaded), so the passing/linked pair on the card is
       * never mixed across scopes; the fallback pair (summary scenariosLinked /
       * scenariosPassing) is likewise internally consistent (strict report).
       */
      projectScenariosLinked() {
        if (this.coverage && this.coverage.stories && this.coverageMode === 'cumulative') {
          return this.coverage.stories.reduce(function (n, s) {
            return n + ((s.scenarios && s.scenarios.length) || 0);
          }, 0);
        }
        return this.summaryVal('scenariosLinked');
      },

      /**
       * Project-global count of passing scenarios. Aggregated from the
       * cumulative coverage data (status carried across phases) so the value is
       * the project total, not the active phase. Falls back to the summary value
       * (same source as projectScenariosLinked's fallback — see above).
       */
      projectScenariosPassing() {
        if (this.coverage && this.coverage.stories && this.coverageMode === 'cumulative') {
          return this.coverage.stories.reduce(function (n, s) {
            return n + (s.passing || 0);
          }, 0);
        }
        return this.summaryVal('scenariosPassing');
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

      /** Human label for a phase id (its name, falling back to the id). */
      phaseName(id) {
        if (!id) return '';
        for (var i = 0; i < this.phases.length; i++) {
          if (this.phases[i].id === id) return this.phases[i].name || id;
        }
        return id;
      },

      /**
       * A story has no phase of its own — its phase is derived from the phases of
       * the requirements it traces to. Returns the distinct phase ids (sorted by
       * phase order), so a story spanning phases shows each one.
       */
      storyPhases(story) {
        var self = this;
        var ids = [];
        (story.requirements || []).forEach(function (rid) {
          for (var i = 0; i < self.requirements.length; i++) {
            if (self.requirements[i].id === rid) {
              var ph = self.requirements[i].phase;
              if (ph && ids.indexOf(ph) === -1) ids.push(ph);
              break;
            }
          }
        });
        var order = {};
        this.phases.forEach(function (p) { order[p.id] = p.order; });
        ids.sort(function (a, b) {
          return ((order[a] !== undefined ? order[a] : 1e9) - (order[b] !== undefined ? order[b] : 1e9));
        });
        return ids;
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

      // =========================================================================
      // Story detail modal
      // =========================================================================

      /**
       * Open the detail modal for a story. Seeds it from the already-loaded list
       * data (instant render), then fetches /api/story for the enriched payload
       * (scenarios + pass/total) and merges it in.
       */
      openStoryDetail(story) {
        if (!story) return;
        var self = this;
        // Merge coverage scenarios we already have so the modal is useful even
        // before/without the /api/story round-trip.
        var cov = this.storyCoverage(story);
        this.storyDetail = Object.assign({}, story, {
          scenarios: cov && cov.scenarios ? cov.scenarios : [],
          scenariosTotal: cov ? (cov.scenarios || []).length : 0,
          scenariosPassing: cov ? (cov.passing || 0) : 0,
        });
        this.storyDetailOpen = true;
        this.storyDetailLoading = true;
        this._fetch(this.apiUrl('/api/story?id=' + encodeURIComponent(story.id)))
          .then(function (d) {
            if (d && d.id === story.id) {
              self.storyDetail = d;
            }
          })
          .finally(function () { self.storyDetailLoading = false; });
      },

      closeStoryDetail() {
        this.storyDetailOpen = false;
        this.storyDetail = null;
        this.storyDetailLoading = false;
      },

      /**
       * Open the Allure report for a story in a new tab.
       * Adds #?tag=@US-<id> as a hint so the report can be filtered by the
       * story's scenario tag (Allure's behaviors/suites view honours tag search).
       */
      openAllure(story) {
        if (!this.allureStatus || !this.allureStatus.available) return;
        var base = this.allureStatus.url || '/allure/';
        // Allure 2 supports a tag deep-link via the URL hash on the categories/
        // behaviors tabs; if it isn't honoured the report still opens at its root.
        var hash = story && story.id ? ('#categories/?q=' + encodeURIComponent('@' + story.id)) : '';
        window.open(base + hash, '_blank', 'noopener');
      },

      sortReqBy(col) {
        this.reqSortBy = col;
      },

      // =========================================================================
      // Chart initialisation
      // =========================================================================

      /**
       * True when an element is actually laid out (visible and has a non-zero
       * box). Chart.js throws "fullSize" / sizing errors when asked to render
       * into a 0×0 canvas — which happens while the Overview tab is hidden
       * (x-show toggles display:none but keeps the DOM mounted).
       */
      _isLaidOut(el) {
        if (!el) return false;
        if (el.offsetParent === null) return false; // display:none somewhere up the tree
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      },

      initTrendChart(canvas, tries) {
        var self = this;
        if (!canvas || typeof Chart === 'undefined') return;
        // If x-if has already swapped this canvas out of the live DOM, abandon
        // it — retrying a detached node never lays out and would recurse forever
        // (that runaway rAF loop is what produced "Maximum call stack size
        // exceeded"). A fresh x-init will fire for the replacement canvas.
        if (!document.contains(canvas)) return;
        // Wait until the canvas is really on-screen and sized. If layout hasn't
        // settled yet, retry a bounded number of frames, then give up — the
        // Overview tab becoming visible re-fires x-init, so we don't need to
        // spin forever while the panel is hidden.
        if (!self._isLaidOut(canvas)) {
          var n = (tries || 0) + 1;
          if (n > 30) return;
          requestAnimationFrame(function () { self.initTrendChart(canvas, n); });
          return;
        }
        // If we already have a live chart bound to THIS canvas, just refresh its
        // data — never stack a second Chart instance on the same canvas.
        if (CHARTS.trend && CHARTS.trend.canvas === canvas) {
          if (self.trend) self._applyTrend(self.trend);
          return;
        }
        // Destroy any stale instance so the new canvas gets a fresh Chart.js context
        // (x-if can recycle the canvas reference while CHARTS.trend still holds the old one).
        if (CHARTS.trend) { CHARTS.trend.destroy(); CHARTS.trend = null; }
        var ctx = canvas.getContext('2d');

        CHARTS.trend = new Chart(ctx, {
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

        // Register the reactive watcher exactly once, ever — re-running init
        // (x-if recycling the canvas) must not stack additional watchers.
        if (!self._trendWatched) {
          self._trendWatched = true;
          self.$watch('trend', function (data) { self._applyTrend(data); });
        }
        if (this.trend) self._applyTrend(this.trend);
      },

      _applyTrend(data) {
        var self = this;
        if (!data || !CHARTS.trend) return;
        // Don't push an update into a chart whose canvas is detached or 0×0
        // (e.g. the Overview tab is hidden, or x-if just swapped the canvas):
        // Chart.js' resize path throws "fullSize" on a zero-size canvas. The
        // data will be applied when initTrendChart re-runs on a visible canvas.
        if (!self._isLaidOut(CHARTS.trend.canvas)) return;
        CHARTS.trend.data.labels = data.map(function (p) { return p.phaseName || p.phase; });
        CHARTS.trend.data.datasets[0].data = data.map(function (p) {
          return p.summary ? Number((p.summary.verifiedPct || 0).toFixed(1)) : 0;
        });
        CHARTS.trend.data.datasets[1].data = data.map(function (p) {
          return p.summary ? Number((p.summary.testedStoryCoveragePct || 0).toFixed(1)) : 0;
        });
        CHARTS.trend.update('none');
      },

      initDonutChart(canvas, tries) {
        var self = this;
        if (!canvas || typeof Chart === 'undefined') return;
        // Abandon a canvas x-if has detached (see initTrendChart) — prevents the
        // runaway retry recursion behind "Maximum call stack size exceeded".
        if (!document.contains(canvas)) return;
        // Wait for the canvas to be visible & sized (bounded; see initTrendChart).
        if (!self._isLaidOut(canvas)) {
          var n = (tries || 0) + 1;
          if (n > 30) return;
          requestAnimationFrame(function () { self.initDonutChart(canvas, n); });
          return;
        }
        // Already bound to this canvas → refresh data only, don't re-create.
        if (CHARTS.donut && CHARTS.donut.canvas === canvas) {
          if (self.coverage) self._applyDonut(self.coverage);
          return;
        }
        // Same as trendChart: destroy any stale instance before re-init.
        if (CHARTS.donut) { CHARTS.donut.destroy(); CHARTS.donut = null; }
        var ctx = canvas.getContext('2d');

        var COLORS = [
          '#16a34a', '#4f46e5', '#f59e0b', '#ef4444',
          '#06b6d4', '#8b5cf6', '#ec4899', '#14b8a6',
          '#f97316', '#84cc16',
        ];

        CHARTS.donut = new Chart(ctx, {
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

        self._donutColors = COLORS;
        if (!self._donutWatched) {
          self._donutWatched = true;
          self.$watch('coverage', function (data) { self._applyDonut(data); });
        }
        if (this.coverage) self._applyDonut(this.coverage);
      },

      _applyDonut(data) {
        var self = this;
        if (!data || !CHARTS.donut) return;
        // See _applyTrend: skip updates while the canvas is hidden/detached.
        if (!self._isLaidOut(CHARTS.donut.canvas)) return;
        var COLORS = self._donutColors || [];
        var by = data.byComponent || [];
        CHARTS.donut.data.labels = by.map(function (c) { return c.component; });
        CHARTS.donut.data.datasets[0].data = by.map(function (c) {
          return Number((c.verifiedPct || 0).toFixed(1));
        });
        CHARTS.donut.data.datasets[0].backgroundColor = by.map(function (_, i) {
          return COLORS[i % COLORS.length];
        });
        CHARTS.donut.update('none');
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
          self.briefExpanded = false;
          self.briefOverflows = false;
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

      // =========================================================================
      // Scenarios tab
      // =========================================================================

      async loadScenarios() {
        this.scenariosLoading = true;
        // Backend contract (OpenAPI): q, tags, limit, offset → { total, scenarios[] }.
        var params = new URLSearchParams({
          limit:  String(this.scenariosPageSize),
          offset: String((this.scenariosPage - 1) * this.scenariosPageSize),
          q:      this.scenariosSearch,
          tags:   this.scenariosTag,
        });
        // Phase scope is server-side: it resolves each scenario's stories to their
        // requirements' phases. Sent only when a phase is chosen — the endpoint
        // treats an absent `phase` as "all phases", and it is what makes the
        // Status column report the result for that phase.
        if (this.scenariosPhase) {
          params.set('phase', this.scenariosPhase);
          params.set('mode', this.scenariosMode);
        }
        if (this.projects.length > 1 && this.activeProject) {
          params.set('project', this.activeProject.slug);
        }
        var d = await this._fetch('/api/scenarios?' + params.toString());
        if (d) {
          this.scenarios = d.scenarios || [];
          this.scenariosTotal = d.total || 0;
        }
        this.scenariosLoading = false;
      },

      async executeScenario(feature, name, status) {
        this.scenariosExecuting = true;
        var self = this;
        try {
          var body = { feature: feature, name: name, status: status, note: this.scenariosNote };
          if (this.projects.length > 1 && this.activeProject) {
            body.project = this.activeProject.slug;
          }
          await window.fetch('/api/scenarios/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
        } finally {
          self.scenariosNote = '';
          self.scenariosExpanded = null;
          self.scenariosExecuting = false;
          await self.loadScenarios();
          await self.loadSummary();
        }
      },

      scenarioStatusBadge(status) {
        if (status === 'pass')    return 'badge-green';
        if (status === 'fail')    return 'badge-red';
        if (status === 'pending') return 'badge-amber';
        return 'badge-slate';
      },

      // Scenarios-tab row expansion (distinct from the Stories-tab gherkin viewer's
      // toggleScenario, which tracks scenarioOpenId). Lazy-loads the gherkin content
      // into the shared scenarioContent cache so the detail panel can render it.
      toggleScenarioRow(sc) {
        var k = this.scenarioKey(sc);
        this.scenariosExpanded = (this.scenariosExpanded === k) ? null : k;
        this.scenariosNote = '';
        if (this.scenariosExpanded === k && !this.scenarioContent[k]) this.loadScenario(sc);
      },

      scenariosTotalPages() {
        return Math.max(1, Math.ceil(this.scenariosTotal / this.scenariosPageSize));
      },

    }; // end return
  }); // end Alpine.data
}); // end addEventListener
