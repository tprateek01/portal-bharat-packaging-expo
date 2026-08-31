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
  function renderNav() {
    navList.innerHTML = "";
    let lastGroup = undefined;

    TYPES.forEach((t) => {
      if (t.group && t.group !== lastGroup) {
        const heading = document.createElement("div");
        heading.className = "nav-group-heading";
        heading.textContent = t.group;
        navList.appendChild(heading);
      }
      lastGroup = t.group || undefined;

      const btn = document.createElement("button");
      btn.className = "nav-item" + (t.group ? " nested" : "") + (t.key === currentType ? " active" : "");
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
      navList.appendChild(btn);
    });
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
      cfg.columns.forEach((col) => {
        const th = document.createElement("th");
        th.textContent = col.label;
        headRow.appendChild(th);
      });
      ["Status", "Actions"].forEach((label) => {
        const th = document.createElement("th");
        th.textContent = label;
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      rows.forEach((row) => {
        const tr = document.createElement("tr");
        cfg.columns.forEach((col) => {
          const td = document.createElement("td");
          td.textContent = formatValue(row[col.key], col.type);
          tr.appendChild(td);
        });

        const statusTd = document.createElement("td");
        const pill = document.createElement("span");
        pill.className = `status-pill ${row.status}`;
        pill.textContent = row.status;
        statusTd.appendChild(pill);
        tr.appendChild(statusTd);

        const actionsTd = document.createElement("td");
        actionsTd.appendChild(buildRowActions(cfg, row));
        tr.appendChild(actionsTd);

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

  function buildRowActions(cfg, row) {
    const wrap = document.createElement("div");
    wrap.className = "row-actions";

    const viewBtn = document.createElement("button");
    viewBtn.className = "view";
    viewBtn.title = "View details";
    viewBtn.textContent = "👁";
    viewBtn.addEventListener("click", () => openModal(cfg, row));
    wrap.appendChild(viewBtn);

    const approveBtn = document.createElement("button");
    approveBtn.className = "approve";
    approveBtn.title = "Approve";
    approveBtn.textContent = "✓";
    approveBtn.addEventListener("click", () => updateStatus(row.id, "Approved"));
    wrap.appendChild(approveBtn);

    const rejectBtn = document.createElement("button");
    rejectBtn.className = "reject";
    rejectBtn.title = "Reject";
    rejectBtn.textContent = "✕";
    rejectBtn.addEventListener("click", () => updateStatus(row.id, "Rejected"));
    wrap.appendChild(rejectBtn);

    const inactiveBtn = document.createElement("button");
    inactiveBtn.title = "Mark inactive";
    inactiveBtn.textContent = "⏸";
    inactiveBtn.addEventListener("click", () => updateStatus(row.id, "Inactive"));
    wrap.appendChild(inactiveBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "delete";
    deleteBtn.title = "Delete";
    deleteBtn.textContent = "🗑";
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