"use strict";

const STORAGE_KEY = "tienda_pos_mac_fes_acatlan_v1";
const app = document.querySelector("#app");
const money = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const clientId = sessionStorage.getItem("posClientId") || uid("client");
sessionStorage.setItem("posClientId", clientId);
const serverMode = location.protocol === "http:" || location.protocol === "https:";
const cloudConfig = window.PUNTONEXO_CLOUD || {};
const cloudMode = Boolean(cloudConfig.enabled && cloudConfig.supabaseUrl && cloudConfig.supabaseAnonKey && window.supabase);
const cloudBusinessId = cloudConfig.businessId || "default-store";
let cloudClient = null;
let cloudChannel = null;
let accessKey = sessionStorage.getItem("posAccessKey") || "";
let syncingFromServer = false;
let realtimeSource = null;

let state = loadState();
let session = JSON.parse(sessionStorage.getItem("posSession") || "null");
let currentView = "dashboard";
let activeAccountId = "cuenta-1";
let lowStockNotified = new Set(JSON.parse(sessionStorage.getItem("lowStockNotified") || "[]"));

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function nowTime() {
  return new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
}

function nowIso() {
  return new Date().toISOString();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function siteSettings() {
  return state.settings || seedState().settings;
}

function applyBranding() {
  const settings = siteSettings();
  document.documentElement.style.setProperty("--brand", settings.primaryColor || "#126a59");
  document.documentElement.style.setProperty("--brand-dark", settings.primaryColor || "#0a4c40");
  document.documentElement.style.setProperty("--accent", settings.accentColor || "#b84d2f");
  document.title = settings.siteName || "Sistema POS";
}

function loadState() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) return normalizeState(JSON.parse(stored));
  const initial = seedState();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
  return initial;
}

function normalizeState(data) {
  const fresh = seedState();
  data.settings = { ...fresh.settings, ...(data.settings || {}) };
  data.announcements = data.announcements || fresh.announcements;
  data.users = data.users || fresh.users;
  data.categories = data.categories || fresh.categories;
  data.products = data.products || fresh.products;
  data.cashRegisters = data.cashRegisters || [];
  data.sales = data.sales || [];
  data.expenses = data.expenses || [];
  data.movements = data.movements || [];
  data.returns = data.returns || [];
  data.cancellations = data.cancellations || [];
  data.operationLog = data.operationLog || [];
  data.backups = data.backups || [];
  data.authTokens = data.authTokens || [];
  data.settings.authorizationPin = data.settings.authorizationPin || "4321";
  data.products = data.products.map(normalizeProduct);
  return data;
}

function normalizeProduct(product) {
  product.stockUnit = product.stockUnit || "pieza";
  product.aliasCodes = product.aliasCodes || [];
  product.packageUnits = Number(product.packageUnits || 0);
  product.packagePrice = Number(product.packagePrice || 0);
  product.wholesaleMin = Number(product.wholesaleMin || 0);
  product.wholesalePrice = Number(product.wholesalePrice || 0);
  product.lots = Array.isArray(product.lots) && product.lots.length
    ? product.lots
    : [{ id: uid("lot"), qty: Number(product.units || 0), cost: Number(product.cost || 0), date: today(), reference: "Inventario inicial" }];
  return product;
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (cloudMode && !syncingFromServer) {
    pushStateToCloud();
    return;
  }
  if (serverMode && !syncingFromServer) {
    pushStateToServer();
  }
}

function getCloudClient() {
  if (!cloudMode) return null;
  if (!cloudClient) {
    cloudClient = window.supabase.createClient(cloudConfig.supabaseUrl, cloudConfig.supabaseAnonKey);
  }
  return cloudClient;
}

async function syncStateFromCloud() {
  const client = getCloudClient();
  if (!client) return false;
  try {
    const { data, error } = await client
      .from("pos_state")
      .select("state")
      .eq("business_id", cloudBusinessId)
      .single();
    if (error && error.code !== "PGRST116") throw error;
    if (data?.state) {
      syncingFromServer = true;
      state = normalizeState(data.state);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      syncingFromServer = false;
      render();
      return true;
    }
    await pushStateToCloud();
    return true;
  } catch (error) {
    console.warn("No se pudo sincronizar con nube:", error.message);
    toast("No se pudo conectar con la nube, usando datos locales");
    return false;
  }
}

async function pushStateToCloud() {
  const client = getCloudClient();
  if (!client) return;
  try {
    const { error } = await client
      .from("pos_state")
      .upsert({
        business_id: cloudBusinessId,
        state,
        updated_by: clientId,
        updated_at: new Date().toISOString()
      }, { onConflict: "business_id" });
    if (error) throw error;
  } catch (error) {
    console.warn("No se pudo guardar en nube:", error.message);
  }
}

function connectCloudRealtime() {
  const client = getCloudClient();
  if (!client || cloudChannel) return;
  cloudChannel = client
    .channel(`pos_state_${cloudBusinessId}`)
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "pos_state",
      filter: `business_id=eq.${cloudBusinessId}`
    }, payload => {
      if (payload.new?.updated_by === clientId) return;
      if (payload.new?.state) {
        syncingFromServer = true;
        state = normalizeState(payload.new.state);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        syncingFromServer = false;
        render();
        toast("Datos actualizados desde la nube");
      }
    })
    .subscribe();
}

async function syncStateFromServer() {
  if (cloudMode) {
    await syncStateFromCloud();
    return;
  }
  if (!serverMode) return;
  try {
    const response = await fetch("/api/state", { cache: "no-store", headers: accessKey ? { "X-Access-Key": accessKey } : {} });
    if (response.status === 401) {
      requestAccessKey();
      return;
    }
    if (!response.ok) throw new Error("No se pudo leer la base compartida");
    const payload = await response.json();
    if (payload.exists && payload.state) {
      syncingFromServer = true;
      state = payload.state;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      syncingFromServer = false;
      render();
      return;
    }
    await pushStateToServer();
  } catch (error) {
    console.warn("Modo local activo:", error.message);
  }
}

async function pushStateToServer() {
  try {
    await fetch("/api/state", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Id": clientId,
        ...(accessKey ? { "X-Access-Key": accessKey } : {})
      },
      body: JSON.stringify(state)
    });
  } catch (error) {
    console.warn("No se pudo guardar en servidor:", error.message);
  }
}

function connectRealtime() {
  if (cloudMode) {
    connectCloudRealtime();
    return;
  }
  if (!serverMode || realtimeSource) return;
  realtimeSource = new EventSource(`/api/events${accessKey ? `?accessKey=${encodeURIComponent(accessKey)}` : ""}`);
  realtimeSource.onmessage = async event => {
    const payload = JSON.parse(event.data);
    if (payload.sourceClientId === clientId) return;
    await syncStateFromServer();
    toast("Datos actualizados desde otro dispositivo");
  };
  realtimeSource.onerror = () => {
    console.warn("Conexion en tiempo real interrumpida");
  };
}

function requestAccessKey() {
  const key = prompt("Ingresa la clave de acceso compartido del sistema:");
  if (!key) {
    toast("Se requiere clave para usar la base compartida");
    return;
  }
  accessKey = key.trim();
  sessionStorage.setItem("posAccessKey", accessKey);
  if (realtimeSource) {
    realtimeSource.close();
    realtimeSource = null;
  }
  syncStateFromServer();
  connectRealtime();
}

function seedState() {
  const admin = uid("usr");
  const supervisor1 = uid("usr");
  const supervisor2 = uid("usr");
  const vendedor = uid("usr");
  const categories = [];
  const products = [];
  return {
    settings: {
      siteName: "PuntoNexo POS",
      logoText: "PN",
      tagline: "Plataforma comercial para ventas, caja e inventario",
      institutionName: "NexoDigital Soluciones",
      welcomeTitle: "PuntoNexo POS",
      welcomeText: "Solucion web autogestionable para operacion comercial, inventario, caja, promociones y reportes.",
      infoTitle: "Informacion general",
      infoText: "PuntoNexo POS es una aplicacion web desarrollada para optimizar el control interno de tiendas de productos varios mediante administracion de inventario, punto de venta, caja, usuarios, reportes y contenido informativo.",
      authorizationPin: "4321",
      primaryColor: "#174f63",
      accentColor: "#c46a2b"
    },
    announcements: [],
    users: [
      { id: admin, name: "Omar", username: "admin", password: "adminO123", role: "admin", active: true },
      { id: supervisor1, name: "Sonia", username: "supervisor1", password: "super1123", role: "supervisor", active: true },
      { id: supervisor2, name: "Toño F", username: "supervisor2", password: "super2123", role: "supervisor", active: true },
      { id: vendedor, name: "Cajero", username: "vendedor", password: "vend123", role: "vendedor", active: true }
    ],
    categories,
    products,
    cashRegisters: [],
    sales: [],
    expenses: [],
    movements: [],
    returns: [],
    cancellations: [],
    operationLog: [],
    backups: [],
    authTokens: []
  };
}

function productSeed(name, code, categoryId, units, cost, price, minStock) {
  return normalizeProduct({ id: uid("prd"), name, code, categoryId, units, cost, price, minStock, active: true });
}

function logOperation(type, tableName, recordId, description, userId = session?.userId) {
  state.operationLog.unshift({
    id: uid("log"),
    userId,
    type,
    tableName,
    recordId,
    description,
    date: today(),
    time: nowTime(),
    createdAt: nowIso()
  });
}

function currentUser() {
  return state.users.find(user => user.id === session?.userId);
}

function userName(id) {
  return state.users.find(user => user.id === id)?.name || "Sistema";
}

function categoryName(id) {
  return state.categories.find(category => category.id === id)?.name || "Sin tipo";
}

function unitLabel(product, qty = product.units) {
  const unit = product.stockUnit || "pieza";
  if (unit === "gramo") return `${qty} g`;
  if (unit === "miligramo") return `${qty} mg`;
  if (unit === "paquete") return `${qty} paquete(s)`;
  return `${qty} pieza(s)`;
}

function saleOptions(product) {
  const options = [
    { id: "base", name: product.stockUnit === "pieza" ? "Unidad" : `Venta por ${product.stockUnit}`, quantity: 1, price: Number(product.price || 0) }
  ];
  if (product.packageUnits > 1 && product.packagePrice > 0) {
    options.push({ id: "package", name: `Paquete de ${product.packageUnits}`, quantity: Number(product.packageUnits), price: Number(product.packagePrice) });
  }
  if (product.wholesaleMin > 1 && product.wholesalePrice > 0) {
    options.push({ id: "wholesale", name: `Mayoreo desde ${product.wholesaleMin}`, quantity: 1, price: Number(product.wholesalePrice), minQty: Number(product.wholesaleMin) });
  }
  return options;
}

