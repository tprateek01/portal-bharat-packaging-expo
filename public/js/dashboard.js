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

  // ---- State ----
  let TYPES = [];
  let STATUSES = [];
  let currentType = null;
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
  const modalBackdrop = document.getElementById("modalBackdrop");
  const modalBody = document.getElementById("modalBody");
  const modalClose = document.getElementById("modalClose");

  modalClose.addEventListener("click", () => modalBackdrop.classList.remove("open"));
  modalBackdrop.addEventListener("click", (e) => {
    if (e.target === modalBackdrop) modalBackdrop.classList.remove("open");
  });

  // ---- Load type/column config from the server ----
  const meta = await fetch("/api/types").then((r) => r.json());
  TYPES = meta.types;
  STATUSES = meta.statuses;
  currentType = TYPES[0].key;

  renderNav();
  renderStatusTabs();
  renderFilterBar();
  loadRecords();

  exportBtn.addEventListener("click", () => {
    const params = buildQueryParams({ forExport: true });
    window.location.href = `/api/records/${currentType}/export?${params.toString()}`;
  });

  // ---- Sidebar ----
  // Top-level entries (Visitors, Exhibitor EOI, Exhibitor Booking, …) all
  // render with identical styling. Any entry backed by a "group" of types
  // (e.g. Visitors -> Buyers/Delegates) becomes a toggle button with a
  // chevron that expands to reveal its nested items.
  function renderNav() {
    navList.innerHTML = "";

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
      currentType = t.key;
      currentStatus = "All";
      currentPage = 1;
      filterValues = {};
      renderNav();
      renderStatusTabs();
      renderFilterBar();
      loadRecords();
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
    return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
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
      const res = await fetch(`/api/records/${currentType}?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load records.");
      renderTable(cfg, data);
    } catch (err) {
      tableArea.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
      resultCount.textContent = "";
    }
  }

  function renderTable(cfg, data) {
    const { rows, total, page, pageSize } = data;

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
      cfg.columns.forEach((col) => {
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

        cfg.columns.forEach((col) => {
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
  const ICONS = {
    view: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    approve: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    reject: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/></svg>',
    inactive: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
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

    const inactiveBtn = document.createElement("button");
    inactiveBtn.className = "inactive";
    inactiveBtn.title = "Mark inactive";
    inactiveBtn.innerHTML = ICONS.inactive;
    inactiveBtn.addEventListener("click", () => updateStatus(row.id, "Inactive"));
    wrap.appendChild(inactiveBtn);

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
      const res = await fetch(`/api/records/${currentType}/${id}`, {
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
      const res = await fetch(`/api/records/${currentType}/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not delete record.");
      loadRecords();
    } catch (err) {
      alert(err.message);
    }
  }

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

  function formatValue(value, type) {
    if (value === null || value === undefined || value === "") return "";
    if (type === "date") {
      const d = new Date(value);
      return isNaN(d) ? String(value) : d.toLocaleString();
    }
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