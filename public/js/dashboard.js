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

  // ---- Sidebar ----
  // Top-level entries (Visitors, Exhibitor EOI, Exhibitor Booking, …) all
  // render with identical styling. Any entry backed by a "group" of types
  // (e.g. Visitors -> Buyers/Delegates) becomes a toggle button with a
  // chevron that expands to reveal its nested items.
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

    // Walk TYPES once, grouping consecutive same-group entries while
    // preserving overall order (so groups can sit anywhere in the list).
    const sections = [];
    const seenGroups = new Set();
    TYPES.forEach((t) => {
      if (t.group) {
        if (!seenGroups.has(t.group)) {
          seenGroups.add(t.group);
          sections.push({ kind: "group", name: t.group, items: TYPES.filter((x) => x.group === t.group) });
        }
      } else {
        sections.push({ kind: "item", item: t });
      }
    });

    sections.forEach((section) => {
      if (section.kind === "item") {
        navList.appendChild(buildNavButton(section.item, false));
        return;
      }

      const { name, items } = section;
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
    btn.textContent = t.label;
    btn.addEventListener("click", () => {
      renderNav();
      showRecordsView(t.key);
    });
    return btn;
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