function getSaleOption(product, optionId = "base") {
  return saleOptions(product).find(option => option.id === optionId) || saleOptions(product)[0];
}

function cartStockNeeded(line) {
  const product = state.products.find(p => p.id === line.productId);
  const option = getSaleOption(product, line.optionId);
  return option.quantity * line.qty;
}

function findProductByCode(code) {
  const normalized = code.toLowerCase();
  return state.products.find(item => item.active && [item.code, ...(item.aliasCodes || [])].some(value => String(value).toLowerCase() === normalized));
}

function consumeLots(product, qty) {
  let remaining = qty;
  let totalCost = 0;
  product.lots = product.lots || [];
  for (const lot of product.lots) {
    if (remaining <= 0) break;
    const take = Math.min(lot.qty, remaining);
    lot.qty -= take;
    remaining -= take;
    totalCost += take * Number(lot.cost || product.cost || 0);
  }
  product.lots = product.lots.filter(lot => lot.qty > 0.000001);
  if (remaining > 0) totalCost += remaining * Number(product.cost || 0);
  return totalCost;
}

function addLot(product, qty, cost, reference) {
  if (qty <= 0) return;
  product.lots = product.lots || [];
  product.lots.push({ id: uid("lot"), qty, cost: Number(cost), date: today(), reference });
}

function convertStockInput(product, receiptType, qty, unitsPerContainer) {
  if (receiptType === "box" || receiptType === "largePackage") return qty * unitsPerContainer;
  if (receiptType === "kg") return product.stockUnit === "miligramo" ? qty * 1000000 : qty * 1000;
  if (receiptType === "g") return product.stockUnit === "miligramo" ? qty * 1000 : qty;
  if (receiptType === "mg") return product.stockUnit === "gramo" ? qty / 1000 : qty;
  return qty;
}

function can(...roles) {
  return roles.includes(currentUser()?.role);
}

function openCash() {
  return state.cashRegisters.find(cash => cash.userId === session?.userId && cash.status === "abierta");
}

function activeAuthTokens() {
  const now = Date.now();
  state.authTokens = (state.authTokens || []).filter(token => !token.used && token.expiresAt > now);
  return state.authTokens;
}

function generateAuthToken() {
  activeAuthTokens();
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const token = {
    id: uid("tok"),
    code,
    createdBy: session.userId,
    createdAt: nowIso(),
    expiresAt: Date.now() + 3 * 60 * 1000,
    used: false
  };
  state.authTokens.unshift(token);
  logOperation("token_autorizacion", "authTokens", token.id, "Genero token temporal de autorizacion");
  saveState();
  return token;
}

function validateAuthorizationCode(code) {
  const clean = String(code || "").trim();
  if (!clean) return null;
  if (clean === String(siteSettings().authorizationPin || "")) {
    return { id: session.userId, name: "Clave fija de supervisor/admin", method: "pin" };
  }
  const token = activeAuthTokens().find(item => item.code === clean);
  if (!token) return null;
  token.used = true;
  const creator = state.users.find(user => user.id === token.createdBy);
  logOperation("uso_token_autorizacion", "authTokens", token.id, `Uso token generado por ${creator?.name || "supervisor/admin"}`);
  saveState();
  return { id: token.createdBy, name: creator?.name || "Supervisor/Admin", method: "token" };
}

function navItems() {
  const role = currentUser().role;
  const items = [
    { id: "dashboard", label: "Dashboard", roles: ["admin", "supervisor"] },
    { id: "pos", label: "Punto de venta", roles: ["admin", "supervisor", "vendedor"] },
    { id: "inventory", label: "Inventario", roles: ["admin", "supervisor"] },
    { id: "expenses", label: "Gastos", roles: ["admin", "supervisor", "vendedor"] },
    { id: "sales", label: "Ventas", roles: ["admin", "supervisor", "vendedor"] },
    { id: "cash", label: "Caja", roles: ["admin", "supervisor", "vendedor"] },
    { id: "reports", label: "Reportes", roles: ["admin", "supervisor"] },
    { id: "authorizations", label: "Autorizaciones", roles: ["admin", "supervisor"] },
    { id: "site", label: "Sitio", roles: ["admin"] },
    { id: "users", label: "Usuarios", roles: ["admin"] },
    { id: "backup", label: "Respaldos", roles: ["admin"] }
  ];
  return items.filter(item => item.roles.includes(role));
}

