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
  const hallStallArea = document.getElementById("hallStallArea");
  const analyticsArea = document.getElementById("analyticsArea");
  const recordsView = document.getElementById("recordsView");
  const addBtn = document.getElementById("addBtn");
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
    // Reset title/button text so the next modal (which may be a different
    // one — Edit Record, Add Stall, Allot Stall, ...) doesn't inherit
    // whatever the previous modal left behind.
    document.querySelector("#editModalBackdrop h2").textContent = "Edit Record";
    editModalSave.textContent = "Save Changes";
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
        { key: "analytics_exhibitors", label: "Exhibitors", custom: "analyticsExhibitors" },
        { key: "analytics_domestic_buyers", label: "Domestic Buyers", custom: "analyticsBuyers" },
      ],
    },
    {
      kind: "group",
      name: "Space Booking",
      items: [
        { key: "exhibitor_booking" },
        { key: "hall_stall_management", label: "Hall & Stall Management", custom: "hallStall" },
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
    { kind: "item", item: { key: "payments", label: "Payments" } },
    { kind: "item", item: { key: "service_requests", label: "Service Request Forms" } },
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
    hallStallArea.style.display = "none";
    analyticsArea.style.display = "none";
    recordsView.style.display = "none";
    exportBtn.style.display = "none";
    addBtn.style.display = "none";
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
    hallStallArea.style.display = "none";
    analyticsArea.style.display = "none";
    recordsView.style.display = "block";
    exportBtn.style.display = "";
    // Task 6/7: Payments and Service Request Forms are the only two
    // sections where an admin manually creates a new row (everything
    // else here is populated from the registration website).
    if (typeKey === "payments") {
      addBtn.style.display = "";
      addBtn.textContent = "+ Add Payment";
      addBtn.onclick = () => openPaymentModal();
    } else if (typeKey === "service_requests") {
      addBtn.style.display = "";
      addBtn.textContent = "+ Add Service Request";
      addBtn.onclick = () => openServiceRequestModal();
    } else {
      addBtn.style.display = "none";
    }
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
        showRecordsView(t.key);
        renderNav();
      });

      grid.appendChild(card);
    });

    overviewArea.appendChild(grid);
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
      showOverview();
      renderNav();
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
      if (t.custom === "bulkUpload") {
        showBulkUpload();
      } else if (t.custom === "hallStall") {
        showHallStall();
      } else if (t.custom === "analyticsExhibitors") {
        showAnalytics("exhibitors");
      } else if (t.custom === "analyticsBuyers") {
        showAnalytics("buyers");
      } else if (t.comingSoon) {
        showComingSoon(t.key, t.label, t.comingSoonNote);
      } else {
        showRecordsView(t.key);
      }
      renderNav();
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
    hallStallArea.style.display = "none";
    analyticsArea.style.display = "none";
    bulkUploadArea.style.display = "block";
    exportBtn.style.display = "none";
    addBtn.style.display = "none";
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
    hallStallArea.style.display = "none";
    analyticsArea.style.display = "none";
    comingSoonArea.style.display = "block";
    exportBtn.style.display = "none";
    addBtn.style.display = "none";
    pageTitle.textContent = label;
    comingSoonArea.innerHTML = `
      <div class="coming-soon-card">
        <div class="coming-soon-icon">🚧</div>
        <h2>${escapeHtml(label)} — Coming Soon</h2>
        <p>${escapeHtml(note || "This section is being built and will be available in a future update.")}</p>
      </div>
    `;
  }

  // ---- Hall & Stall Management (Task 3) ----
  // Owns its own small bit of state/rendering — it isn't a generic
  // TYPE_CONFIG record type (the data lives in the portal's own `stalls` /
  // `hall_managers` tables, not the registration site's schema).
  let stallMeta = null; // { floors, openSides } — loaded once, cached
  let hallStallTab = "Vacant"; // "Vacant" | "Allotted" | "HallManagers"
  let stallPage = 1;
  const STALL_PAGE_SIZE = 20;
  let stallFilters = { search: "", floor: "", openSides: "" };
  let stallDebounce = null;

  async function showHallStall() {
    currentType = "hall_stall_management";
    overviewArea.style.display = "none";
    comingSoonArea.style.display = "none";
    bulkUploadArea.style.display = "none";
    analyticsArea.style.display = "none";
    recordsView.style.display = "none";
    hallStallArea.style.display = "block";
    exportBtn.style.display = "none";
    addBtn.style.display = "none";
    pageTitle.textContent = "Hall & Stall Management";
    hallStallTab = "Vacant";
    stallPage = 1;
    stallFilters = { search: "", floor: "", openSides: "" };

    if (!stallMeta) {
      try {
        stallMeta = await apiFetch("/api/stalls/meta").then((r) => r.json());
      } catch {
        stallMeta = { floors: [], openSides: [] };
      }
    }
    renderHallStallShell();
  }

  function renderHallStallShell() {
    hallStallArea.innerHTML = `
      <div class="hs-toolbar">
        <div class="status-tabs" id="hsTabs"></div>
        <div class="hs-toolbar-actions">
          <button type="button" class="template-btn" id="hsUploadBtn">⬆ Upload Stalls</button>
          <button type="button" class="upload-submit-btn hs-add-btn" id="hsAddBtn">+ Add Stalls</button>
        </div>
      </div>
      <div class="filter-bar" id="hsFilterBar"></div>
      <div class="table-wrap">
        <div id="hsTableArea"><div class="loading-state">Loading…</div></div>
        <div class="table-footer">
          <span id="hsResultCount"></span>
          <div class="pager">
            <button id="hsPrevPage">‹ Prev</button>
            <span id="hsPageIndicator">Page 1</span>
            <button id="hsNextPage">Next ›</button>
          </div>
        </div>
      </div>
    `;
    document.getElementById("hsUploadBtn").addEventListener("click", showStallUpload);
    document.getElementById("hsAddBtn").addEventListener("click", () => {
      if (hallStallTab === "HallManagers") openHallManagerModal(null);
      else openStallModal(null);
    });
    renderHallStallTabs();
    renderHallStallFilterBar();
    loadHallStallTabData();
  }

  async function renderHallStallTabs() {
    const tabsEl = document.getElementById("hsTabs");
    if (!tabsEl) return;
    let counts = { Vacant: "…", Allotted: "…" };
    try {
      counts = await apiFetch("/api/stalls/counts").then((r) => r.json());
    } catch {
      counts = { Vacant: 0, Allotted: 0 };
    }
    const tabsAgain = document.getElementById("hsTabs");
    if (!tabsAgain) return; // navigated away while counts were loading
    tabsAgain.innerHTML = "";
    [
      { key: "Vacant", label: `Vacant Stalls (${counts.Vacant})` },
      { key: "Allotted", label: `Allotted Stalls (${counts.Allotted})` },
      { key: "HallManagers", label: "Hall Managers" },
    ].forEach((t) => {
      const btn = document.createElement("button");
      btn.textContent = t.label;
      btn.className = hallStallTab === t.key ? "active" : "";
      btn.addEventListener("click", () => {
        hallStallTab = t.key;
        stallPage = 1;
        document.getElementById("hsAddBtn").textContent = t.key === "HallManagers" ? "+ Add Hall Manager" : "+ Add Stalls";
        document.getElementById("hsUploadBtn").style.display = t.key === "HallManagers" ? "none" : "";
        renderHallStallTabs();
        renderHallStallFilterBar();
        loadHallStallTabData();
      });
      tabsAgain.appendChild(btn);
    });
    document.getElementById("hsAddBtn").textContent = hallStallTab === "HallManagers" ? "+ Add Hall Manager" : "+ Add Stalls";
    document.getElementById("hsUploadBtn").style.display = hallStallTab === "HallManagers" ? "none" : "";
  }

  function renderHallStallFilterBar() {
    const bar = document.getElementById("hsFilterBar");
    if (!bar) return;
    bar.innerHTML = "";
    if (hallStallTab === "HallManagers") return; // no filters on this tab

    const search = document.createElement("input");
    search.type = "text";
    search.placeholder = "Hall or stall number";
    search.value = stallFilters.search;
    search.addEventListener("input", () => {
      stallFilters.search = search.value;
      clearTimeout(stallDebounce);
      stallDebounce = setTimeout(() => {
        stallPage = 1;
        loadHallStallTabData();
      }, 400);
    });
    bar.appendChild(search);

    const floorSelect = document.createElement("select");
    floorSelect.innerHTML = `<option value="">All Floors</option>` + stallMeta.floors.map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join("");
    floorSelect.value = stallFilters.floor;
    floorSelect.addEventListener("change", () => {
      stallFilters.floor = floorSelect.value;
      stallPage = 1;
      loadHallStallTabData();
    });
    bar.appendChild(floorSelect);

    const sidesSelect = document.createElement("select");
    sidesSelect.innerHTML = `<option value="">All Sides</option>` + stallMeta.openSides.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
    sidesSelect.value = stallFilters.openSides;
    sidesSelect.addEventListener("change", () => {
      stallFilters.openSides = sidesSelect.value;
      stallPage = 1;
      loadHallStallTabData();
    });
    bar.appendChild(sidesSelect);
  }

  function loadHallStallTabData() {
    if (hallStallTab === "HallManagers") loadHallManagers();
    else loadStalls();
  }

  async function loadStalls() {
    const area = document.getElementById("hsTableArea");
    if (!area) return;
    area.innerHTML = '<div class="loading-state">Loading stalls…</div>';
    const params = new URLSearchParams({ status: hallStallTab, page: stallPage, pageSize: STALL_PAGE_SIZE });
    if (stallFilters.search) params.set("search", stallFilters.search);
    if (stallFilters.floor) params.set("floor", stallFilters.floor);
    if (stallFilters.openSides) params.set("openSides", stallFilters.openSides);
    try {
      const res = await apiFetch(`/api/stalls?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load stalls.");
      renderStallTable(data);
    } catch (err) {
      area.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
    }
  }

  function renderStallTable(data) {
    const area = document.getElementById("hsTableArea");
    if (!area) return;
    const { rows, total, page, pageSize } = data;

    if (rows.length === 0) {
      area.innerHTML = '<div class="empty-state">No stalls found.</div>';
    } else {
      const table = document.createElement("table");
      table.className = "data-table";
      table.innerHTML = `<thead><tr>
        <th>Actions</th><th>Hall Number</th><th>Stall Number</th><th>Floor</th>
        <th>Open Sides</th><th>Length</th><th>Breadth</th><th>Area (sqm)</th>
      </tr></thead>`;
      const tbody = document.createElement("tbody");
      rows.forEach((row) => {
        const tr = document.createElement("tr");
        const actionsTd = document.createElement("td");
        const wrap = document.createElement("div");
        wrap.className = "row-actions";
        const editBtn = document.createElement("button");
        editBtn.className = "edit";
        editBtn.title = "Edit stall";
        editBtn.innerHTML = ICONS.edit;
        editBtn.addEventListener("click", () => openStallModal(row));
        wrap.appendChild(editBtn);
        const deleteBtn = document.createElement("button");
        deleteBtn.className = "delete";
        deleteBtn.title = "Delete stall";
        deleteBtn.innerHTML = ICONS.delete;
        deleteBtn.addEventListener("click", () => deleteStall(row.id));
        wrap.appendChild(deleteBtn);
        actionsTd.appendChild(wrap);
        tr.appendChild(actionsTd);

        [row.hall_number, row.stall_number, row.floor, row.open_sides, row.length, row.breadth, row.area_sqm].forEach((val) => {
          const td = document.createElement("td");
          td.textContent = val === null || val === undefined || val === "" ? "—" : val;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      area.innerHTML = "";
      area.appendChild(table);
    }

    const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, total);
    document.getElementById("hsResultCount").textContent = `${start}-${end} of ${total} results`;
    document.getElementById("hsPageIndicator").textContent = `Page ${page}`;
    const prevBtn = document.getElementById("hsPrevPage");
    const nextBtn = document.getElementById("hsNextPage");
    prevBtn.disabled = page <= 1;
    nextBtn.disabled = end >= total;
    prevBtn.onclick = () => { if (stallPage > 1) { stallPage -= 1; loadStalls(); } };
    nextBtn.onclick = () => { if (end < total) { stallPage += 1; loadStalls(); } };
  }

  async function deleteStall(id) {
    if (!confirm("Delete this stall permanently? This cannot be undone.")) return;
    try {
      const res = await apiFetch(`/api/stalls/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not delete stall.");
      renderHallStallTabs();
      loadStalls();
    } catch (err) {
      alert(err.message);
    }
  }

  // Add/Edit Stall — reuses the generic edit modal shell (backdrop/body/
  // error/save button) but with its own fields, since stalls aren't a
  // TYPE_CONFIG record type.
  function openStallModal(row) {
    editModalError.classList.remove("show");
    editModalError.textContent = "";
    editModalBody.innerHTML = "";
    document.querySelector("#editModalBackdrop h2").textContent = row ? "Edit Stall" : "Add Stall";

    const fields = [
      { key: "hall_number", label: "Hall Number", type: "text" },
      { key: "stall_number", label: "Stall Number", type: "text" },
      { key: "floor", label: "Floor", type: "select", options: stallMeta.floors },
      { key: "open_sides", label: "Open Sides", type: "select", options: stallMeta.openSides },
      { key: "length", label: "Length", type: "number" },
      { key: "breadth", label: "Breadth", type: "number" },
    ];
    const inputs = {};
    fields.forEach((f) => {
      const field = document.createElement("div");
      field.className = "edit-field";
      const label = document.createElement("label");
      label.textContent = f.label;
      field.appendChild(label);
      let input;
      if (f.type === "select") {
        input = document.createElement("select");
        input.innerHTML = `<option value="">Select…</option>` + f.options.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("");
        if (row && row[f.key]) input.value = row[f.key];
      } else {
        input = document.createElement("input");
        input.type = f.type;
        if (f.type === "number") input.step = "any";
        if (row && row[f.key] !== null && row[f.key] !== undefined) input.value = row[f.key];
      }
      field.appendChild(input);
      editModalBody.appendChild(field);
      inputs[f.key] = input;
    });

    if (row) {
      const field = document.createElement("div");
      field.className = "edit-field status-field";
      const label = document.createElement("label");
      label.textContent = "Status";
      const select = document.createElement("select");
      STALL_STATUSES_CLIENT.forEach((s) => {
        const opt = document.createElement("option");
        opt.value = s;
        opt.textContent = s;
        if (s === row.status) opt.selected = true;
        select.appendChild(opt);
      });
      field.appendChild(label);
      field.appendChild(select);
      editModalBody.appendChild(field);
      inputs.status = select;
    }

    editModalSave.onclick = async () => {
      const body = {};
      fields.forEach((f) => (body[f.key] = inputs[f.key].value));
      if (inputs.status) body.status = inputs.status.value;

      if (!body.hall_number.trim() || !body.stall_number.trim()) {
        editModalError.textContent = "Hall Number and Stall Number are required.";
        editModalError.classList.add("show");
        return;
      }

      editModalSave.disabled = true;
      editModalSave.textContent = "Saving…";
      try {
        const url = row ? `/api/stalls/${row.id}` : "/api/stalls";
        const res = await apiFetch(url, {
          method: row ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not save stall.");
        closeEditModal();
        document.querySelector("#editModalBackdrop h2").textContent = "Edit Record";
        renderHallStallTabs();
        loadStalls();
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
  const STALL_STATUSES_CLIENT = ["Vacant", "Allotted"];

  // ---- Hall Managers tab ----
  async function loadHallManagers() {
    const area = document.getElementById("hsTableArea");
    if (!area) return;
    area.innerHTML = '<div class="loading-state">Loading hall managers…</div>';
    try {
      const res = await apiFetch("/api/hall-managers");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load hall managers.");
      renderHallManagerTable(data.rows);
    } catch (err) {
      area.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
    }
    document.getElementById("hsResultCount").textContent = "";
    document.getElementById("hsPageIndicator").textContent = "Page 1";
    document.getElementById("hsPrevPage").disabled = true;
    document.getElementById("hsNextPage").disabled = true;
  }

  function renderHallManagerTable(rows) {
    const area = document.getElementById("hsTableArea");
    if (!area) return;
    if (!rows || rows.length === 0) {
      area.innerHTML = '<div class="empty-state">No hall managers added yet.</div>';
      return;
    }
    const table = document.createElement("table");
    table.className = "data-table";
    table.innerHTML = `<thead><tr><th>Actions</th><th>Hall Number</th><th>Manager Name</th><th>Mobile</th><th>Email</th></tr></thead>`;
    const tbody = document.createElement("tbody");
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      const actionsTd = document.createElement("td");
      const wrap = document.createElement("div");
      wrap.className = "row-actions";
      const editBtn = document.createElement("button");
      editBtn.className = "edit";
      editBtn.title = "Edit";
      editBtn.innerHTML = ICONS.edit;
      editBtn.addEventListener("click", () => openHallManagerModal(row));
      wrap.appendChild(editBtn);
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "delete";
      deleteBtn.title = "Delete";
      deleteBtn.innerHTML = ICONS.delete;
      deleteBtn.addEventListener("click", () => deleteHallManager(row.id));
      wrap.appendChild(deleteBtn);
      actionsTd.appendChild(wrap);
      tr.appendChild(actionsTd);

      [row.hall_number, row.manager_name, row.mobile_number, row.email].forEach((val) => {
        const td = document.createElement("td");
        td.textContent = val || "—";
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    area.innerHTML = "";
    area.appendChild(table);
  }

  async function deleteHallManager(id) {
    if (!confirm("Remove this hall manager?")) return;
    try {
      const res = await apiFetch(`/api/hall-managers/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not delete hall manager.");
      loadHallManagers();
    } catch (err) {
      alert(err.message);
    }
  }

  function openHallManagerModal(row) {
    editModalError.classList.remove("show");
    editModalError.textContent = "";
    editModalBody.innerHTML = "";
    document.querySelector("#editModalBackdrop h2").textContent = row ? "Edit Hall Manager" : "Add Hall Manager";

    const fields = [
      { key: "hall_number", label: "Hall Number" },
      { key: "manager_name", label: "Manager Name" },
      { key: "mobile_number", label: "Mobile Number" },
      { key: "email", label: "Email" },
    ];
    const inputs = {};
    fields.forEach((f) => {
      const field = document.createElement("div");
      field.className = "edit-field";
      const label = document.createElement("label");
      label.textContent = f.label;
      field.appendChild(label);
      const input = document.createElement("input");
      input.type = "text";
      if (row && row[f.key]) input.value = row[f.key];
      field.appendChild(input);
      editModalBody.appendChild(field);
      inputs[f.key] = input;
    });

    editModalSave.onclick = async () => {
      const body = {};
      fields.forEach((f) => (body[f.key] = inputs[f.key].value));
      if (!body.hall_number.trim() || !body.manager_name.trim()) {
        editModalError.textContent = "Hall Number and Manager Name are required.";
        editModalError.classList.add("show");
        return;
      }
      editModalSave.disabled = true;
      editModalSave.textContent = "Saving…";
      try {
        const url = row ? `/api/hall-managers/${row.id}` : "/api/hall-managers";
        const res = await apiFetch(url, {
          method: row ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not save hall manager.");
        closeEditModal();
        document.querySelector("#editModalBackdrop h2").textContent = "Edit Record";
        loadHallManagers();
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

  // ---- Upload Stalls sub-page (same dropzone pattern as Domestic Buyer
  // Bulk Upload, pointed at the stalls endpoints) ----
  let selectedStallFile = null;

  function showStallUpload() {
    hallStallArea.innerHTML = `
      <button type="button" class="hs-back-btn" id="hsBackBtn">‹ Back to Hall & Stall Management</button>
      <div class="bulk-upload-layout">
        <div class="bulk-upload-main">
          <div class="bulk-upload-toolbar">
            <span class="bulk-upload-toolbar-label">Upload Stalls</span>
            <button type="button" class="template-btn" id="stallTemplateBtn">⬇ Download Template</button>
          </div>
          <div class="dropzone" id="stallDropzone">
            <div class="dropzone-icon">📤</div>
            <div class="dropzone-title">Drop or Select file</div>
            <div class="dropzone-sub">Drop files here or click <span class="dropzone-browse">browse</span> through your machine</div>
            <input type="file" id="stallFileInput" accept=".xlsx" hidden />
          </div>
          <div class="dropzone-hint">Allowed *.xlsx, max size of 10 MB</div>
          <div id="stallSelectedFileRow" class="selected-file-row" style="display:none;"></div>
          <button type="button" class="primary-btn upload-submit-btn" id="stallUploadSubmitBtn" disabled>Upload</button>
          <div id="stallUploadResult" class="upload-result" style="display:none;"></div>
        </div>
        <div class="bulk-upload-history">
          <h3>Uploads</h3>
          <div id="stallUploadsListArea"><div class="loading-state">Loading…</div></div>
        </div>
      </div>
    `;

    document.getElementById("hsBackBtn").addEventListener("click", renderHallStallShell);
    document.getElementById("stallTemplateBtn").addEventListener("click", () => {
      window.location.href = "/api/stalls/upload/template";
    });

    const dropzone = document.getElementById("stallDropzone");
    const fileInput = document.getElementById("stallFileInput");
    const selectedFileRow = document.getElementById("stallSelectedFileRow");
    const uploadSubmitBtn = document.getElementById("stallUploadSubmitBtn");
    const uploadResult = document.getElementById("stallUploadResult");

    dropzone.addEventListener("click", () => fileInput.click());
    dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("dragover"); });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
      if (e.dataTransfer.files && e.dataTransfer.files[0]) handleStallFileSelected(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener("change", () => {
      if (fileInput.files && fileInput.files[0]) handleStallFileSelected(fileInput.files[0]);
    });

    function handleStallFileSelected(file) {
      uploadResult.style.display = "none";
      if (!/\.xlsx$/i.test(file.name)) {
        selectedFileRow.style.display = "flex";
        selectedFileRow.innerHTML = `<span class="selected-file-error">"${escapeHtml(file.name)}" is not a .xlsx file. Please pick a .xlsx file.</span>`;
        uploadSubmitBtn.disabled = true;
        selectedStallFile = null;
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        selectedFileRow.style.display = "flex";
        selectedFileRow.innerHTML = `<span class="selected-file-error">File is larger than 10 MB.</span>`;
        uploadSubmitBtn.disabled = true;
        selectedStallFile = null;
        return;
      }
      selectedStallFile = file;
      selectedFileRow.style.display = "flex";
      selectedFileRow.innerHTML = `
        <span class="selected-file-name">📄 ${escapeHtml(file.name)} <span class="selected-file-size">(${(file.size / 1024).toFixed(1)} KB)</span></span>
        <button type="button" class="selected-file-remove" id="stallRemoveFileBtn">✕</button>
      `;
      uploadSubmitBtn.disabled = false;
      document.getElementById("stallRemoveFileBtn").addEventListener("click", (e) => {
        e.stopPropagation();
        selectedStallFile = null;
        fileInput.value = "";
        selectedFileRow.style.display = "none";
        uploadSubmitBtn.disabled = true;
      });
    }

    uploadSubmitBtn.addEventListener("click", async () => {
      if (!selectedStallFile) return;
      uploadSubmitBtn.disabled = true;
      uploadSubmitBtn.textContent = "Uploading…";
      uploadResult.style.display = "none";
      const formData = new FormData();
      formData.append("file", selectedStallFile);
      try {
        const res = await apiFetch("/api/stalls/bulk-upload", { method: "POST", body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Upload failed.");
        uploadResult.style.display = "block";
        uploadResult.className = `upload-result ${data.failedCount > 0 ? "has-errors" : "success"}`;
        uploadResult.innerHTML = `
          <strong>${data.successCount} of ${data.totalRows} row${data.totalRows === 1 ? "" : "s"} imported successfully.</strong>
          ${data.failedCount > 0 ? `<div class="upload-result-fail-line">${data.failedCount} row${data.failedCount === 1 ? "" : "s"} failed — <a href="/api/stalls/bulk-uploads/${data.upload.id}/failure-report">download failure report</a>.</div>` : ""}
        `;
        selectedStallFile = null;
        fileInput.value = "";
        selectedFileRow.style.display = "none";
        loadStallUploadsList();
      } catch (err) {
        uploadResult.style.display = "block";
        uploadResult.className = "upload-result has-errors";
        uploadResult.innerHTML = `<strong>${escapeHtml(err.message)}</strong>`;
      } finally {
        uploadSubmitBtn.disabled = !selectedStallFile;
        uploadSubmitBtn.textContent = "Upload";
      }
    });

    loadStallUploadsList();
  }

  async function loadStallUploadsList() {
    const area = document.getElementById("stallUploadsListArea");
    if (!area) return;
    try {
      const res = await apiFetch("/api/stalls/bulk-uploads");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load upload history.");
      if (!data.uploads || data.uploads.length === 0) {
        area.innerHTML = '<div class="empty-state">No uploads yet.</div>';
        return;
      }
      area.innerHTML = "";
      data.uploads.forEach((u) => {
        const card = document.createElement("div");
        card.className = "upload-history-card";
        const statusClass = u.failed_count > 0 ? "has-errors" : "success";
        const statusLabel = u.failed_count > 0 ? "COMPLETED WITH ERRORS" : "COMPLETED";
        card.innerHTML = `
          <div class="upload-history-name">${escapeHtml(u.filename)}</div>
          <div class="upload-history-meta">Uploaded by: ${escapeHtml(u.uploaded_by || "—")}</div>
          <span class="upload-history-status ${statusClass}">${statusLabel}</span>
          <div class="upload-history-meta">Date: ${escapeHtml(formatValue(u.created_at, "date"))}</div>
          <div class="upload-history-counts">${u.success_count} imported${u.failed_count > 0 ? `, ${u.failed_count} failed` : ""} of ${u.total_rows}</div>
          ${u.failed_count > 0 ? `<a class="upload-history-download" href="/api/stalls/bulk-uploads/${u.id}/failure-report">⬇ Failure report</a>` : ""}
        `;
        area.appendChild(card);
      });
    } catch (err) {
      area.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
    }
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
    allot: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
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

    // Task 4: Space Booking <-> Stall linking — only exhibitors (Space
    // Booking) get this button; other record types don't have stalls.
    if (currentType === "exhibitor_booking") {
      const allotBtn = document.createElement("button");
      allotBtn.className = "allot";
      allotBtn.title = row.allotted_stall_number ? "Change / unallot stall" : "Allot a stall";
      allotBtn.innerHTML = ICONS.allot;
      allotBtn.addEventListener("click", () => openAllotStallModal(row));
      wrap.appendChild(allotBtn);
    }

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

  // ---- Task 4: Allot Stall modal (Space Booking row action) ----
  // Reuses the generic edit modal shell, but with custom search-and-pick
  // content instead of a field list — allotment isn't a plain column edit.
  function openAllotStallModal(row) {
    editModalError.classList.remove("show");
    editModalError.textContent = "";
    editModalBody.innerHTML = "";
    document.querySelector("#editModalBackdrop h2").textContent = "Allot Stall";

    let selectedStall = null; // { id, hall_number, stall_number }
    let allotDebounce = null;

    const currentWrap = document.createElement("div");
    currentWrap.className = "allot-current";
    currentWrap.innerHTML = row.allotted_stall_number
      ? `Currently allotted: <strong>${escapeHtml(row.allotted_hall_number || "")} / ${escapeHtml(row.allotted_stall_number)}</strong>`
      : `<span class="allot-none">No stall allotted yet.</span>`;
    editModalBody.appendChild(currentWrap);

    const searchField = document.createElement("div");
    searchField.className = "edit-field";
    const label = document.createElement("label");
    label.textContent = "Search a vacant stall (hall or stall number)";
    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = "e.g. H10 or H10-06/348";
    searchField.appendChild(label);
    searchField.appendChild(searchInput);
    editModalBody.appendChild(searchField);

    const resultsArea = document.createElement("div");
    resultsArea.className = "allot-results";
    editModalBody.appendChild(resultsArea);

    async function searchVacantStalls(term) {
      resultsArea.innerHTML = '<div class="loading-state">Searching…</div>';
      try {
        const params = new URLSearchParams({ status: "Vacant", pageSize: "10" });
        if (term) params.set("search", term);
        const res = await apiFetch(`/api/stalls?${params.toString()}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not search stalls.");
        renderStallResults(data.rows);
      } catch (err) {
        resultsArea.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
      }
    }

    function renderStallResults(stalls) {
      if (!stalls || stalls.length === 0) {
        resultsArea.innerHTML = '<div class="empty-state">No vacant stalls match.</div>';
        return;
      }
      resultsArea.innerHTML = "";
      stalls.forEach((s) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "allot-result-item" + (selectedStall && selectedStall.id === s.id ? " selected" : "");
        item.innerHTML = `<span>${escapeHtml(s.hall_number)} / ${escapeHtml(s.stall_number)}</span><span class="allot-result-meta">${escapeHtml(s.floor || "")}${s.area_sqm ? ` · ${s.area_sqm} sqm` : ""}</span>`;
        item.addEventListener("click", () => {
          selectedStall = s;
          resultsArea.querySelectorAll(".allot-result-item").forEach((el) => el.classList.remove("selected"));
          item.classList.add("selected");
        });
        resultsArea.appendChild(item);
      });
    }

    searchInput.addEventListener("input", () => {
      clearTimeout(allotDebounce);
      allotDebounce = setTimeout(() => searchVacantStalls(searchInput.value), 350);
    });
    searchVacantStalls("");

    // Unallot button only makes sense when a stall is already assigned —
    // added as an extra action alongside Cancel/Save rather than inside
    // the scrolling modal body.
    if (row.allotted_stall_number) {
      const unallotBtn = document.createElement("button");
      unallotBtn.type = "button";
      unallotBtn.className = "allot-unallot-btn";
      unallotBtn.textContent = "Unallot Current Stall";
      unallotBtn.addEventListener("click", async () => {
        unallotBtn.disabled = true;
        unallotBtn.textContent = "Removing…";
        try {
          const res = await apiFetch(`/api/exhibitor-booking/${row.id}/unallot-stall`, { method: "POST" });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Could not unallot stall.");
          closeEditModal();
          document.querySelector("#editModalBackdrop h2").textContent = "Edit Record";
          loadRecords();
        } catch (err) {
          editModalError.textContent = err.message;
          editModalError.classList.add("show");
        } finally {
          unallotBtn.disabled = false;
          unallotBtn.textContent = "Unallot Current Stall";
        }
      });
      editModalBody.appendChild(unallotBtn);
    }

    editModalSave.textContent = "Allot Selected Stall";
    editModalSave.onclick = async () => {
      if (!selectedStall) {
        editModalError.textContent = "Pick a vacant stall from the list first.";
        editModalError.classList.add("show");
        return;
      }
      editModalSave.disabled = true;
      editModalSave.textContent = "Allotting…";
      try {
        const res = await apiFetch(`/api/exhibitor-booking/${row.id}/allot-stall`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stallId: selectedStall.id }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not allot stall.");
        closeEditModal();
        document.querySelector("#editModalBackdrop h2").textContent = "Edit Record";
        editModalSave.textContent = "Save Changes";
        loadRecords();
      } catch (err) {
        editModalError.textContent = err.message;
        editModalError.classList.add("show");
      } finally {
        editModalSave.disabled = false;
        editModalSave.textContent = "Allot Selected Stall";
      }
    };

    editModalBackdrop.classList.add("open");
  }

  // ---- Task 6: Add Payment modal ----
  // Editing an existing payment (amount/mode/reference/date/remarks/status)
  // reuses the generic openEditModal above — the pencil action already
  // works for it since "payments" is a normal TYPE_CONFIG type. This modal
  // only covers *creating* a new payment, because that needs an exhibitor
  // picker the generic Add-a-record flow doesn't have.
  const PAYMENT_MODES_CLIENT = ["Cash", "Cheque", "NEFT", "RTGS", "UPI", "Credit Card", "Debit Card", "Other"];
  const SERVICE_REQUEST_TYPES_CLIENT = [
    "Electrical", "Furniture", "Internet / Wi-Fi", "Housekeeping", "Security",
    "Carpentry", "Signage", "Water Supply", "Other",
  ];

  // Shared by both Add modals: a debounced "search company name -> pick
  // one exhibitor" control, same interaction as the Allot Stall search.
  function buildExhibitorPicker(onPick) {
    let selected = null;
    let debounceId = null;

    const searchField = document.createElement("div");
    searchField.className = "edit-field";
    const label = document.createElement("label");
    label.textContent = "Search Exhibitor (company name)";
    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = "Start typing a company name…";
    searchField.appendChild(label);
    searchField.appendChild(searchInput);

    const selectedWrap = document.createElement("div");
    selectedWrap.className = "allot-current";
    selectedWrap.innerHTML = `<span class="allot-none">No exhibitor selected yet.</span>`;

    const resultsArea = document.createElement("div");
    resultsArea.className = "allot-results";

    async function search(term) {
      if (!term || !term.trim()) {
        resultsArea.innerHTML = "";
        return;
      }
      resultsArea.innerHTML = '<div class="loading-state">Searching…</div>';
      try {
        const params = new URLSearchParams({ search: term.trim(), pageSize: "10" });
        const res = await apiFetch(`/api/records/exhibitor_booking?${params.toString()}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not search exhibitors.");
        renderResults(data.rows);
      } catch (err) {
        resultsArea.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
      }
    }

    function renderResults(rows) {
      if (!rows || rows.length === 0) {
        resultsArea.innerHTML = '<div class="empty-state">No exhibitors match.</div>';
        return;
      }
      resultsArea.innerHTML = "";
      rows.forEach((r) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "allot-result-item";
        item.innerHTML = `<span>${escapeHtml(r.company_name || "—")}</span><span class="allot-result-meta">${escapeHtml(r.contact_email || "")}</span>`;
        item.addEventListener("click", () => {
          selected = r;
          selectedWrap.innerHTML = `Selected: <strong>${escapeHtml(r.company_name || "—")}</strong>`;
          resultsArea.innerHTML = "";
          searchInput.value = r.company_name || "";
          if (onPick) onPick(r);
        });
        resultsArea.appendChild(item);
      });
    }

    searchInput.addEventListener("input", () => {
      selected = null;
      if (onPick) onPick(null);
      clearTimeout(debounceId);
      debounceId = setTimeout(() => search(searchInput.value), 350);
    });

    return {
      fields: [searchField, resultsArea, selectedWrap],
      getSelected: () => selected,
    };
  }

  function buildPlainField(label, type) {
    const field = document.createElement("div");
    field.className = "edit-field";
    const labelEl = document.createElement("label");
    labelEl.textContent = label;
    field.appendChild(labelEl);
    const input = document.createElement("input");
    input.type = type === "number" ? "number" : "text";
    if (type === "number") input.step = "any";
    field.appendChild(input);
    return { field, input };
  }

  function buildSelectField(label, options) {
    const field = document.createElement("div");
    field.className = "edit-field";
    const labelEl = document.createElement("label");
    labelEl.textContent = label;
    field.appendChild(labelEl);
    const select = document.createElement("select");
    select.innerHTML = `<option value="">Select…</option>` + options.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("");
    field.appendChild(select);
    return { field, input: select };
  }

  function openPaymentModal() {
    editModalError.classList.remove("show");
    editModalError.textContent = "";
    editModalBody.innerHTML = "";
    document.querySelector("#editModalBackdrop h2").textContent = "Add Payment";

    const picker = buildExhibitorPicker();
    picker.fields.forEach((el) => editModalBody.appendChild(el));

    const amountF = buildPlainField("Amount (₹)", "number");
    const modeF = buildSelectField("Payment Mode", PAYMENT_MODES_CLIENT);
    const refF = buildPlainField("Transaction / Reference No.", "text");
    const dateF = buildPlainField("Payment Date (YYYY-MM-DD)", "text");
    const remarksF = buildPlainField("Remarks", "text");
    [amountF, modeF, refF, dateF, remarksF].forEach((f) => editModalBody.appendChild(f.field));

    editModalSave.textContent = "Save Payment";
    editModalSave.onclick = async () => {
      const exhibitor = picker.getSelected();
      if (!exhibitor) {
        editModalError.textContent = "Search and select an exhibitor first.";
        editModalError.classList.add("show");
        return;
      }
      const amountValue = amountF.input.value;
      if (!amountValue || Number(amountValue) <= 0) {
        editModalError.textContent = "Enter a valid amount.";
        editModalError.classList.add("show");
        return;
      }

      editModalSave.disabled = true;
      editModalSave.textContent = "Saving…";
      try {
        const res = await apiFetch("/api/payments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            exhibitorBookingId: exhibitor.id,
            amount: amountValue,
            payment_mode: modeF.input.value,
            transaction_reference: refF.input.value,
            payment_date: dateF.input.value,
            remarks: remarksF.input.value,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not record payment.");
        closeEditModal();
        document.querySelector("#editModalBackdrop h2").textContent = "Edit Record";
        editModalSave.textContent = "Save Changes";
        loadRecords();
      } catch (err) {
        editModalError.textContent = err.message;
        editModalError.classList.add("show");
      } finally {
        editModalSave.disabled = false;
        editModalSave.textContent = "Save Payment";
      }
    };

    editModalBackdrop.classList.add("open");
  }

  // ---- Task 7: Add Service Request modal (same shape as Add Payment) ----
  function openServiceRequestModal() {
    editModalError.classList.remove("show");
    editModalError.textContent = "";
    editModalBody.innerHTML = "";
    document.querySelector("#editModalBackdrop h2").textContent = "Add Service Request";

    const picker = buildExhibitorPicker();
    picker.fields.forEach((el) => editModalBody.appendChild(el));

    const typeF = buildSelectField("Service Type", SERVICE_REQUEST_TYPES_CLIENT);
    const descF = buildPlainField("Description", "text");
    const dateF = buildPlainField("Requested Date (YYYY-MM-DD)", "text");
    [typeF, descF, dateF].forEach((f) => editModalBody.appendChild(f.field));

    editModalSave.textContent = "Save Request";
    editModalSave.onclick = async () => {
      const exhibitor = picker.getSelected();
      if (!exhibitor) {
        editModalError.textContent = "Search and select an exhibitor first.";
        editModalError.classList.add("show");
        return;
      }
      if (!typeF.input.value) {
        editModalError.textContent = "Select a service type.";
        editModalError.classList.add("show");
        return;
      }

      editModalSave.disabled = true;
      editModalSave.textContent = "Saving…";
      try {
        const res = await apiFetch("/api/service-requests", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            exhibitorBookingId: exhibitor.id,
            request_type: typeF.input.value,
            description: descF.input.value,
            requested_date: dateF.input.value,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not save service request.");
        closeEditModal();
        document.querySelector("#editModalBackdrop h2").textContent = "Edit Record";
        editModalSave.textContent = "Save Changes";
        loadRecords();
      } catch (err) {
        editModalError.textContent = err.message;
        editModalError.classList.add("show");
      } finally {
        editModalSave.disabled = false;
        editModalSave.textContent = "Save Request";
      }
    };

    editModalBackdrop.classList.add("open");
  }

  // ---- Task 8: Analytics ----
  async function showAnalytics(kind) {
    currentType = kind === "exhibitors" ? "analytics_exhibitors" : "analytics_domestic_buyers";
    overviewArea.style.display = "none";
    comingSoonArea.style.display = "none";
    bulkUploadArea.style.display = "none";
    hallStallArea.style.display = "none";
    recordsView.style.display = "none";
    analyticsArea.style.display = "block";
    exportBtn.style.display = "none";
    addBtn.style.display = "none";
    pageTitle.textContent = kind === "exhibitors" ? "Exhibitor Analytics" : "Domestic Buyer Analytics";
    analyticsArea.innerHTML = '<div class="loading-state">Loading analytics…</div>';

    try {
      const res = await apiFetch(kind === "exhibitors" ? "/api/analytics/exhibitors" : "/api/analytics/buyers");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load analytics.");
      if (kind === "exhibitors") renderExhibitorAnalytics(data);
      else renderBuyerAnalytics(data);
    } catch (err) {
      analyticsArea.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
    }
  }

  function statCard(value, label) {
    return `<div class="analytics-stat-card"><div class="analytics-stat-value">${escapeHtml(String(value))}</div><div class="analytics-stat-label">${escapeHtml(label)}</div></div>`;
  }

  function barSection(title, items) {
    if (!items || items.length === 0) {
      return `<div class="analytics-section"><div class="analytics-section-title">${escapeHtml(title)}</div><div class="empty-state">No data yet.</div></div>`;
    }
    const max = Math.max(...items.map((i) => i.count), 1);
    const rows = items
      .map(
        (i) => `
      <div class="analytics-bar-row">
        <span class="analytics-bar-label" title="${escapeHtml(i.label)}">${escapeHtml(i.label)}</span>
        <div class="analytics-bar-track"><div class="analytics-bar-fill" style="width:${Math.round((i.count / max) * 100)}%"></div></div>
        <span class="analytics-bar-count">${i.count}</span>
      </div>`
      )
      .join("");
    return `<div class="analytics-section"><div class="analytics-section-title">${escapeHtml(title)}</div>${rows}</div>`;
  }

  function trendSection(title, items) {
    if (!items || items.length === 0) {
      return `<div class="analytics-section"><div class="analytics-section-title">${escapeHtml(title)}</div><div class="empty-state">No data yet.</div></div>`;
    }
    const max = Math.max(...items.map((i) => i.count), 1);
    const w = 640, h = 140, pad = 10;
    const step = items.length > 1 ? (w - pad * 2) / (items.length - 1) : 0;
    const points = items
      .map((i, idx) => {
        const x = pad + step * idx;
        const y = h - pad - (i.count / max) * (h - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    return `
      <div class="analytics-section">
        <div class="analytics-section-title">${escapeHtml(title)}</div>
        <svg class="analytics-trend-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
          <polyline fill="none" stroke="var(--brand-pink)" stroke-width="2" points="${points}" />
        </svg>
        <div class="analytics-trend-labels"><span>${escapeHtml(items[0].label)}</span><span>${escapeHtml(items[items.length - 1].label)}</span></div>
      </div>
    `;
  }

  function renderExhibitorAnalytics(data) {
    const t = data.totals;
    let html = `<div class="analytics-stats-grid">
      ${statCard(t.totalExhibitors, "Total Exhibitors")}
      ${statCard(t.areaSqm.toLocaleString("en-IN"), "Area Booked (sqm)")}
      ${statCard("₹" + t.totalAmount.toLocaleString("en-IN"), "Total Amount")}
      ${statCard("₹" + t.paidAmount.toLocaleString("en-IN"), "Paid Amount")}
      ${statCard("₹" + t.outstandingAmount.toLocaleString("en-IN"), "Outstanding Amount")}
    </div>`;
    html += `<div class="analytics-grid-2">${barSection("Participation Category", data.byParticipation)}${barSection("Top Countries", data.byCountry)}</div>`;
    html += `<div class="analytics-grid-2">${barSection("Top States (India)", data.byState)}${data.bySector ? barSection("Product / Sector Wise", data.bySector) : '<div class="analytics-section"><div class="analytics-section-title">Product / Sector Wise</div><div class="empty-state">Not available for this event\'s data.</div></div>'}</div>`;
    html += trendSection("Registration Trend", data.trend);
    analyticsArea.innerHTML = html;
  }

  function renderBuyerAnalytics(data) {
    const t = data.totals;
    let html = `<div class="analytics-stats-grid">
      ${statCard(t.totalBuyers, "Total Buyers")}
      ${statCard(t.byStatus.Approved || 0, "Approved")}
      ${statCard(t.byStatus.Registered || 0, "Registered")}
      ${statCard(t.byStatus.Rejected || 0, "Rejected")}
    </div>`;
    html += `<div class="analytics-grid-2">${barSection("Country Wise", data.byCountry)}${trendSection("Registration Trend", data.trend)}</div>`;
    analyticsArea.innerHTML = html;
  }

  function formatValue(value, type) {
    if (value === null || value === undefined || value === "") return "";
    if (type === "date") {
      const d = new Date(value);
      return isNaN(d) ? String(value) : d.toLocaleString();
    }
    if (type === "date-only") {
      const d = new Date(value);
      return isNaN(d) ? String(value) : d.toLocaleDateString();
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