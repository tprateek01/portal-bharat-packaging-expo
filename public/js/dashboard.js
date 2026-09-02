(async function () {
  // ---- Auth guard ----
  const session = await fetch("/api/session").then((r) => r.json());
  if (!session.authenticated) {
    window.location.href = "/login.html";
    return;
  }

  document.getElementById("logoutBtn").addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "/login.html";
  });

  // ---- Event branding (name/logo/dates/venue) — same portal, any event ----
  // Public endpoint, no auth needed — safe to fire alongside the auth guard.
  fetch("/api/branding")
    .then((r) => r.json())
    .then((b) => {
      document.getElementById("pageTitleTag").textContent = `Admin Portal — ${b.eventName}`;
      const logo = document.getElementById("brandLogo");
      logo.src = `/images/${b.logo2x}`;
      logo.alt = b.eventName;
      document.getElementById("eventCardTitle").textContent = b.eventName;
      document.getElementById("eventCardDates").textContent = b.dateRange;
      document.getElementById("eventCardVenue").textContent = b.venue;
    })
    .catch(() => {
      // Branding is cosmetic only — never block the dashboard on it.
    });

  // Every authenticated API call goes through this. If the session has
  // expired mid-use (12h JWT, or the cookie got cleared), the API returns
  // 401 — instead of that surfacing as a confusing inline error, send the
  // admin straight back to the login page.
  async function apiFetch(url, opts) {
    const res = await fetch(url, opts);
    if (res.status === 401) {
      window.location.href = "/login.html";
      throw new Error("Session expired. Redirecting to sign in…");
    }
    return res;
  }

  // ---- State ----
  const OVERVIEW_KEY = "__overview__";
  let TYPES = [];
  let STATUSES = [];
  let currentType = OVERVIEW_KEY; // land on the Overview summary first
  let currentStatus = "All";
  let currentPage = 1;
  const PAGE_SIZE = 20;
  let filterValues = {}; // { search: "", <filterKey>: "" }
  let debounceTimer = null;
  let expandedGroups = {}; // { "Visitors": true }

  const navList = document.getElementById("navList");
  const pageTitle = document.getElementById("pageTitle");
  const statusTabsEl = document.getElementById("statusTabs");
  const filterBarEl = document.getElementById("filterBar");
  const tableArea = document.getElementById("tableArea");
  const resultCount = document.getElementById("resultCount");
  const pageIndicator = document.getElementById("pageIndicator");
  const prevPageBtn = document.getElementById("prevPage");
  const nextPageBtn = document.getElementById("nextPage");
  const exportBtn = document.getElementById("exportBtn");
  const searchSummaryEl = document.getElementById("searchSummary");
  const overviewArea = document.getElementById("overviewArea");
  const comingSoonArea = document.getElementById("comingSoonArea");
  const bulkUploadArea = document.getElementById("bulkUploadArea");
  const recordsView = document.getElementById("recordsView");
  const modalBackdrop = document.getElementById("modalBackdrop");
  const modalBody = document.getElementById("modalBody");
  const modalClose = document.getElementById("modalClose");
  const editModalBackdrop = document.getElementById("editModalBackdrop");
  const editModalBody = document.getElementById("editModalBody");
  const editModalError = document.getElementById("editModalError");
  const editModalCancel = document.getElementById("editModalCancel");
  const editModalSave = document.getElementById("editModalSave");

  modalClose.addEventListener("click", () => modalBackdrop.classList.remove("open"));
  modalBackdrop.addEventListener("click", (e) => {
    if (e.target === modalBackdrop) modalBackdrop.classList.remove("open");
  });
  editModalCancel.addEventListener("click", () => closeEditModal());
  editModalBackdrop.addEventListener("click", (e) => {
    if (e.target === editModalBackdrop) closeEditModal();
  });
  function closeEditModal() {
    editModalBackdrop.classList.remove("open");
    editModalError.classList.remove("show");
    editModalError.textContent = "";
  }

  // ---- Load type/column config from the server ----
  let meta;
  try {
    meta = await apiFetch("/api/types").then((r) => r.json());
  } catch (err) {
    return; // apiFetch already redirected to /login.html
  }
  TYPES = meta.types;
  STATUSES = meta.statuses;

  renderNav();
  showOverview();

  exportBtn.addEventListener("click", async () => {
    const params = buildQueryParams({ forExport: true });
    exportBtn.disabled = true;
    const originalLabel = exportBtn.textContent;
    exportBtn.textContent = "Exporting…";
    try {
      const res = await apiFetch(`/api/records/${currentType}/export?${params.toString()}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Could not export records.");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${currentType}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(err.message);
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = originalLabel;
    }
  });

  // ---- View switching: Overview <-> a type's records table ----
  function showOverview() {
    currentType = OVERVIEW_KEY;
    overviewArea.style.display = "block";
    comingSoonArea.style.display = "none";
    bulkUploadArea.style.display = "none";
    recordsView.style.display = "none";
    exportBtn.style.display = "none";
    pageTitle.textContent = "Overview";
    loadOverview();
  }

  function showRecordsView(typeKey) {
    currentType = typeKey;
    currentStatus = "All";
    currentPage = 1;
    filterValues = {};
    overviewArea.style.display = "none";
    comingSoonArea.style.display = "none";
    bulkUploadArea.style.display = "none";
    recordsView.style.display = "block";
    exportBtn.style.display = "";
    renderStatusTabs();
    renderFilterBar();
    loadRecords();
  }

  // ---- Overview (Approved/Registered/Rejected/Inactive counts per type) ----
  async function loadOverview() {
    overviewArea.innerHTML = '<div class="loading-state">Loading summary…</div>';
    try {
      const res = await apiFetch("/api/summary");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load summary.");
      renderOverview(data);
    } catch (err) {
      overviewArea.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
    }
  }

  function renderOverview(data) {
    overviewArea.innerHTML = "";

    const totalCard = document.createElement("div");
    totalCard.className = "overview-total-card";
    totalCard.innerHTML = `
      <div class="overview-total-count">${data.grandTotal}</div>
      <div class="overview-total-label">Total registrations across all types</div>
    `;
    overviewArea.appendChild(totalCard);

    const grid = document.createElement("div");
    grid.className = "overview-grid";

    data.types.forEach((t) => {
      const card = document.createElement("div");
      card.className = "overview-card";
      card.title = `View ${t.label}`;

      const header = document.createElement("div");
      header.className = "overview-card-header";
      header.innerHTML = `<span>${escapeHtml(t.label)}</span><span class="overview-card-total">${t.total}</span>`;
      card.appendChild(header);

      const bars = document.createElement("div");
      bars.className = "overview-card-bars";
      STATUSES.forEach((s) => {
        const count = t.byStatus[s] || 0;
        const pct = t.total > 0 ? Math.round((count / t.total) * 100) : 0;
        const row = document.createElement("div");
        row.className = "overview-bar-row";
        row.innerHTML = `
          <span class="overview-bar-label">${escapeHtml(s)}</span>
          <div class="overview-bar-track"><div class="overview-bar-fill status-${escapeHtml(s)}" style="width:${pct}%"></div></div>
          <span class="overview-bar-count">${count}</span>
        `;
        bars.appendChild(row);
      });
      card.appendChild(bars);

      card.addEventListener("click", () => {
        renderNav();
        showRecordsView(t.key);
      });

      grid.appendChild(card);
    });

    overviewArea.appendChild(grid);
  }

  // ---- Sidebar navigation layout ----
  // This array is the single source of truth for sidebar structure/order —
  // deliberately decoupled from TYPE_CONFIG on the server, so we can lay
  // the sidebar out exactly like the reference portal (Analytics / Space
  // Booking / Domestic Buyers / General Visitors / Payments / Service
  // Request Forms) even for sections whose backend isn't built yet.
  //
  // Each item is either:
  //   { key: "<TYPE_CONFIG key>" }                 — a real, working section
  //   { key: "...", label: "...", comingSoon: true, comingSoonNote: "..." }
  //     — a placeholder for a section being built in a later task. Clicking
  //     it shows a friendly "coming soon" panel instead of calling the API.
  // `label` is optional for real items — it falls back to the label the
  // server sent in /api/types, so renaming a section only needs a change
  // in one place (server.js).
  const NAV_LAYOUT = [
    {
      kind: "group",
      name: "Analytics",
      items: [
        { key: "analytics_exhibitors", label: "Exhibitors", comingSoon: true, comingSoonNote: "Exhibitor charts & summary — coming in a later update." },
        { key: "analytics_domestic_buyers", label: "Domestic Buyers", comingSoon: true, comingSoonNote: "Buyer charts & summary — coming in a later update." },
      ],
    },
    {
      kind: "group",
      name: "Space Booking",
      items: [
        { key: "exhibitor_booking" },
        { key: "hall_stall_management", label: "Hall & Stall Management", comingSoon: true, comingSoonNote: "Stall inventory (vacant/allotted, add & upload stalls) — coming in a later update." },
      ],
    },
    {
      kind: "group",
      name: "Domestic Buyers",
      items: [
        { key: "visitors_buyers" },
        { key: "domestic_buyer_bulk_upload", label: "Bulk Upload", custom: "bulkUpload" },
      ],
    },
    { kind: "item", item: { key: "visitors_delegates" } },
    { kind: "item", item: { key: "exhibitor_eoi" } },
    { kind: "item", item: { key: "payments", label: "Payments", comingSoon: true, comingSoonNote: "Exhibitor payment records — coming in a later update." } },
    { kind: "item", item: { key: "service_requests", label: "Service Request Forms", comingSoon: true, comingSoonNote: "Service requests raised by exhibitors — coming in a later update." } },
  ];

  // Resolves a NAV_LAYOUT entry against the live TYPES list from the
  // server (for real sections) or keeps it as a placeholder/custom view.
  function resolveNavItem(item) {
    if (item.comingSoon || item.custom) return item;
    const cfg = TYPES.find((t) => t.key === item.key);
    // Defensive: if the server ever stops sending a key this file expects,
    // fall back to a disabled-looking placeholder instead of throwing.
    if (!cfg) return { ...item, label: item.label || item.key, comingSoon: true, comingSoonNote: "This section isn't available right now." };
    return { key: item.key, label: item.label || cfg.label, comingSoon: false };
  }

  // ---- Sidebar ----
  // Top-level entries all render with identical styling. Any entry backed
  // by a "group" (e.g. "Space Booking" -> Exhibitors/Hall & Stall
  // Management) becomes a toggle button with a chevron that expands to
  // reveal its nested items.
  function renderNav() {
    navList.innerHTML = "";

    const overviewBtn = document.createElement("button");
    overviewBtn.className = "nav-item" + (currentType === OVERVIEW_KEY ? " active" : "");
    overviewBtn.textContent = "Overview";
    overviewBtn.addEventListener("click", () => {
      renderNav();
      showOverview();
    });
    navList.appendChild(overviewBtn);

    NAV_LAYOUT.forEach((section) => {
      if (section.kind === "item") {
        navList.appendChild(buildNavButton(resolveNavItem(section.item), false));
        return;
      }

      const { name } = section;
      const items = section.items.map(resolveNavItem);
      const hasActiveChild = items.some((it) => it.key === currentType);
      // Default a group open the first time it's rendered if it contains
      // the current page; afterwards, respect whatever the user toggled.
      if (!(name in expandedGroups)) expandedGroups[name] = hasActiveChild;
      const isOpen = expandedGroups[name];

      const groupBtn = document.createElement("button");
      groupBtn.className = "nav-item nav-group-toggle" + (hasActiveChild ? " active" : "");
      groupBtn.setAttribute("aria-expanded", String(isOpen));

      const labelSpan = document.createElement("span");
      labelSpan.textContent = name;
      groupBtn.appendChild(labelSpan);

      const chevron = document.createElement("span");
      chevron.className = "nav-chevron" + (isOpen ? " open" : "");
      chevron.textContent = "▾";
      groupBtn.appendChild(chevron);

      groupBtn.addEventListener("click", () => {
        expandedGroups[name] = !expandedGroups[name];
        renderNav();
      });
      navList.appendChild(groupBtn);

      if (isOpen) {
        const sub = document.createElement("div");
        sub.className = "nav-subgroup";
        items.forEach((t) => sub.appendChild(buildNavButton(t, true)));
        navList.appendChild(sub);
      }
    });
  }

  function buildNavButton(t, nested) {
    const btn = document.createElement("button");
    btn.className = "nav-item" + (nested ? " nested" : "") + (t.key === currentType ? " active" : "");

    const labelSpan = document.createElement("span");
    labelSpan.textContent = t.label;
    btn.appendChild(labelSpan);

    if (t.comingSoon) {
      const badge = document.createElement("span");
      badge.className = "nav-soon-badge";
      badge.textContent = "Soon";
      btn.appendChild(badge);
    }

    btn.addEventListener("click", () => {
      renderNav();
      if (t.custom === "bulkUpload") {
        showBulkUpload();
      } else if (t.comingSoon) {
        showComingSoon(t.key, t.label, t.comingSoonNote);
      } else {
        showRecordsView(t.key);
      }
    });
    return btn;
  }

  // ---- Domestic Buyer Bulk Upload page ----
  let selectedBulkFile = null;

  function showBulkUpload() {
    currentType = "domestic_buyer_bulk_upload";
    overviewArea.style.display = "none";
    comingSoonArea.style.display = "none";
    recordsView.style.display = "none";
    bulkUploadArea.style.display = "block";
    exportBtn.style.display = "none";
    pageTitle.textContent = "Domestic Buyer Bulk Upload";
    selectedBulkFile = null;

    bulkUploadArea.innerHTML = `
      <div class="bulk-upload-layout">
        <div class="bulk-upload-main">
          <div class="bulk-upload-toolbar">
            <span class="bulk-upload-toolbar-label">Upload</span>
            <button type="button" class="template-btn" id="downloadTemplateBtn">⬇ Download Template</button>
          </div>

          <div class="dropzone" id="dropzone">
            <div class="dropzone-icon">📤</div>
            <div class="dropzone-title">Drop or Select file</div>
            <div class="dropzone-sub">Drop files here or click <span class="dropzone-browse">browse</span> through your machine</div>
            <input type="file" id="fileInput" accept=".xlsx" hidden />
          </div>
          <div class="dropzone-hint">Allowed *.xlsx, max size of 10 MB</div>

          <div id="selectedFileRow" class="selected-file-row" style="display:none;"></div>

          <label class="send-email-toggle">
            <input type="checkbox" id="sendEmailToggle" />
            <span>Send registration email to every buyer created from this file</span>
          </label>

          <button type="button" class="primary-btn upload-submit-btn" id="uploadSubmitBtn" disabled>Upload</button>

          <div id="uploadResult" class="upload-result" style="display:none;"></div>
        </div>

        <div class="bulk-upload-history">
          <h3>Uploads</h3>
          <div id="uploadsListArea"><div class="loading-state">Loading…</div></div>
        </div>
      </div>
    `;

    const dropzone = document.getElementById("dropzone");
    const fileInput = document.getElementById("fileInput");
    const selectedFileRow = document.getElementById("selectedFileRow");
    const uploadSubmitBtn = document.getElementById("uploadSubmitBtn");
    const uploadResult = document.getElementById("uploadResult");
    const sendEmailToggle = document.getElementById("sendEmailToggle");

    document.getElementById("downloadTemplateBtn").addEventListener("click", () => {
      window.location.href = "/api/domestic-buyers/bulk-upload/template";
    });

    dropzone.addEventListener("click", () => fileInput.click());
    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleFileSelected(e.dataTransfer.files[0]);
      }
    });
    fileInput.addEventListener("change", () => {
      if (fileInput.files && fileInput.files[0]) handleFileSelected(fileInput.files[0]);
    });

    function handleFileSelected(file) {
      uploadResult.style.display = "none";
      if (!/\.xlsx$/i.test(file.name)) {
        selectedFileRow.style.display = "flex";
        selectedFileRow.innerHTML = `<span class="selected-file-error">"${escapeHtml(file.name)}" is not a .xlsx file. Please pick a .xlsx file.</span>`;
        uploadSubmitBtn.disabled = true;
        selectedBulkFile = null;
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        selectedFileRow.style.display = "flex";
        selectedFileRow.innerHTML = `<span class="selected-file-error">File is larger than 10 MB.</span>`;
        uploadSubmitBtn.disabled = true;
        selectedBulkFile = null;
        return;
      }
      selectedBulkFile = file;
      selectedFileRow.style.display = "flex";
      selectedFileRow.innerHTML = `
        <span class="selected-file-name">📄 ${escapeHtml(file.name)} <span class="selected-file-size">(${(file.size / 1024).toFixed(1)} KB)</span></span>
        <button type="button" class="selected-file-remove" id="removeFileBtn">✕</button>
      `;
      uploadSubmitBtn.disabled = false;
      document.getElementById("removeFileBtn").addEventListener("click", (e) => {
        e.stopPropagation();
        selectedBulkFile = null;
        fileInput.value = "";
        selectedFileRow.style.display = "none";
        uploadSubmitBtn.disabled = true;
      });
    }

    uploadSubmitBtn.addEventListener("click", async () => {
      if (!selectedBulkFile) return;
      uploadSubmitBtn.disabled = true;
      uploadSubmitBtn.textContent = "Uploading…";
      uploadResult.style.display = "none";

      const formData = new FormData();
      formData.append("file", selectedBulkFile);
      formData.append("sendEmail", sendEmailToggle.checked ? "true" : "false");

      try {
        const res = await apiFetch("/api/domestic-buyers/bulk-upload", { method: "POST", body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Upload failed.");

        uploadResult.style.display = "block";
        uploadResult.className = `upload-result ${data.failedCount > 0 ? "has-errors" : "success"}`;
        uploadResult.innerHTML = `
          <strong>${data.successCount} of ${data.totalRows} row${data.totalRows === 1 ? "" : "s"} imported successfully.</strong>
          ${data.failedCount > 0 ? `<div class="upload-result-fail-line">${data.failedCount} row${data.failedCount === 1 ? "" : "s"} failed — <a href="/api/domestic-buyers/bulk-uploads/${data.upload.id}/failure-report">download failure report</a>.</div>` : ""}
        `;

        // Reset the picker for the next upload.
        selectedBulkFile = null;
        fileInput.value = "";
        selectedFileRow.style.display = "none";
        loadUploadsList();
      } catch (err) {
        uploadResult.style.display = "block";
        uploadResult.className = "upload-result has-errors";
        uploadResult.innerHTML = `<strong>${escapeHtml(err.message)}</strong>`;
      } finally {
        uploadSubmitBtn.disabled = !selectedBulkFile;
        uploadSubmitBtn.textContent = "Upload";
      }
    });

    loadUploadsList();
  }

  async function loadUploadsList() {
    const area = document.getElementById("uploadsListArea");
    if (!area) return; // page was navigated away from before this resolved
    try {
      const res = await apiFetch("/api/domestic-buyers/bulk-uploads");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load upload history.");
      renderUploadsList(data.uploads);
    } catch (err) {
      area.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
    }
  }

  function renderUploadsList(uploads) {
    const area = document.getElementById("uploadsListArea");
    if (!area) return;
    if (!uploads || uploads.length === 0) {
      area.innerHTML = '<div class="empty-state">No uploads yet.</div>';
      return;
    }
    area.innerHTML = "";
    uploads.forEach((u) => {
      const card = document.createElement("div");
      card.className = "upload-history-card";
      const statusClass = u.failed_count > 0 ? "has-errors" : "success";
      const statusLabel = u.failed_count > 0 ? "COMPLETED WITH ERRORS" : "COMPLETED";
      const dateStr = formatValue(u.created_at, "date");
      card.innerHTML = `
        <div class="upload-history-name">${escapeHtml(u.filename)}</div>
        <div class="upload-history-meta">Uploaded by: ${escapeHtml(u.uploaded_by || "—")}</div>
        <span class="upload-history-status ${statusClass}">${statusLabel}</span>
        <div class="upload-history-meta">Date: ${escapeHtml(dateStr)}</div>
        <div class="upload-history-counts">${u.success_count} imported${u.failed_count > 0 ? `, ${u.failed_count} failed` : ""} of ${u.total_rows}</div>
        ${u.failed_count > 0 ? `<a class="upload-history-download" href="/api/domestic-buyers/bulk-uploads/${u.id}/failure-report">⬇ Failure report</a>` : ""}
      `;
      area.appendChild(card);
    });
  }
  function showComingSoon(key, label, note) {
    currentType = key;
    overviewArea.style.display = "none";
    recordsView.style.display = "none";
    bulkUploadArea.style.display = "none";
    comingSoonArea.style.display = "block";
    exportBtn.style.display = "none";
    pageTitle.textContent = label;
    comingSoonArea.innerHTML = `
      <div class="coming-soon-card">
        <div class="coming-soon-icon">🚧</div>
        <h2>${escapeHtml(label)} — Coming Soon</h2>
        <p>${escapeHtml(note || "This section is being built and will be available in a future update.")}</p>
      </div>
    `;
  }

  // ---- Status tabs ----
  function renderStatusTabs() {
    statusTabsEl.innerHTML = "";
    const tabs = ["All", ...STATUSES];
    tabs.forEach((s) => {
      const btn = document.createElement("button");
      btn.textContent = s;
      btn.className = s === currentStatus ? "active" : "";
      btn.addEventListener("click", () => {
        currentStatus = s;
        currentPage = 1;
        renderStatusTabs();
        loadRecords();
      });
      statusTabsEl.appendChild(btn);
    });
  }

  // ---- Filter bar ----
  function renderFilterBar() {
    const cfg = TYPES.find((t) => t.key === currentType);
    filterBarEl.innerHTML = "";

    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = "Search name, company, email, mobile…";
    searchInput.value = filterValues.search || "";
    searchInput.addEventListener("input", () => {
      filterValues.search = searchInput.value;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        currentPage = 1;
        loadRecords();
      }, 400);
    });
    filterBarEl.appendChild(searchInput);

    cfg.filters.forEach((filterKey) => {
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = prettifyKey(filterKey);
      input.value = filterValues[filterKey] || "";
      input.addEventListener("input", () => {
        filterValues[filterKey] = input.value;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          currentPage = 1;
          loadRecords();
        }, 400);
      });
      filterBarEl.appendChild(input);
    });
  }

  function prettifyKey(key) {
    if (key === "search") return "Search";
    return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // ---- Search / filter results summary ("N results found" + chips + Clear) ----
  function renderSearchSummary(total) {
    const activeEntries = Object.entries(filterValues).filter(([, v]) => v && String(v).trim());

    if (activeEntries.length === 0) {
      searchSummaryEl.style.display = "none";
      searchSummaryEl.innerHTML = "";
      return;
    }

    searchSummaryEl.style.display = "flex";
    searchSummaryEl.innerHTML = "";

    const countEl = document.createElement("div");
    countEl.className = "search-summary-count";
    countEl.textContent = `${total} result${total === 1 ? "" : "s"} found`;
    searchSummaryEl.appendChild(countEl);

    const row = document.createElement("div");
    row.className = "search-summary-chips-row";

    const chipsWrap = document.createElement("div");
    chipsWrap.className = "search-summary-chips";
    activeEntries.forEach(([key, value]) => {
      const chip = document.createElement("span");
      chip.className = "filter-chip";

      const labelSpan = document.createElement("span");
      labelSpan.className = "filter-chip-label";
      labelSpan.textContent = prettifyKey(key);
      chip.appendChild(labelSpan);

      const valueSpan = document.createElement("span");
      valueSpan.className = "filter-chip-value";
      valueSpan.textContent = value;
      chip.appendChild(valueSpan);

      const removeBtn = document.createElement("button");
      removeBtn.className = "filter-chip-remove";
      removeBtn.type = "button";
      removeBtn.title = `Remove ${prettifyKey(key)} filter`;
      removeBtn.textContent = "✕";
      removeBtn.addEventListener("click", () => {
        filterValues[key] = "";
        currentPage = 1;
        renderFilterBar();
        loadRecords();
      });
      chip.appendChild(removeBtn);

      chipsWrap.appendChild(chip);
    });
    row.appendChild(chipsWrap);

    const clearBtn = document.createElement("button");
    clearBtn.className = "search-summary-clear";
    clearBtn.type = "button";
    clearBtn.innerHTML = `${ICONS.delete} Clear`;
    clearBtn.addEventListener("click", () => {
      filterValues = {};
      currentPage = 1;
      renderFilterBar();
      loadRecords();
    });
    row.appendChild(clearBtn);

    searchSummaryEl.appendChild(row);
  }

  // ---- Query params shared by list + export ----
  function buildQueryParams({ forExport = false } = {}) {
    const params = new URLSearchParams();
    if (currentStatus !== "All") params.set("status", currentStatus);
    if (filterValues.search) params.set("search", filterValues.search);
    const cfg = TYPES.find((t) => t.key === currentType);
    cfg.filters.forEach((key) => {
      if (filterValues[key]) params.set(key, filterValues[key]);
    });
    if (!forExport) {
      params.set("page", currentPage);
      params.set("pageSize", PAGE_SIZE);
    }
    return params;
  }

  // ---- Load + render table ----
  async function loadRecords() {
    const cfg = TYPES.find((t) => t.key === currentType);
    pageTitle.textContent = cfg.label;
    tableArea.innerHTML = '<div class="loading-state">Loading records…</div>';

    const params = buildQueryParams();
    try {
      const res = await apiFetch(`/api/records/${currentType}?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load records.");
      renderTable(cfg, data);
      renderSearchSummary(data.total);
    } catch (err) {
      tableArea.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
      resultCount.textContent = "";
      searchSummaryEl.style.display = "none";
    }
  }

  // Columns shown in the main list table — kept separate from the full
  // column set (used by the View/Edit modals) so operationally secondary
  // fields don't make the table unreadably wide. See `hideInTable` in
  // server.js's TYPE_CONFIG.
  function tableColumns(cfg) {
    return cfg.columns.filter((c) => !c.hideInTable);
  }

  function renderTable(cfg, data) {
    const { rows, total, page, pageSize } = data;
    const columns = tableColumns(cfg);

    if (rows.length === 0) {
      tableArea.innerHTML = '<div class="empty-state">No records found.</div>';
    } else {
      const table = document.createElement("table");
      table.className = "data-table";

      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      // Actions leads the row (matches reference layout), then Status,
      // then the type's own data columns.
      ["Actions", "Status"].forEach((label) => {
        const th = document.createElement("th");
        th.textContent = label;
        headRow.appendChild(th);
      });
      columns.forEach((col) => {
        const th = document.createElement("th");
        th.textContent = col.label;
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      rows.forEach((row) => {
        const tr = document.createElement("tr");

        const actionsTd = document.createElement("td");
        actionsTd.appendChild(buildRowActions(cfg, row));
        tr.appendChild(actionsTd);

        const statusTd = document.createElement("td");
        const pill = document.createElement("span");
        pill.className = `status-pill ${row.status}`;
        pill.textContent = row.status;
        statusTd.appendChild(pill);
        tr.appendChild(statusTd);

        columns.forEach((col) => {
          const td = document.createElement("td");
          td.textContent = formatValue(row[col.key], col.type);
          tr.appendChild(td);
        });

        tbody.appendChild(tr);
      });
      table.appendChild(tbody);

      tableArea.innerHTML = "";
      tableArea.appendChild(table);
    }

    const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, total);
    resultCount.textContent = `${start}-${end} of ${total} results`;
    pageIndicator.textContent = `Page ${page}`;
    prevPageBtn.disabled = page <= 1;
    nextPageBtn.disabled = end >= total;

    prevPageBtn.onclick = () => {
      if (currentPage > 1) {
        currentPage -= 1;
        loadRecords();
      }
    };
    nextPageBtn.onclick = () => {
      if (end < total) {
        currentPage += 1;
        loadRecords();
      }
    };
  }

  // Small inline stroke icons (flat, single-color, no boxed buttons) —
  // matches the reference layout's icon-row style rather than bordered buttons.
  // Row order mirrors the reference: view, edit (pencil), approve, reject, delete.
  const ICONS = {
    view: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
    edit: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    approve: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    reject: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/></svg>',
    delete: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
  };

  function buildRowActions(cfg, row) {
    const wrap = document.createElement("div");
    wrap.className = "row-actions";

    const viewBtn = document.createElement("button");
    viewBtn.className = "view";
    viewBtn.title = "View details";
    viewBtn.innerHTML = ICONS.view;
    viewBtn.addEventListener("click", () => openModal(cfg, row));
    wrap.appendChild(viewBtn);

    const editBtn = document.createElement("button");
    editBtn.className = "edit";
    editBtn.title = "Edit details";
    editBtn.innerHTML = ICONS.edit;
    editBtn.addEventListener("click", () => openEditModal(cfg, row));
    wrap.appendChild(editBtn);

    const approveBtn = document.createElement("button");
    approveBtn.className = "approve";
    approveBtn.title = "Approve";
    approveBtn.innerHTML = ICONS.approve;
    approveBtn.addEventListener("click", () => updateStatus(row.id, "Approved"));
    wrap.appendChild(approveBtn);

    const rejectBtn = document.createElement("button");
    rejectBtn.className = "reject";
    rejectBtn.title = "Reject";
    rejectBtn.innerHTML = ICONS.reject;
    rejectBtn.addEventListener("click", () => updateStatus(row.id, "Rejected"));
    wrap.appendChild(rejectBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "delete";
    deleteBtn.title = "Delete";
    deleteBtn.innerHTML = ICONS.delete;
    deleteBtn.addEventListener("click", () => deleteRecord(row.id));
    wrap.appendChild(deleteBtn);

    return wrap;
  }

  async function updateStatus(id, status) {
    try {
      const res = await apiFetch(`/api/records/${currentType}/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not update status.");
      loadRecords();
    } catch (err) {
      alert(err.message);
    }
  }

  async function deleteRecord(id) {
    if (!confirm("Delete this record permanently? This cannot be undone.")) return;
    try {
      const res = await apiFetch(`/api/records/${currentType}/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not delete record.");
      loadRecords();
    } catch (err) {
      alert(err.message);
    }
  }

  // View modal always shows every field (not just the table's subset), so
  // this is the place to see stall preferences, product categories, etc.
  function openModal(cfg, row) {
    modalBody.innerHTML = "";
    const allFields = [...cfg.columns, { key: "status", label: "Status" }];
    allFields.forEach((col) => {
      const div = document.createElement("div");
      div.className = "modal-row";
      const key = document.createElement("span");
      key.textContent = col.label;
      const val = document.createElement("span");
      val.textContent = formatValue(row[col.key], col.type) || "—";
      div.appendChild(key);
      div.appendChild(val);
      modalBody.appendChild(div);
    });
    modalBackdrop.classList.add("open");
  }

  // ---- Edit modal (pencil action) — lets an admin change any of the
  // record's own editable fields, plus its status, and saves via PATCH. ----
  function openEditModal(cfg, row) {
    editModalError.classList.remove("show");
    editModalError.textContent = "";
    editModalBody.innerHTML = "";

    const inputs = {}; // key -> input/select element

    // Status first, since it's the field admins change most often.
    const statusField = document.createElement("div");
    statusField.className = "edit-field status-field";
    const statusLabel = document.createElement("label");
    statusLabel.textContent = "Status";
    const statusSelect = document.createElement("select");
    STATUSES.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s;
      if (s === row.status) opt.selected = true;
      statusSelect.appendChild(opt);
    });
    statusField.appendChild(statusLabel);
    statusField.appendChild(statusSelect);
    editModalBody.appendChild(statusField);
    inputs.status = statusSelect;

    cfg.columns.forEach((col) => {
      const field = document.createElement("div");
      field.className = "edit-field";
      const label = document.createElement("label");
      label.textContent = col.label;
      field.appendChild(label);

      const notEditable = col.editable === false || col.type === "date";
      const currentValue = formatValue(row[col.key], col.type);

      let input;
      if (col.type === "select" && Array.isArray(col.options)) {
        input = document.createElement("select");
        let hasCurrentValue = !currentValue;
        col.options.forEach((optValue) => {
          const opt = document.createElement("option");
          opt.value = optValue;
          opt.textContent = optValue;
          if (optValue === currentValue) {
            opt.selected = true;
            hasCurrentValue = true;
          }
          input.appendChild(opt);
        });
        // If the stored value isn't one of the known options (e.g. legacy
        // data, or a typo entered before this dropdown existed), keep it
        // visible and selected instead of silently switching to the first
        // option — an admin saving the form shouldn't accidentally change
        // an unrelated field's value.
        if (!hasCurrentValue && currentValue) {
          const opt = document.createElement("option");
          opt.value = currentValue;
          opt.textContent = `${currentValue} (current value)`;
          opt.selected = true;
          input.insertBefore(opt, input.firstChild);
        }
      } else {
        input = document.createElement("input");
        input.type = col.type === "number" ? "number" : "text";
        if (col.type === "number") input.step = "any";
        input.value = currentValue;
      }

      if (notEditable) input.disabled = true;
      field.appendChild(input);

      editModalBody.appendChild(field);
      inputs[col.key] = input;
    });

    editModalSave.onclick = async () => {
      const body = { status: inputs.status.value };
      cfg.columns.forEach((col) => {
        if (col.editable === false || col.type === "date") return; // read-only, never sent
        body[col.key] = inputs[col.key].value;
      });

      editModalSave.disabled = true;
      editModalSave.textContent = "Saving…";
      try {
        const res = await apiFetch(`/api/records/${currentType}/${row.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not save changes.");
        closeEditModal();
        loadRecords();
      } catch (err) {
        editModalError.textContent = err.message;
        editModalError.classList.add("show");
      } finally {
        editModalSave.disabled = false;
        editModalSave.textContent = "Save Changes";
      }
    };

    editModalBackdrop.classList.add("open");
  }

  function formatValue(value, type) {
    if (value === null || value === undefined || value === "") return "";
    if (type === "date") {
      const d = new Date(value);
      return isNaN(d) ? String(value) : d.toLocaleString();
    }
    if (type === "boolean") return value ? "Yes" : "No";
    if (Array.isArray(value)) return value.join(", ");
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
})();