function render() {
  if (!session) return renderLogin();
  applyBranding();
  const items = navItems();
  if (!items.some(item => item.id === currentView)) currentView = items[0].id;
  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand-block">
          <div class="brand-row"><span class="logo-mark">${escapeHtml(siteSettings().logoText)}</span><strong>${escapeHtml(siteSettings().siteName)}</strong></div>
          <span>${escapeHtml(siteSettings().tagline)}</span>
        </div>
        <nav class="nav">
          ${items.map(item => `<button class="${currentView === item.id ? "active" : ""}" data-view="${item.id}">${item.label}</button>`).join("")}
        </nav>
        <div class="user-box">
          <strong>${currentUser().name}</strong>
          <span class="badge">${currentUser().role}</span>
          <button class="ghost" id="logout">Cerrar sesion</button>
        </div>
      </aside>
      <main class="content">
        ${viewHeader()}
        <section id="view-root"></section>
      </main>
    </div>
  `;
  document.querySelectorAll("[data-view]").forEach(button => {
    button.addEventListener("click", () => {
      currentView = button.dataset.view;
      render();
    });
  });
  document.querySelector("#logout").addEventListener("click", logout);
  const root = document.querySelector("#view-root");
  ({
    dashboard: renderDashboard,
    pos: renderPos,
    inventory: renderInventory,
    expenses: renderExpenses,
    sales: renderSales,
    cash: renderCash,
    reports: renderReports,
    authorizations: renderAuthorizations,
    site: renderSite,
    users: renderUsers,
    backup: renderBackup
  }[currentView])(root);
}

function viewHeader() {
  const labels = {
    dashboard: "Dashboard administrativo",
    pos: "Punto de venta",
    inventory: "Inventario",
    expenses: "Gastos",
    sales: "Ventas",
    cash: "Caja",
    reports: "Reportes",
    authorizations: "Autorizaciones",
    site: "Sitio web",
    users: "Usuarios",
    backup: "Respaldos"
  };
  return `<div class="topbar"><div><p class="eyebrow">${escapeHtml(siteSettings().institutionName)}</p><h1>${labels[currentView]}</h1></div>${cashBadge()}</div>`;
}

function cashBadge() {
  const cash = openCash();
  return cash
    ? `<span class="badge ok">Caja abierta: ${money.format(cash.initialAmount)}</span>`
    : `<span class="badge warn">Sin caja abierta</span>`;
}

function renderLogin() {
  applyBranding();
  app.innerHTML = document.querySelector("#login-template").innerHTML;
  document.querySelector(".login-card h1").textContent = siteSettings().welcomeTitle;
  document.querySelector(".login-card .eyebrow").textContent = siteSettings().institutionName;
  document.querySelector(".login-card .muted").textContent = siteSettings().welcomeText;
  document.title = siteSettings().siteName;
  document.querySelector("#login-form").addEventListener("submit", event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    const user = state.users.find(item => item.username === data.username && item.password === data.password && item.active);
    if (!user) return toast("Usuario o contrasena incorrectos");
    session = { userId: user.id, startedAt: nowIso(), accounts: [{ id: "cuenta-1", name: "Cuenta 1", items: [] }] };
    sessionStorage.setItem("posSession", JSON.stringify(session));
    logOperation("login", "users", user.id, "Inicio de sesion", user.id);
    saveState();
    currentView = user.role === "vendedor" ? "pos" : "dashboard";
    render();
  });
}

function logout() {
  if (openCash()) {
    toast("Debes cerrar caja y realizar corte antes de cerrar sesion");
    currentView = "cash";
    render();
    return;
  }
  logOperation("logout", "users", session.userId, "Cierre de sesion");
  saveState();
  session = null;
  sessionStorage.removeItem("posSession");
  render();
}

function renderDashboard(root) {
  const date = today();
  const sales = state.sales.filter(sale => sale.date === date && sale.status !== "cancelada");
  const expenses = state.expenses.filter(expense => expense.date === date);
  const totalSales = sales.reduce((sum, sale) => sum + sale.total, 0);
  const totalCost = sales.flatMap(sale => sale.items).reduce((sum, item) => sum + item.cost * item.qty, 0);
  const totalExpenses = expenses.reduce((sum, expense) => sum + expense.amount, 0);
  const lowProducts = state.products.filter(product => product.active && product.units <= product.minStock);
  root.innerHTML = `
    <div class="grid cols-4">
      ${metric("Ventas del dia", money.format(totalSales))}
      ${metric("Ganancia bruta", money.format(totalSales - totalCost))}
      ${metric("Gastos del dia", money.format(totalExpenses))}
      ${metric("Ganancia neta", money.format(totalSales - totalCost - totalExpenses))}
    </div>
    <div class="grid cols-2">
      <div class="panel">
        <h2>${escapeHtml(siteSettings().infoTitle)}</h2>
        <p class="muted">${escapeHtml(siteSettings().infoText)}</p>
      </div>
      <div class="panel">
        <div class="split"><h2>Novedades y promociones</h2>${can("admin") ? `<button class="tiny" id="edit-site-shortcut">Editar</button>` : ""}</div>
        ${announcementsHtml()}
      </div>
    </div>
    <div class="grid cols-2">
      <div class="panel">
        <div class="split"><h2>Productos con bajo stock</h2><span class="badge warn">${lowProducts.length}</span></div>
        ${lowProducts.length ? productStockTable(lowProducts) : `<p class="empty">No hay productos con pocas unidades.</p>`}
      </div>
      <div class="panel">
        <h2>Actividad reciente</h2>
        ${state.operationLog.length ? simpleLogTable(state.operationLog.slice(0, 8)) : `<p class="empty">Sin actividad registrada.</p>`}
      </div>
    </div>
    <div class="grid cols-2">
      <div class="panel"><h2>Ultimas ventas</h2>${salesTable(state.sales.slice(0, 7), false)}</div>
      <div class="panel"><h2>Cajas abiertas</h2>${cashTable(state.cashRegisters.filter(cash => cash.status === "abierta"))}</div>
    </div>
  `;
  document.querySelector("#edit-site-shortcut")?.addEventListener("click", () => {
    currentView = "site";
    render();
  });
}

function metric(label, value) {
  return `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`;
}

function renderPos(root) {
  const cash = openCash();
  if (!cash) {
    root.innerHTML = `
      <div class="panel">
        <h2>Caja requerida</h2>
        <p class="muted">Para realizar ventas primero debes abrir caja desde el modulo Caja.</p>
        <button class="primary compact" id="go-cash">Ir a Caja</button>
      </div>`;
    document.querySelector("#go-cash").addEventListener("click", () => {
      currentView = "cash";
      render();
    });
    return;
  }
  ensureAccounts();
  const account = currentAccount();
  root.innerHTML = `
    <div class="tabs">
      ${session.accounts.map(acc => `<button class="${acc.id === activeAccountId ? "active" : ""}" data-account="${acc.id}">${acc.name}</button>`).join("")}
      <button id="add-account">+ Cuenta</button>
    </div>
    <div class="pos-layout">
      <section class="panel">
        <div class="toolbar">
          <label>Escaner / codigo <input id="barcode-input" placeholder="Escanea o escribe el codigo y Enter" autocomplete="off"></label>
          <label>Busqueda rapida <input id="product-search" placeholder="Nombre o codigo"></label>
          <label>Tipo <select id="category-filter"><option value="">Todos</option>${state.categories.map(c => `<option value="${c.id}">${c.name}</option>`).join("")}</select></label>
        </div>
        <div class="product-list" id="product-list"></div>
      </section>
      <section class="panel">
        <div class="split"><h2>${account.name}</h2><button class="ghost tiny" id="clear-cart">Vaciar</button></div>
        <div id="cart-list">${cartHtml(account)}</div>
        <div class="total-box"><span>Total</span><span>${money.format(cartTotal(account))}</span></div>
        <button class="primary" id="charge" ${account.items.length ? "" : "disabled"}>Cobrar</button>
      </section>
    </div>
  `;
  document.querySelectorAll("[data-account]").forEach(button => button.addEventListener("click", () => {
    activeAccountId = button.dataset.account;
    saveSession();
    render();
  }));
  document.querySelector("#add-account").addEventListener("click", addAccount);
  document.querySelector("#clear-cart").addEventListener("click", () => {
    currentAccount().items = [];
    saveSession();
    render();
  });
  document.querySelector("#charge").addEventListener("click", showChargeModal);
  document.querySelector("#barcode-input").addEventListener("keydown", handleBarcodeScan);
  document.querySelector("#product-search").addEventListener("input", renderProductButtons);
  document.querySelector("#category-filter").addEventListener("change", renderProductButtons);
  bindCartEvents();
  renderProductButtons();
  document.querySelector("#barcode-input").focus();
}

function ensureAccounts() {
  if (!session.accounts?.length) session.accounts = [{ id: "cuenta-1", name: "Cuenta 1", items: [] }];
  if (!session.accounts.some(account => account.id === activeAccountId)) activeAccountId = session.accounts[0].id;
}

function currentAccount() {
  return session.accounts.find(account => account.id === activeAccountId);
}

function saveSession() {
  sessionStorage.setItem("posSession", JSON.stringify(session));
  sessionStorage.setItem("lowStockNotified", JSON.stringify([...lowStockNotified]));
}

function addAccount() {
  const number = session.accounts.length + 1;
  const account = { id: uid("cuenta"), name: `Cuenta ${number}`, items: [] };
  session.accounts.push(account);
  activeAccountId = account.id;
  saveSession();
  render();
}

function renderProductButtons() {
  const search = document.querySelector("#product-search")?.value.toLowerCase() || "";
  const categoryId = document.querySelector("#category-filter")?.value || "";
  const products = state.products
    .filter(product => product.active)
    .filter(product => !categoryId || product.categoryId === categoryId)
    .filter(product => !search || `${product.name} ${product.code}`.toLowerCase().includes(search));
  document.querySelector("#product-list").innerHTML = products.length
    ? products.map(product => `
      <button class="product-button" data-add-product="${product.id}">
        <strong>${product.name}</strong>
        <small>${product.code}</small>
        <small>${money.format(product.price)} | ${unitLabel(product)} disp.</small>
      </button>`).join("")
    : `<p class="empty">No se encontraron productos.</p>`;
  document.querySelectorAll("[data-add-product]").forEach(button => {
    button.addEventListener("click", () => {
      const product = state.products.find(item => item.id === button.dataset.addProduct);
      addToCart(button.dataset.addProduct, saleOptions(product).length > 1 ? null : "base");
    });
  });
}

function handleBarcodeScan(event) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  const input = event.currentTarget;
  const code = input.value.trim();
  if (!code) return;
  const product = findProductByCode(code);
  if (!product) {
    toast(`No existe producto con codigo ${code}`);
    input.select();
    return;
  }
  addToCart(product.id, "base");
}

function addToCart(productId, optionId = "base") {
  const product = state.products.find(item => item.id === productId);
  if (!product || product.units <= 0) return toast("Producto sin existencias");
  const options = saleOptions(product);
  if (!optionId && options.length > 1) return saleOptionModal(product);
  const option = getSaleOption(product, optionId);
  const account = currentAccount();
  const line = account.items.find(item => item.productId === productId && item.optionId === option.id);
  const currentQty = line?.qty || 0;
  if ((currentQty + 1) * option.quantity > product.units) return toast("No hay suficientes unidades");
  if (line) line.qty += 1;
  else account.items.push({ productId, optionId: option.id, optionName: option.name, unitQuantity: option.quantity, unitPrice: option.price, qty: 1 });
  saveSession();
  render();
}

function saleOptionModal(product) {
  showModal(`
    <h2>Elegir presentacion</h2>
    <p>${escapeHtml(product.name)} | Disponible: ${unitLabel(product)}</p>
    <div class="grid">
      ${saleOptions(product).map(option => `<button class="product-button" data-sale-option="${option.id}">
        <strong>${escapeHtml(option.name)}</strong>
        <small>Descuenta ${unitLabel(product, option.quantity)}</small>
        <small>${money.format(option.price)}</small>
      </button>`).join("")}
    </div>
    <button class="ghost" data-close-modal>Cerrar</button>
  `);
  document.querySelectorAll("[data-sale-option]").forEach(button => button.addEventListener("click", () => {
    closeModal();
    addToCart(product.id, button.dataset.saleOption);
  }));
}

function cartHtml(account) {
  if (!account.items.length) return `<p class="empty">Agrega productos a la cuenta.</p>`;
  return account.items.map(item => {
    const product = state.products.find(p => p.id === item.productId);
    return `<div class="cart-line">
      <div><strong>${product.name}</strong><br><small class="muted">${item.optionName || "Unidad"} | descuenta ${unitLabel(product, cartStockNeeded(item))}</small></div>
      <input data-cart-qty="${product.id}|${item.optionId || "base"}" type="number" min="1" max="${Math.floor(product.units / (item.unitQuantity || 1))}" value="${item.qty}">
      <strong>${money.format((item.unitPrice || product.price) * item.qty)}</strong>
      <button class="tiny danger" data-remove-cart="${product.id}|${item.optionId || "base"}">X</button>
    </div>`;
  }).join("");
}

function bindCartEvents() {
  document.querySelectorAll("[data-cart-qty]").forEach(input => {
    input.addEventListener("change", () => {
      const [productId, optionId] = input.dataset.cartQty.split("|");
      const product = state.products.find(p => p.id === productId);
      const line = currentAccount().items.find(item => item.productId === product.id && (item.optionId || "base") === optionId);
      const value = Math.max(1, Math.min(Number(input.value), Math.floor(product.units / (line.unitQuantity || 1))));
      line.qty = value;
      saveSession();
      render();
    });
  });
  document.querySelectorAll("[data-remove-cart]").forEach(button => {
    button.addEventListener("click", () => {
      const [productId, optionId] = button.dataset.removeCart.split("|");
      currentAccount().items = currentAccount().items.filter(item => !(item.productId === productId && (item.optionId || "base") === optionId));
      saveSession();
      render();
    });
  });
}

function cartTotal(account) {
  return account.items.reduce((sum, item) => {
    const product = state.products.find(p => p.id === item.productId);
    return sum + (item.unitPrice || product.price) * item.qty;
  }, 0);
}

function showChargeModal() {
  const account = currentAccount();
  const total = cartTotal(account);
  showModal(`
    <h2>Cobrar venta</h2>
    <p>Total a cobrar: <strong>${money.format(total)}</strong></p>
    <form id="charge-form" class="stack">
      <label>Folio de nota / ticket <input name="ticketFolio" required placeholder="Ej. 000123"></label>
      <label>Forma de pago
        <select name="paymentMethod" id="payment-method">
          <option value="efectivo">Efectivo</option>
          <option value="tarjeta">Tarjeta</option>
          <option value="transferencia">Transferencia</option>
        </select>
      </label>
      <label id="paid-label">Cantidad recibida <input name="paid" type="number" min="${total}" step="0.01" required></label>
      <p id="change-preview" class="badge">Cambio: ${money.format(0)}</p>
      <div class="actions"><button class="primary">Confirmar venta</button><button type="button" class="ghost" data-close-modal>Cancelar</button></div>
    </form>
  `);
  document.querySelector("#payment-method").addEventListener("change", event => {
    const isCash = event.target.value === "efectivo";
    document.querySelector("#paid-label").style.display = isCash ? "grid" : "none";
    document.querySelector("[name='paid']").required = isCash;
    document.querySelector("[name='paid']").value = isCash ? "" : total;
    document.querySelector("#change-preview").textContent = isCash ? `Cambio: ${money.format(0)}` : "Pago exacto sin cambio";
  });
  document.querySelector("[name='paid']").addEventListener("input", event => {
    document.querySelector("#change-preview").textContent = `Cambio: ${money.format(Math.max(0, Number(event.target.value) - total))}`;
  });
  document.querySelector("#charge-form").addEventListener("submit", event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    const paid = data.paymentMethod === "efectivo" ? Number(data.paid) : total;
    if (data.paymentMethod === "efectivo" && paid < total) return toast("El pago recibido es menor al total");
    validateSaleFolio(paid, data.paymentMethod, data.ticketFolio);
  });
}

function validateSaleFolio(paid, paymentMethod, ticketFolio) {
  const folio = ticketFolio.trim();
  const cash = openCash();
  const duplicated = state.sales.find(sale => sale.status !== "cancelada" && (sale.ticketFolio || "").trim().toLowerCase() === folio.toLowerCase());
  if (!duplicated) {
    completeSale(paid, paymentMethod, folio);
    return;
  }
  if (duplicated.cashId !== cash?.id) {
    showModal(`
      <h2>Folio ya utilizado</h2>
      <p>La nota <strong>${escapeHtml(folio)}</strong> ya pertenece a otra caja o a un corte anterior.</p>
      <p class="muted">Para continuar debes modificar el folio de la venta actual.</p>
      <div class="actions"><button class="primary" id="change-duplicate-folio">Modificar folio</button><button type="button" class="ghost" data-close-modal>Cancelar</button></div>
    `);
    document.querySelector("#change-duplicate-folio").addEventListener("click", showChargeModal);
    return;
  }
  showDuplicateFolioModal(duplicated, paid, paymentMethod, folio);
}

function showDuplicateFolioModal(existingSale, paid, paymentMethod, folio) {
  showModal(`
    <h2>Folio ya registrado</h2>
    <p>La nota <strong>${escapeHtml(folio)}</strong> ya existe en esta caja.</p>
    <div class="panel compact">
      <p>Total actual: <strong>${money.format(existingSale.total)}</strong></p>
      <p>Vendedor: ${userName(existingSale.userId)} | Hora: ${existingSale.time}</p>
    </div>
    <p class="muted">Si el cliente regreso por otro producto, puedes agregar esta venta al mismo folio con autorizacion de supervisor/admin.</p>
    <div class="actions">
      <button class="primary" id="append-existing-folio">Agregar a este folio</button>
      <button class="secondary" id="change-existing-folio">Modificar folio</button>
      <button type="button" class="ghost" data-close-modal>Cancelar</button>
    </div>
  `);
  document.querySelector("#append-existing-folio").addEventListener("click", () => {
    authorizeModal("Autorizar agregado a folio existente", authUser => {
      completeSale(paid, paymentMethod, folio, { appendToSaleId: existingSale.id, authorizedBy: authUser });
    });
  });
  document.querySelector("#change-existing-folio").addEventListener("click", showChargeModal);
}

function salePayments(sale) {
  if (Array.isArray(sale.payments) && sale.payments.length) return sale.payments;
  const method = sale.paymentMethod || "efectivo";
  return [{ method, amount: sale.total || 0, paid: sale.paid ?? sale.total ?? 0, change: sale.change || 0, time: sale.time }];
}

function salePaymentAmount(sale, method) {
  return salePayments(sale).filter(payment => payment.method === method).reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
}

function paymentLabel(sale) {
  const methods = [...new Set(salePayments(sale).map(payment => payment.method))];
  return methods.length === 1 ? methods[0] : "mixto";
}

function completeSale(paid, paymentMethod = "efectivo", ticketFolio = "", options = {}) {
  const cash = openCash();
  const account = currentAccount();
  const items = account.items.map(line => {
    const product = state.products.find(p => p.id === line.productId);
    const stockQty = cartStockNeeded(line);
    const unitPrice = line.unitPrice || product.price;
    const totalCost = consumeLots(product, stockQty);
    const subtotal = unitPrice * line.qty;
    return {
      productId: product.id,
      name: product.name,
      code: product.code,
      qty: line.qty,
      stockQty,
      optionId: line.optionId || "base",
      optionName: line.optionName || "Unidad",
      cost: totalCost / Math.max(1, stockQty),
      costTotal: totalCost,
      price: unitPrice,
      subtotal,
      profit: subtotal - totalCost,
      returnedQty: 0
    };
  });
  const total = items.reduce((sum, item) => sum + item.subtotal, 0);
  const payment = { method: paymentMethod, amount: total, paid, change: paid - total, time: nowTime() };
  let sale = null;
  if (options.appendToSaleId) {
    sale = state.sales.find(item => item.id === options.appendToSaleId);
    if (!sale || sale.cashId !== cash.id || sale.status === "cancelada") return toast("No se puede agregar a ese folio");
    if (!Array.isArray(sale.payments) || !sale.payments.length) {
      sale.payments = [{ method: sale.paymentMethod || "efectivo", amount: sale.total || 0, paid: sale.paid ?? sale.total ?? 0, change: sale.change || 0, time: sale.time }];
    }
    sale.items.push(...items);
    sale.total += total;
    sale.paid = (sale.paid || 0) + paid;
    sale.change = (sale.change || 0) + payment.change;
    sale.payments.push(payment);
    sale.paymentMethod = paymentLabel(sale);
    sale.updatedAt = nowIso();
    sale.appendAuthorizations = sale.appendAuthorizations || [];
    sale.appendAuthorizations.push({ userId: session.userId, authorizedBy: options.authorizedBy?.id, date: today(), time: nowTime(), amount: total });
  } else {
    sale = {
      id: uid("sale"),
      date: today(),
      time: nowTime(),
      createdAt: nowIso(),
      userId: session.userId,
      cashId: cash.id,
      ticketFolio: ticketFolio.trim(),
      total,
      paid,
      change: paid - total,
      paymentMethod,
      payments: [payment],
      status: "completada",
      items
    };
    state.sales.unshift(sale);
  }
  items.forEach(item => {
    const product = state.products.find(p => p.id === item.productId);
    const before = product.units;
    product.units -= item.stockQty;
    addMovement(product, "Salida por venta", before, -item.stockQty, product.units, sale.id);
    notifyLowStockOnce(product);
  });
  if (options.appendToSaleId) {
    logOperation("venta_agregada_folio", "sales", sale.id, `Venta agregada al folio ${sale.ticketFolio || "sin folio"} por ${money.format(total)} autorizada por ${options.authorizedBy?.name || "supervisor/admin"}`);
  } else {
    logOperation("venta", "sales", sale.id, `Venta folio ${sale.ticketFolio || "sin folio"} por ${money.format(total)} pagada con ${paymentMethod}`);
  }
  account.items = [];
  closeModal();
  saveState();
  saveSession();
  toast(options.appendToSaleId ? `Productos agregados al folio ${sale.ticketFolio}` : `Venta registrada. Cambio: ${money.format(payment.change)}`);
  render();
}

function notifyLowStockOnce(product) {
  const cash = openCash();
  const key = `${cash?.id}-${product.id}`;
  if (product.units <= product.minStock && !lowStockNotified.has(key)) {
    lowStockNotified.add(key);
    saveSession();
    toast(`Alerta: ${product.name} tiene pocas unidades`);
  }
}

function addMovement(product, type, before, change, after, reference) {
  state.movements.unshift({
    id: uid("mov"),
    productId: product.id,
    type,
    before,
    change,
    after,
    reference,
    date: today(),
    time: nowTime(),
    userId: session.userId,
    createdAt: nowIso()
  });
}

function renderInventory(root) {
  root.innerHTML = `
    <div class="panel">
      <div class="toolbar">
        <label>Busqueda rapida <input id="inventory-search" placeholder="Nombre, codigo o tipo"></label>
        <button class="primary compact" id="new-product">Agregar producto</button>
        ${can("admin", "supervisor") ? `<button class="ghost compact" id="new-category">Nuevo tipo</button>` : ""}
      </div>
      <div id="inventory-table"></div>
    </div>
    ${can("admin", "supervisor") ? `
    <div class="panel">
      <h2>Historial de movimientos</h2>
      ${movementTable(state.movements.slice(0, 30))}
    </div>` : ""}
  `;
  document.querySelector("#inventory-search").addEventListener("input", drawInventoryTable);
  document.querySelector("#new-product").addEventListener("click", () => productModal());
  document.querySelector("#new-category")?.addEventListener("click", categoryModal);
  drawInventoryTable();
}

function drawInventoryTable() {
  const search = document.querySelector("#inventory-search")?.value.toLowerCase() || "";
  const products = state.products.filter(product => {
    const text = `${product.name} ${product.code} ${categoryName(product.categoryId)}`.toLowerCase();
    return text.includes(search);
  });
  document.querySelector("#inventory-table").innerHTML = productTable(products);
  document.querySelectorAll("[data-edit-product]").forEach(button => button.addEventListener("click", () => productModal(button.dataset.editProduct)));
  document.querySelectorAll("[data-stock-product]").forEach(button => button.addEventListener("click", () => stockModal(button.dataset.stockProduct)));
  document.querySelectorAll("[data-delete-product]").forEach(button => button.addEventListener("click", () => deleteProduct(button.dataset.deleteProduct)));
}

function productTable(products) {
  if (!products.length) return `<p class="empty">No hay productos.</p>`;
  return `<div class="table-wrap"><table>
    <thead><tr><th>Producto</th><th>Codigo</th><th>Tipo</th><th>Existencia</th><th>Costo base</th><th>Venta base</th><th>Presentaciones</th><th>Acciones</th></tr></thead>
    <tbody>${products.map(product => `<tr>
      <td>${product.name} ${product.active ? "" : `<span class="badge danger">Inactivo</span>`}</td>
      <td>${product.code}</td>
      <td>${categoryName(product.categoryId)}</td>
      <td><span class="badge ${product.units <= product.minStock ? "warn" : "ok"}">${unitLabel(product)}</span><br><small class="muted">Min: ${unitLabel(product, product.minStock)}</small></td>
      <td>${money.format(product.cost)}</td>
      <td>${money.format(product.price)}</td>
      <td>${saleOptions(product).map(option => escapeHtml(option.name)).join(", ")}</td>
      <td><div class="actions">
        <button class="tiny" data-stock-product="${product.id}">Stock</button>
        ${can("admin", "supervisor") ? `<button class="tiny" data-edit-product="${product.id}">Editar</button><button class="tiny danger" data-delete-product="${product.id}">${product.active ? "Desactivar" : "Activar"}</button>` : ""}
      </div></td>
    </tr>`).join("")}</tbody></table></div>`;
}

function productStockTable(products) {
  return `<div class="table-wrap"><table><thead><tr><th>Producto</th><th>Existencia</th><th>Minimo</th></tr></thead><tbody>${products.map(product => `<tr><td>${product.name}</td><td>${unitLabel(product)}</td><td>${unitLabel(product, product.minStock)}</td></tr>`).join("")}</tbody></table></div>`;
}

function productModal(productId) {
  if (!can("admin", "supervisor") && productId) return toast("Solo administracion puede editar productos");
  const product = normalizeProduct(state.products.find(item => item.id === productId) || {});
  showModal(`
    <h2>${productId ? "Editar producto" : "Agregar producto"}</h2>
    <form id="product-form" class="grid cols-2">
      <label>Nombre <input name="name" required value="${product.name || ""}"></label>
      <label>Codigo <input name="code" required value="${product.code || ""}"></label>
      <label class="wide">Codigos alternos <textarea name="aliasCodes" placeholder="Uno por linea">${(product.aliasCodes || []).join("\n")}</textarea></label>
      <label>Tipo <select name="categoryId">${state.categories.map(c => `<option value="${c.id}" ${product.categoryId === c.id ? "selected" : ""}>${c.name}</option>`).join("")}</select></label>
      <label>Formato base de inventario
        <select name="stockUnit">
          <option value="pieza" ${product.stockUnit === "pieza" ? "selected" : ""}>Piezas</option>
          <option value="paquete" ${product.stockUnit === "paquete" ? "selected" : ""}>Paquetes</option>
          <option value="gramo" ${product.stockUnit === "gramo" ? "selected" : ""}>Gramos</option>
          <option value="miligramo" ${product.stockUnit === "miligramo" ? "selected" : ""}>Miligramos</option>
        </select>
      </label>
      <label>Existencia base <input name="units" type="number" min="0" step="0.001" required value="${product.units ?? 0}"></label>
      <label>Costo por unidad base <input name="cost" type="number" min="0" step="0.01" required value="${product.cost ?? 0}"></label>
      <label>Precio venta base <input name="price" type="number" min="0" step="0.01" required value="${product.price ?? 0}"></label>
      <label>Stock minimo <input name="minStock" type="number" min="0" required value="${product.minStock ?? 1}"></label>
      <label>Piezas/gramos por paquete <input name="packageUnits" type="number" min="0" step="0.001" value="${product.packageUnits || 0}"></label>
      <label>Precio venta paquete <input name="packagePrice" type="number" min="0" step="0.01" value="${product.packagePrice || 0}"></label>
      <label>Mayoreo desde cantidad <input name="wholesaleMin" type="number" min="0" step="0.001" value="${product.wholesaleMin || 0}"></label>
      <label>Precio unitario mayoreo <input name="wholesalePrice" type="number" min="0" step="0.01" value="${product.wholesalePrice || 0}"></label>
      <div class="actions"><button class="primary">Guardar</button><button type="button" class="ghost" data-close-modal>Cancelar</button></div>
    </form>
  `);
  document.querySelector("#product-form").addEventListener("submit", event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    const aliases = data.aliasCodes.split(/\r?\n/).map(code => code.trim()).filter(Boolean);
    const duplicate = state.products.find(p => [p.code, ...(p.aliasCodes || [])].includes(data.code) && p.id !== productId);
    if (duplicate) return toast("Ya existe un producto con ese codigo");
    if (productId) {
      const before = product.units;
      Object.assign(product, {
        name: data.name,
        code: data.code,
        aliasCodes: aliases,
        categoryId: data.categoryId,
        stockUnit: data.stockUnit,
        units: Number(data.units),
        cost: Number(data.cost),
        price: Number(data.price),
        minStock: Number(data.minStock),
        packageUnits: Number(data.packageUnits || 0),
        packagePrice: Number(data.packagePrice || 0),
        wholesaleMin: Number(data.wholesaleMin || 0),
        wholesalePrice: Number(data.wholesalePrice || 0)
      });
      if (before !== product.units) addMovement(product, "Ajuste por edicion", before, product.units - before, product.units, product.id);
      logOperation("editar_producto", "products", product.id, `Edito ${product.name}`);
    } else {
      const created = {
        id: uid("prd"),
        name: data.name,
        code: data.code,
        aliasCodes: aliases,
        categoryId: data.categoryId,
        stockUnit: data.stockUnit,
        units: Number(data.units),
        cost: Number(data.cost),
        price: Number(data.price),
        minStock: Number(data.minStock),
        packageUnits: Number(data.packageUnits || 0),
        packagePrice: Number(data.packagePrice || 0),
        wholesaleMin: Number(data.wholesaleMin || 0),
        wholesalePrice: Number(data.wholesalePrice || 0),
        active: true
      };
      normalizeProduct(created);
      state.products.unshift(created);
      addMovement(created, "Alta de producto", 0, created.units, created.units, created.id);
      logOperation("alta_producto", "products", created.id, `Creo ${created.name}`);
    }
    saveState();
    closeModal();
    render();
  });
}

function stockModal(productId) {
  const product = state.products.find(item => item.id === productId);
  showModal(`
    <h2>Modificar stock</h2>
    <p>${product.name}: <strong>${unitLabel(product)}</strong> actuales.</p>
    <form id="stock-form" class="stack">
      <label>Movimiento
        <select name="type"><option value="Entrada manual">Agregar stock</option><option value="Salida manual">Quitar stock</option></select>
      </label>
      <label>Como se recibe o ajusta
        <select name="receiptType">
          <option value="base">Unidad base (${product.stockUnit})</option>
          <option value="box">Cajas</option>
          <option value="largePackage">Paquetes grandes</option>
          <option value="kg">Kilos</option>
          <option value="g">Gramos</option>
          <option value="mg">Miligramos</option>
        </select>
      </label>
      <label>Cantidad recibida <input name="qty" type="number" min="0.001" step="0.001" required></label>
      <label>Contenido por caja/paquete <input name="unitsPerContainer" type="number" min="0.001" step="0.001" value="${product.packageUnits || 1}"></label>
      <label>Costo por unidad base de este lote <input name="cost" type="number" min="0" step="0.01" value="${product.cost || 0}"></label>
      <p class="hint">El sistema convierte cajas, paquetes, kilos, gramos o miligramos a la unidad base del producto y lo suma al inventario.</p>
      <div class="actions"><button class="primary">Guardar</button><button type="button" class="ghost" data-close-modal>Cancelar</button></div>
    </form>
  `);
  document.querySelector("#stock-form").addEventListener("submit", event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    const qty = convertStockInput(product, data.receiptType, Number(data.qty), Number(data.unitsPerContainer || 1));
    const change = data.type === "Salida manual" ? -qty : qty;
    if (product.units + change < 0) return toast("No puedes dejar stock negativo");
    const before = product.units;
    product.units += change;
    if (change > 0) {
      product.cost = Number(data.cost || product.cost);
      addLot(product, change, product.cost, data.receiptType);
    }
    addMovement(product, data.type, before, change, product.units, product.id);
    logOperation("stock", "products", product.id, `${data.type} de ${unitLabel(product, qty)} recibido como ${data.receiptType}`);
    saveState();
    closeModal();
    render();
  });
}

function categoryModal() {
  showModal(`
    <h2>Nuevo tipo de producto</h2>
    <form id="category-form" class="stack">
      <label>Nombre <input name="name" required></label>
      <div class="actions"><button class="primary">Guardar</button><button type="button" class="ghost" data-close-modal>Cancelar</button></div>
    </form>
  `);
  document.querySelector("#category-form").addEventListener("submit", event => {
    event.preventDefault();
    const name = new FormData(event.target).get("name").trim();
    if (state.categories.some(category => category.name.toLowerCase() === name.toLowerCase())) return toast("Ese tipo ya existe");
    const category = { id: uid("cat"), name };
    state.categories.push(category);
    logOperation("alta_tipo", "categories", category.id, `Creo tipo ${name}`);
    saveState();
    closeModal();
    render();
  });
}

function deleteProduct(productId) {
  const product = state.products.find(item => item.id === productId);
  product.active = !product.active;
  logOperation("estado_producto", "products", product.id, `${product.active ? "Activo" : "Desactivo"} ${product.name}`);
  saveState();
  render();
}

function renderExpenses(root) {
  const cash = openCash();
  const expenses = visibleExpenses();
  root.innerHTML = `
    <div class="grid cols-2">
      <div class="panel">
        <h2>Registrar gasto o retiro</h2>
        <form id="expense-form" class="stack">
          <label>Descripcion <textarea name="description" required placeholder="Ej. Retiro para proveedor"></textarea></label>
          <label>Monto <input name="amount" type="number" min="0.01" step="0.01" required></label>
          <button class="primary" ${cash ? "" : "disabled"}>Registrar gasto</button>
          ${cash ? "" : `<p class="hint">Debes abrir caja antes de registrar gastos.</p>`}
        </form>
      </div>
      <div class="panel">
        <h2>${can("admin", "supervisor") ? "Gastos recientes" : "Mis gastos de caja"}</h2>
        ${expenseTable(expenses.slice(0, 15))}
      </div>
    </div>
  `;
  document.querySelector("#expense-form").addEventListener("submit", event => {
    event.preventDefault();
    if (!openCash()) return toast("No hay caja abierta");
    const data = Object.fromEntries(new FormData(event.target));
    if (currentUser().role === "vendedor") {
      authorizeModal("Autorizar gasto", authUser => saveExpense(data, authUser));
      return;
    }
    saveExpense(data, null);
  });
}

function visibleExpenses() {
  if (can("admin", "supervisor")) return state.expenses;
  const cash = openCash();
  if (cash) return state.expenses.filter(expense => expense.cashId === cash.id && expense.userId === session.userId);
  return [];
}

function saveExpense(data, authUser) {
    const expense = {
      id: uid("exp"),
      description: data.description,
      amount: Number(data.amount),
      date: today(),
      time: nowTime(),
      userId: session.userId,
      authorizedBy: authUser?.id || session.userId,
      cashId: openCash().id,
      createdAt: nowIso()
    };
    state.expenses.unshift(expense);
    logOperation("gasto", "expenses", expense.id, `Gasto por ${money.format(expense.amount)}${authUser ? ` autorizado por ${authUser.name}` : ""}`);
    saveState();
    closeModal();
    render();
    toast("Gasto registrado");
}

function renderSales(root) {
  root.innerHTML = `
    <div class="panel">
      <div class="toolbar">
        <label>Fecha <input type="date" id="sales-date" value="${today()}"></label>
        <label>Busqueda <input id="sales-search" placeholder="Folio, vendedor o producto"></label>
      </div>
      <div id="sales-table"></div>
    </div>
  `;
  document.querySelector("#sales-date").addEventListener("change", drawSales);
  document.querySelector("#sales-search").addEventListener("input", drawSales);
  drawSales();
}

function drawSales() {
  const date = document.querySelector("#sales-date").value;
  const search = document.querySelector("#sales-search").value.toLowerCase();
  const sales = visibleSales().filter(sale => sale.date === date).filter(sale => {
    const text = `${sale.id} ${sale.ticketFolio || ""} ${userName(sale.userId)} ${sale.items.map(item => item.name).join(" ")}`.toLowerCase();
    return text.includes(search);
  });
  document.querySelector("#sales-table").innerHTML = salesTable(sales, true);
  document.querySelectorAll("[data-view-sale]").forEach(button => button.addEventListener("click", () => saleDetailModal(button.dataset.viewSale)));
  document.querySelectorAll("[data-cancel-sale]").forEach(button => button.addEventListener("click", () => authorizeModal("Cancelar venta", authUser => cancelSale(button.dataset.cancelSale, authUser))));
  document.querySelectorAll("[data-return-sale]").forEach(button => button.addEventListener("click", () => returnModal(button.dataset.returnSale)));
}

function visibleSales() {
  if (can("admin", "supervisor")) return state.sales;
  const cash = openCash();
  if (cash) return state.sales.filter(sale => sale.cashId === cash.id && sale.userId === session.userId);
  return [];
}

function salesTable(sales, actions) {
  if (!sales.length) return `<p class="empty">No hay ventas para mostrar.</p>`;
  return `<div class="table-wrap"><table><thead><tr><th>Venta</th><th>Nota</th><th>Fecha</th><th>Hora</th><th>Vendedor</th><th>Total</th><th>Estado</th>${actions ? "<th>Acciones</th>" : ""}</tr></thead>
    <tbody>${sales.map(sale => `<tr>
      <td>${sale.id.slice(0, 12)}</td><td>${escapeHtml(sale.ticketFolio || "-")}</td><td>${sale.date}</td><td>${sale.time}</td><td>${userName(sale.userId)}</td><td>${money.format(sale.total)}<br><small class="muted">${paymentLabel(sale)}</small></td><td><span class="badge ${sale.status === "cancelada" ? "danger" : sale.status === "parcialmente devuelta" ? "warn" : "ok"}">${sale.status}</span></td>
      ${actions ? `<td><div class="actions"><button class="tiny" data-view-sale="${sale.id}">Ver</button><button class="tiny warning" data-return-sale="${sale.id}" ${sale.status === "cancelada" ? "disabled" : ""}>Devolucion</button>${can("admin", "supervisor") ? `<button class="tiny danger" data-cancel-sale="${sale.id}" ${sale.status === "cancelada" ? "disabled" : ""}>Cancelar</button>` : ""}</div></td>` : ""}
    </tr>`).join("")}</tbody></table></div>`;
}

function saleDetailModal(saleId) {
  const sale = state.sales.find(item => item.id === saleId);
  const sellerView = currentUser().role === "vendedor";
  showModal(`
    <h2>Detalle de venta</h2>
    <p>Folio: ${sale.id}</p>
    <p>Nota/ticket: ${escapeHtml(sale.ticketFolio || "-")} | Vendedor: ${userName(sale.userId)} | Fecha: ${sale.date} ${sale.time} | Pago: ${paymentLabel(sale)}</p>
    <div class="table-wrap"><table><thead><tr><th>Producto</th><th>Presentacion</th><th>Cant.</th><th>Descuento stock</th>${sellerView ? "" : "<th>Costo total</th>"}<th>Venta</th><th>Total</th>${sellerView ? "" : "<th>Ganancia</th>"}</tr></thead>
    <tbody>${sale.items.map(item => `<tr><td>${item.name}</td><td>${item.optionName || "Unidad"}</td><td>${item.qty}</td><td>${item.stockQty || item.qty}</td>${sellerView ? "" : `<td>${money.format(item.costTotal ?? item.cost * item.qty)}</td>`}<td>${money.format(item.price)}</td><td>${money.format(item.subtotal)}</td>${sellerView ? "" : `<td>${money.format(item.profit)}</td>`}</tr>`).join("")}</tbody></table></div>
    <button class="ghost" data-close-modal>Cerrar</button>
  `);
}

function authorizeModal(title, onSuccess) {
  showModal(`
    <h2>${title}</h2>
    <p class="muted">Ingresa usuario y contrasena de supervisor/admin, la clave fija autorizada o un token temporal vigente.</p>
    <form id="auth-form" class="stack">
      <label>Usuario <input name="username" placeholder="Supervisor/admin"></label>
      <label>Contraseña <input name="password" type="password" placeholder="Contraseña"></label>
      <label>Clave fija o token temporal <input name="authCode" inputmode="numeric" placeholder="Opcional si se usa usuario y contrasena"></label>
      <div class="actions"><button class="primary">Autorizar</button><button type="button" class="ghost" data-close-modal>Cancelar</button></div>
    </form>
  `);
  document.querySelector("#auth-form").addEventListener("submit", event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    const byCode = validateAuthorizationCode(data.authCode);
    if (byCode) {
      onSuccess(byCode);
      return;
    }
    const authUser = state.users.find(user => user.username === data.username && user.password === data.password && user.active && ["admin", "supervisor"].includes(user.role));
    if (!authUser) return toast("Autorizacion invalida");
    onSuccess(authUser);
  });
}

function cancelSale(saleId, authUser) {
  const sale = state.sales.find(item => item.id === saleId);
  if (sale.status === "cancelada") return toast("La venta ya esta cancelada");
  sale.items.forEach(item => {
    const qtyToRestore = (item.stockQty || item.qty) - (item.returnedStockQty || 0);
    if (qtyToRestore <= 0) return;
    const product = state.products.find(p => p.id === item.productId);
    const before = product.units;
    product.units += qtyToRestore;
    addMovement(product, "Entrada por cancelacion", before, qtyToRestore, product.units, sale.id);
  });
  sale.status = "cancelada";
  const cancellation = { id: uid("can"), saleId, requestedBy: session.userId, authorizedBy: authUser.id, date: today(), time: nowTime() };
  state.cancellations.unshift(cancellation);
  logOperation("cancelacion", "sales", saleId, `Cancelacion autorizada por ${authUser.name}`);
  saveState();
  closeModal();
  render();
  toast("Venta cancelada");
}

function returnModal(saleId) {
  const sale = state.sales.find(item => item.id === saleId);
  const returnableItems = sale.items.filter(item => item.qty - (item.returnedQty || 0) > 0);
  if (!returnableItems.length) return toast("La venta ya no tiene productos para devolver");
  showModal(`
    <h2>Devolucion parcial</h2>
    <form id="return-form" class="stack">
      ${returnableItems.map(item => {
        const available = item.qty - (item.returnedQty || 0);
        return `<label>${item.name} disponibles para devolver: ${available}<input name="${item.productId}" type="number" min="0" max="${available}" value="0"></label>`;
      }).join("")}
      <button class="primary">Solicitar autorizacion</button>
      <button type="button" class="ghost" data-close-modal>Cancelar</button>
    </form>
  `);
  document.querySelector("#return-form").addEventListener("submit", event => {
    event.preventDefault();
    const quantities = Object.fromEntries(new FormData(event.target));
    const selected = Object.entries(quantities).filter(([, qty]) => Number(qty) > 0);
    if (!selected.length) return toast("Selecciona al menos un producto");
    authorizeModal("Autorizar devolucion parcial", authUser => completeReturn(saleId, selected, authUser));
  });
}

function completeReturn(saleId, selected, authUser) {
  const sale = state.sales.find(item => item.id === saleId);
  let totalReturned = 0;
  const detail = selected.map(([productId, qtyValue]) => {
    const qty = Number(qtyValue);
    const line = sale.items.find(item => item.productId === productId);
    const available = line.qty - (line.returnedQty || 0);
    if (qty > available) throw new Error("Cantidad de devolucion mayor a la disponible");
    const product = state.products.find(item => item.id === productId);
    const optionQty = (line.stockQty || line.qty) / Math.max(1, line.qty);
    const stockReturnQty = qty * optionQty;
    const before = product.units;
    product.units += stockReturnQty;
    line.returnedQty = (line.returnedQty || 0) + qty;
    line.returnedStockQty = (line.returnedStockQty || 0) + stockReturnQty;
    totalReturned += qty * line.price;
    addMovement(product, "Entrada por devolucion", before, stockReturnQty, product.units, sale.id);
    return { productId, qty, price: line.price, subtotal: qty * line.price };
  });
  sale.total -= totalReturned;
  sale.status = "parcialmente devuelta";
  const returnRecord = { id: uid("ret"), saleId, requestedBy: session.userId, authorizedBy: authUser.id, totalReturned, detail, date: today(), time: nowTime() };
  state.returns.unshift(returnRecord);
  logOperation("devolucion", "sales", saleId, `Devolucion autorizada por ${authUser.name}`);
  saveState();
  closeModal();
  render();
  toast("Devolucion registrada");
}

function renderCash(root) {
  const cash = openCash();
  root.innerHTML = `
    <div class="grid cols-2">
      <div class="panel">
        <h2>${cash ? "Caja abierta" : "Abrir caja"}</h2>
        ${cash ? cashSummary(cash) : `<form id="open-cash-form" class="stack"><label>Monto inicial <input name="amount" type="number" min="0" step="0.01" required></label><button class="primary">Abrir caja</button></form>`}
      </div>
      <div class="panel">
        <h2>Historial de cajas</h2>
        ${cashTable(state.cashRegisters.filter(c => can("admin", "supervisor") || c.userId === session.userId).slice(0, 12))}
      </div>
    </div>
  `;
  document.querySelector("#open-cash-form")?.addEventListener("submit", handleOpenCash);
  document.querySelector("#close-cash")?.addEventListener("click", closeCash);
}

function handleOpenCash(event) {
  event.preventDefault();
  const amount = Number(new FormData(event.target).get("amount"));
  if (openCash()) return toast("Ya tienes una caja abierta");
  const cash = { id: uid("cash"), userId: session.userId, dateOpen: today(), timeOpen: nowTime(), initialAmount: amount, status: "abierta", closedAt: null, finalAmount: null };
  state.cashRegisters.unshift(cash);
  logOperation("apertura_caja", "cashRegisters", cash.id, `Apertura con ${money.format(amount)}`);
  saveState();
  render();
}

function cashSummary(cash) {
  const sales = state.sales.filter(sale => sale.cashId === cash.id && sale.status !== "cancelada");
  const expenses = state.expenses.filter(expense => expense.cashId === cash.id);
  const sold = sales.reduce((sum, sale) => sum + sale.total, 0);
  const cashSold = sales.reduce((sum, sale) => sum + salePaymentAmount(sale, "efectivo"), 0);
  const cardSold = sales.reduce((sum, sale) => sum + salePaymentAmount(sale, "tarjeta"), 0);
  const transferSold = sales.reduce((sum, sale) => sum + salePaymentAmount(sale, "transferencia"), 0);
  const ticketSold = cardSold + transferSold;
  const spent = expenses.reduce((sum, expense) => sum + expense.amount, 0);
  const expected = cash.initialAmount + cashSold - spent;
  const expectedWithTickets = expected + ticketSold;
  const noteRows = sales.map(sale => `<tr><td>${escapeHtml(sale.ticketFolio || "-")}</td><td>${sale.time}</td><td>${paymentLabel(sale)}</td><td>${money.format(sale.total)}</td></tr>`).join("");
  return `
    <div class="grid cols-3">
      ${metric("Monto inicial", money.format(cash.initialAmount))}
      ${metric("Ventas totales", money.format(sold))}
      ${metric("Efectivo", money.format(cashSold))}
      ${metric("Tarjeta", money.format(cardSold))}
      ${metric("Transferencia", money.format(transferSold))}
      ${metric("Tickets/comprobantes", money.format(ticketSold))}
      ${metric("Gastos", money.format(spent))}
      ${metric("Esperado en caja", money.format(expected))}
      ${metric("Cuadre con tickets", money.format(expectedWithTickets))}
    </div>
    <div class="panel">
      <h3>Notas registradas en esta caja</h3>
      ${sales.length ? `<div class="table-wrap"><table><thead><tr><th>Nota</th><th>Hora</th><th>Pago</th><th>Total</th></tr></thead><tbody>${noteRows}</tbody></table></div>` : `<p class="empty">No hay notas registradas.</p>`}
    </div>
    <button class="primary" id="close-cash">Cerrar caja / corte</button>
  `;
}

function closeCash() {
  const cash = openCash();
  const currentSales = state.sales.filter(sale => sale.cashId === cash.id && sale.status !== "cancelada");
  const sales = currentSales.reduce((sum, sale) => sum + salePaymentAmount(sale, "efectivo"), 0);
  const ticketSales = currentSales.reduce((sum, sale) => sum + salePaymentAmount(sale, "tarjeta") + salePaymentAmount(sale, "transferencia"), 0);
  const expenses = state.expenses.filter(expense => expense.cashId === cash.id).reduce((sum, expense) => sum + expense.amount, 0);
  cash.status = "cerrada";
  cash.dateClose = today();
  cash.timeClose = nowTime();
  cash.finalAmount = cash.initialAmount + sales - expenses;
  cash.ticketAmount = ticketSales;
  cash.expectedWithTickets = cash.finalAmount + ticketSales;
  logOperation("cierre_caja", "cashRegisters", cash.id, `Cierre por ${money.format(cash.finalAmount)}`);
  saveState();
  render();
  toast("Caja cerrada");
}

function renderReports(root) {
  root.innerHTML = `
    <div class="panel">
      <div class="toolbar"><label>Fecha <input type="date" id="report-date" value="${today()}"></label></div>
      <div id="report-content"></div>
    </div>
  `;
  document.querySelector("#report-date").addEventListener("change", drawReports);
  drawReports();
}

function drawReports() {
  const date = document.querySelector("#report-date").value;
  const sales = state.sales.filter(sale => sale.date === date && sale.status !== "cancelada");
  const expenses = state.expenses.filter(expense => expense.date === date);
  const rows = sales.flatMap(sale => sale.items.map(item => ({ type: `producto/${sale.paymentMethod || "efectivo"}`, date: sale.date, time: sale.time, name: `${item.name} (${item.optionName || "Unidad"}) - Nota ${sale.ticketFolio || "-"}`, qty: item.qty, cost: item.costTotal ?? item.cost * item.qty, sold: item.subtotal, profit: item.profit })));
  expenses.forEach(expense => rows.push({ type: "gasto", date: expense.date, time: expense.time, name: expense.description, qty: 1, cost: 0, sold: -expense.amount, profit: -expense.amount }));
  const totals = rows.reduce((acc, row) => {
    acc.cost += row.cost;
    acc.sold += row.sold;
    acc.profit += row.profit;
    return acc;
  }, { cost: 0, sold: 0, profit: 0 });
  document.querySelector("#report-content").innerHTML = `
    <div class="grid cols-3">
      ${metric("Costo total", money.format(totals.cost))}
      ${metric("Venta total", money.format(totals.sold))}
      ${metric("Ganancia neta", money.format(totals.profit))}
    </div>
    ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Tipo</th><th>Nombre</th><th>Hora</th><th>Unidades</th><th>Costo</th><th>Venta / gasto</th><th>Ganancia</th></tr></thead><tbody>${rows.map(row => `<tr><td>${row.type}</td><td>${row.name}</td><td>${row.time}</td><td>${row.qty}</td><td>${money.format(row.cost)}</td><td>${money.format(row.sold)}</td><td>${money.format(row.profit)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="empty">Sin movimientos para esta fecha.</p>`}
  `;
}

function announcementsHtml() {
  const active = (state.announcements || []).filter(item => item.active).slice(0, 4);
  if (!active.length) return `<p class="empty">No hay novedades o promociones activas.</p>`;
  return `<div class="grid">${active.map(item => `
    <div class="panel">
      <div class="split"><span class="badge">${escapeHtml(item.type)}</span><span class="muted">${escapeHtml(item.date)}</span></div>
      <h3>${escapeHtml(item.title)}</h3>
      <p class="muted">${escapeHtml(item.text)}</p>
    </div>
  `).join("")}</div>`;
}

function renderAuthorizations(root) {
  activeAuthTokens();
  root.innerHTML = `
    <div class="grid cols-2">
      <div class="panel">
        <h2>Token temporal</h2>
        <p class="muted">Genera una clave de un solo uso con duracion de 3 minutos para autorizar gastos o devoluciones cuando el supervisor no este junto al cajero.</p>
        <button class="primary" id="generate-token">Generar token</button>
        <div id="token-result"></div>
      </div>
      <div class="panel">
        <h2>Clave fija de autorizacion</h2>
        <form id="pin-form" class="stack">
          <label>Nueva clave fija <input name="authorizationPin" type="password" minlength="4" required value="${escapeHtml(siteSettings().authorizationPin || "")}"></label>
          <button class="primary">Guardar clave</button>
        </form>
        <p class="hint">La clave fija debe compartirse solo con administrador y supervisores.</p>
      </div>
    </div>
    <div class="panel">
      <h2>Tokens vigentes</h2>
      ${activeAuthTokens().length ? `<div class="table-wrap"><table><thead><tr><th>Token</th><th>Generado por</th><th>Expira</th></tr></thead><tbody>${activeAuthTokens().map(token => `<tr><td><strong>${token.code}</strong></td><td>${userName(token.createdBy)}</td><td>${new Date(token.expiresAt).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}</td></tr>`).join("")}</tbody></table></div>` : `<p class="empty">No hay tokens vigentes.</p>`}
    </div>
  `;
  document.querySelector("#generate-token").addEventListener("click", () => {
    const token = generateAuthToken();
    document.querySelector("#token-result").innerHTML = `<div class="metric"><span>Token valido 3 minutos</span><strong>${token.code}</strong></div>`;
    renderAuthorizations(root);
  });
  document.querySelector("#pin-form").addEventListener("submit", event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    state.settings.authorizationPin = data.authorizationPin.trim();
    logOperation("clave_autorizacion", "settings", "authorizationPin", "Actualizo clave fija de autorizacion");
    saveState();
    render();
    toast("Clave de autorizacion actualizada");
  });
}

function renderSite(root) {
  root.innerHTML = `
    <div class="grid cols-2">
      <div class="panel">
        <h2>Identidad visual y textos</h2>
        <form id="site-form" class="grid cols-2">
          <label>Nombre del sitio <input name="siteName" required value="${escapeHtml(siteSettings().siteName)}"></label>
          <label>Logo textual <input name="logoText" maxlength="4" required value="${escapeHtml(siteSettings().logoText)}"></label>
          <label>Nombre de la institucion <input name="institutionName" required value="${escapeHtml(siteSettings().institutionName)}"></label>
          <label>Lema / subtitulo <input name="tagline" required value="${escapeHtml(siteSettings().tagline)}"></label>
          <label>Titulo de bienvenida <input name="welcomeTitle" required value="${escapeHtml(siteSettings().welcomeTitle)}"></label>
          <label>Color principal <input name="primaryColor" type="color" value="${escapeHtml(siteSettings().primaryColor)}"></label>
          <label>Color de acento <input name="accentColor" type="color" value="${escapeHtml(siteSettings().accentColor)}"></label>
          <label class="wide">Texto de bienvenida <textarea name="welcomeText" required>${escapeHtml(siteSettings().welcomeText)}</textarea></label>
          <label>Titulo de informacion <input name="infoTitle" required value="${escapeHtml(siteSettings().infoTitle)}"></label>
          <label class="wide">Informacion general <textarea name="infoText" required>${escapeHtml(siteSettings().infoText)}</textarea></label>
          <div class="actions"><button class="primary">Guardar personalizacion</button></div>
        </form>
      </div>
      <div class="panel">
        <div class="split"><h2>Novedades y promociones</h2><button class="primary tiny" id="new-announcement">Nueva</button></div>
        ${announcementTable()}
      </div>
    </div>
  `;
  document.querySelector("#site-form").addEventListener("submit", event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    state.settings = { ...siteSettings(), ...data };
    logOperation("personalizacion", "settings", "site", "Actualizo identidad visual y textos del sitio");
    saveState();
    applyBranding();
    render();
    toast("Sitio actualizado");
  });
  document.querySelector("#new-announcement").addEventListener("click", () => announcementModal());
  document.querySelectorAll("[data-edit-announcement]").forEach(button => button.addEventListener("click", () => announcementModal(button.dataset.editAnnouncement)));
  document.querySelectorAll("[data-toggle-announcement]").forEach(button => button.addEventListener("click", () => toggleAnnouncement(button.dataset.toggleAnnouncement)));
}

function announcementTable() {
  if (!state.announcements?.length) return `<p class="empty">No hay novedades registradas.</p>`;
  return `<div class="table-wrap"><table><thead><tr><th>Tipo</th><th>Titulo</th><th>Fecha</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>${state.announcements.map(item => `
    <tr>
      <td>${escapeHtml(item.type)}</td>
      <td>${escapeHtml(item.title)}</td>
      <td>${escapeHtml(item.date)}</td>
      <td><span class="badge ${item.active ? "ok" : "danger"}">${item.active ? "Activa" : "Oculta"}</span></td>
      <td><div class="actions"><button class="tiny" data-edit-announcement="${item.id}">Editar</button><button class="tiny warning" data-toggle-announcement="${item.id}">${item.active ? "Ocultar" : "Mostrar"}</button></div></td>
    </tr>`).join("")}</tbody></table></div>`;
}

function announcementModal(id) {
  const item = state.announcements.find(announcement => announcement.id === id) || {};
  showModal(`
    <h2>${id ? "Editar novedad" : "Nueva novedad o promocion"}</h2>
    <form id="announcement-form" class="stack">
      <label>Tipo <select name="type"><option value="Novedad" ${item.type === "Novedad" ? "selected" : ""}>Novedad</option><option value="Promocion" ${item.type === "Promocion" ? "selected" : ""}>Promocion</option><option value="Aviso" ${item.type === "Aviso" ? "selected" : ""}>Aviso</option></select></label>
      <label>Titulo <input name="title" required value="${escapeHtml(item.title || "")}"></label>
      <label>Texto <textarea name="text" required>${escapeHtml(item.text || "")}</textarea></label>
      <label>Fecha <input name="date" type="date" required value="${item.date || today()}"></label>
      <div class="actions"><button class="primary">Guardar</button><button type="button" class="ghost" data-close-modal>Cancelar</button></div>
    </form>
  `);
  document.querySelector("#announcement-form").addEventListener("submit", event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    if (id) {
      Object.assign(item, data);
      logOperation("editar_novedad", "announcements", id, `Edito ${data.title}`);
    } else {
      const created = { id: uid("ann"), ...data, active: true };
      state.announcements.unshift(created);
      logOperation("alta_novedad", "announcements", created.id, `Creo ${created.title}`);
    }
    saveState();
    closeModal();
    render();
  });
}

function toggleAnnouncement(id) {
  const item = state.announcements.find(announcement => announcement.id === id);
  item.active = !item.active;
  logOperation("estado_novedad", "announcements", id, `${item.active ? "Mostro" : "Oculto"} ${item.title}`);
  saveState();
  render();
}

function renderUsers(root) {
  root.innerHTML = `
    <div class="panel">
      <div class="split"><h2>Vendedores, supervisores y administradores</h2><button class="primary" id="new-user">Nuevo usuario</button></div>
      ${userTable()}
    </div>
  `;
  document.querySelector("#new-user").addEventListener("click", () => userModal());
  document.querySelectorAll("[data-edit-user]").forEach(button => button.addEventListener("click", () => userModal(button.dataset.editUser)));
  document.querySelectorAll("[data-toggle-user]").forEach(button => button.addEventListener("click", () => toggleUser(button.dataset.toggleUser)));
}

function userTable() {
  return `<div class="table-wrap"><table><thead><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>${state.users.map(user => `<tr><td>${user.name}</td><td>${user.username}</td><td>${user.role}</td><td><span class="badge ${user.active ? "ok" : "danger"}">${user.active ? "Activo" : "Inactivo"}</span></td><td><div class="actions"><button class="tiny" data-edit-user="${user.id}">Editar</button><button class="tiny danger" data-toggle-user="${user.id}" ${user.id === session.userId ? "disabled" : ""}>${user.active ? "Desactivar" : "Activar"}</button></div></td></tr>`).join("")}</tbody></table></div>`;
}

function userModal(userId) {
  const user = state.users.find(item => item.id === userId) || {};
  showModal(`
    <h2>${userId ? "Editar usuario" : "Nuevo usuario"}</h2>
    <form id="user-form" class="grid cols-2">
      <label>Nombre <input name="name" required value="${user.name || ""}"></label>
      <label>Usuario <input name="username" required value="${user.username || ""}"></label>
      <label>Contraseña <input name="password" required value="${user.password || ""}"></label>
      <label>Rol <select name="role"><option value="vendedor" ${user.role === "vendedor" ? "selected" : ""}>Vendedor</option><option value="supervisor" ${user.role === "supervisor" ? "selected" : ""}>Supervisor</option><option value="admin" ${user.role === "admin" ? "selected" : ""}>Administrador</option></select></label>
      <div class="actions"><button class="primary">Guardar</button><button type="button" class="ghost" data-close-modal>Cancelar</button></div>
    </form>
  `);
  document.querySelector("#user-form").addEventListener("submit", event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    if (state.users.some(u => u.username === data.username && u.id !== userId)) return toast("Ese usuario ya existe");
    if (userId) {
      Object.assign(user, data);
      logOperation("editar_usuario", "users", user.id, `Edito usuario ${user.name}`);
    } else {
      const created = { id: uid("usr"), ...data, active: true };
      state.users.push(created);
      logOperation("alta_usuario", "users", created.id, `Creo usuario ${created.name}`);
    }
    saveState();
    closeModal();
    render();
  });
}

function toggleUser(userId) {
  const user = state.users.find(item => item.id === userId);
  user.active = !user.active;
  logOperation("estado_usuario", "users", user.id, `${user.active ? "Activo" : "Desactivo"} usuario ${user.name}`);
  saveState();
  render();
}

function renderBackup(root) {
  root.innerHTML = `
    <div class="grid cols-2">
      <div class="panel">
        <h2>Respaldo de base de datos</h2>
        <p class="muted">Descarga toda la informacion en formato JSON para conservar productos, ventas, cajas, usuarios, gastos y bitacora.</p>
        <button class="primary" id="make-backup">Generar respaldo</button>
      </div>
      <div class="panel">
        <h2>Restaurar respaldo</h2>
        <label>Archivo JSON <input type="file" id="restore-file" accept="application/json"></label>
        <button class="warning" id="restore-backup">Restaurar</button>
      </div>
    </div>
    <div class="panel"><h2>Historial de respaldos</h2>${backupTable()}</div>
  `;
  document.querySelector("#make-backup").addEventListener("click", makeBackup);
  document.querySelector("#restore-backup").addEventListener("click", restoreBackup);
}

function makeBackup() {
  const backup = { id: uid("bak"), date: today(), time: nowTime(), userId: session.userId, data: state };
  state.backups.unshift({ id: backup.id, date: backup.date, time: backup.time, userId: backup.userId, filename: `respaldo-tienda-${backup.date}.json` });
  logOperation("respaldo", "backups", backup.id, "Genero respaldo de base de datos");
  saveState();
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `respaldo-tienda-${backup.date}.json`;
  link.click();
  URL.revokeObjectURL(url);
  render();
}

function restoreBackup() {
  const file = document.querySelector("#restore-file").files[0];
  if (!file) return toast("Selecciona un archivo");
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const backup = JSON.parse(reader.result);
      state = backup.data || backup;
      logOperation("restauracion", "backups", backup.id || "manual", "Restauro respaldo de base de datos");
      saveState();
      render();
      toast("Respaldo restaurado");
    } catch {
      toast("Archivo invalido");
    }
  };
  reader.readAsText(file);
}

function backupTable() {
  if (!state.backups.length) return `<p class="empty">Aun no hay respaldos registrados.</p>`;
  return `<div class="table-wrap"><table><thead><tr><th>Archivo</th><th>Fecha</th><th>Hora</th><th>Usuario</th></tr></thead><tbody>${state.backups.map(backup => `<tr><td>${backup.filename}</td><td>${backup.date}</td><td>${backup.time}</td><td>${userName(backup.userId)}</td></tr>`).join("")}</tbody></table></div>`;
}

function expenseTable(expenses) {
  if (!expenses.length) return `<p class="empty">No hay gastos registrados.</p>`;
  return `<div class="table-wrap"><table><thead><tr><th>Descripcion</th><th>Monto</th><th>Fecha</th><th>Usuario</th></tr></thead><tbody>${expenses.map(expense => `<tr><td>${expense.description}</td><td>${money.format(expense.amount)}</td><td>${expense.date} ${expense.time}</td><td>${userName(expense.userId)}</td></tr>`).join("")}</tbody></table></div>`;
}

function movementTable(movements) {
  if (!movements.length) return `<p class="empty">Sin movimientos de inventario.</p>`;
  return `<div class="table-wrap"><table><thead><tr><th>Producto</th><th>Movimiento</th><th>Antes</th><th>Cambio</th><th>Final</th><th>Usuario</th><th>Fecha</th></tr></thead><tbody>${movements.map(mov => `<tr><td>${state.products.find(p => p.id === mov.productId)?.name || "Producto"}</td><td>${mov.type}</td><td>${mov.before}</td><td>${mov.change}</td><td>${mov.after}</td><td>${userName(mov.userId)}</td><td>${mov.date} ${mov.time}</td></tr>`).join("")}</tbody></table></div>`;
}

function simpleLogTable(logs) {
  return `<div class="table-wrap"><table><thead><tr><th>Operacion</th><th>Usuario</th><th>Fecha</th></tr></thead><tbody>${logs.map(log => `<tr><td>${log.description}</td><td>${userName(log.userId)}</td><td>${log.date} ${log.time}</td></tr>`).join("")}</tbody></table></div>`;
}

function cashTable(cashes) {
  if (!cashes.length) return `<p class="empty">Sin cajas para mostrar.</p>`;
  return `<div class="table-wrap"><table><thead><tr><th>Usuario</th><th>Apertura</th><th>Inicial</th><th>Estado</th><th>Efectivo final</th><th>Tickets</th></tr></thead><tbody>${cashes.map(cash => `<tr><td>${userName(cash.userId)}</td><td>${cash.dateOpen} ${cash.timeOpen}</td><td>${money.format(cash.initialAmount)}</td><td><span class="badge ${cash.status === "abierta" ? "ok" : ""}">${cash.status}</span></td><td>${cash.finalAmount == null ? "-" : money.format(cash.finalAmount)}</td><td>${cash.ticketAmount == null ? "-" : money.format(cash.ticketAmount)}</td></tr>`).join("")}</tbody></table></div>`;
}

function showModal(html) {
  closeModal();
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.innerHTML = `<div class="modal-card">${html}</div>`;
  document.body.appendChild(modal);
  modal.addEventListener("click", event => {
    if (event.target.matches(".modal, [data-close-modal]")) closeModal();
  });
}

function closeModal() {
  document.querySelector(".modal")?.remove();
}

function toast(message) {
  document.querySelector(".toast")?.remove();
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 3200);
}

render();
syncStateFromServer();
connectRealtime();

window.addEventListener("beforeunload", event => {
  if (session && openCash()) {
    event.preventDefault();
    event.returnValue = "Debes cerrar caja y realizar corte antes de salir.";
  }
});
