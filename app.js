"use strict";

const STORAGE_KEY = "tienda_pos_mac_fes_acatlan_v1";
const app = document.querySelector("#app");
const money = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });

const VIEW_ACCESS = [
  { id: "dashboard", label: "Dashboard" },
  { id: "pos", label: "Punto de venta" },
  { id: "inventory", label: "Productos" },
  { id: "expenses", label: "Gastos" },
  { id: "sales", label: "Ventas" },
  { id: "cash", label: "Caja" },
  { id: "reports", label: "Reportes" },
  { id: "authorizations", label: "Autorizaciones" },
  { id: "site", label: "Sitio" },
  { id: "users", label: "Usuarios" },
  { id: "backup", label: "Respaldos" }
];

const DEFAULT_ACCESS = {
  master: Object.fromEntries(VIEW_ACCESS.map(item => [item.id, true])),
  admin: {
    dashboard: true, pos: true, inventory: true, expenses: true, sales: true, cash: true,
    reports: true, authorizations: true, site: true, users: true, backup: true
  },
  supervisor: {
    dashboard: true, pos: true, inventory: true, expenses: true, sales: true, cash: true,
    reports: true, authorizations: true, site: false, users: false, backup: false
  },
  vendedor: {
    dashboard: false, pos: true, inventory: false, expenses: true, sales: true, cash: true,
    reports: false, authorizations: false, site: false, users: false, backup: false
  }
};
const clientId = sessionStorage.getItem("posClientId") || uid("client");
sessionStorage.setItem("posClientId", clientId);
const serverMode = location.protocol === "http:" || location.protocol === "https:";
const cloudConfig = window.PUNTONEXO_CLOUD || {};
const cloudMode = Boolean(cloudConfig.enabled && cloudConfig.supabaseUrl && cloudConfig.supabaseAnonKey && window.supabase);
const secureCloudAuth = Boolean(cloudMode && cloudConfig.authMode === "supabase");
const cloudBusinessId = cloudConfig.businessId || "default-store";
const authEmailDomain = cloudConfig.authEmailDomain || `${cloudBusinessId}.pos.local`;
let cloudClient = null;
let cloudChannel = null;
let accessKey = sessionStorage.getItem("posAccessKey") || "";
let syncingFromServer = false;
let autoBackupBusy = false;
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

function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

function authEmailForUsername(username = "") {
  const clean = String(username || "").trim().toLowerCase();
  if (!clean) return "";
  return clean.includes("@") ? clean : `${clean}@${authEmailDomain}`;
}

function seedUser(user) {
  const normalized = { ...user, authEmail: user.authEmail || authEmailForUsername(user.username) };
  if (secureCloudAuth) delete normalized.password;
  return normalized;
}

function stateForStorage(source = state) {
  return secureCloudAuth ? stateForCloud(source) : source;
}

function stateForCloud(source = state) {
  const copy = cloneData(source);
  copy.users = (copy.users || []).map(user => {
    const clean = { ...user, authEmail: user.authEmail || authEmailForUsername(user.username) };
    delete clean.password;
    return clean;
  });
  return copy;
}

function backupStateSnapshot() {
  const copy = stateForCloud(state);
  copy.backups = (copy.backups || []).map(({ data, ...metadata }) => metadata);
  return copy;
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stateForStorage(initial)));
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
  data.users = ensureMasterUser(data.users.map(normalizeUser));
  data.products = data.products.map(normalizeProduct);
  return data;
}

function normalizeUser(user) {
  user.role = user.role || "vendedor";
  if (user.role === "owner") user.role = "master";
  user.active = user.active !== false;
  user.username = user.username || user.email || user.authEmail || "";
  user.authEmail = user.authEmail || authEmailForUsername(user.username);
  user.access = { ...defaultAccessForRole(user.role), ...(user.access || {}) };
  if (user.role === "master") user.access = { ...DEFAULT_ACCESS.master };
  if (secureCloudAuth) delete user.password;
  return user;
}

function ensureMasterUser(users) {
  if (!users.some(user => user.role === "master" || user.isMaster)) {
    users.unshift(normalizeUser(seedUser({ id: uid("usr"), name: "Dueno del sistema", username: "master", password: "master123", role: "master", active: true })));
  }
  return users;
}

function normalizeProduct(product) {
  product.stockUnit = product.stockUnit || "pieza";
  product.aliasCodes = product.aliasCodes || [];
  product.supplier = product.supplier || "";
  product.location = product.location || "";
  product.notes = product.notes || "";
  product.priceHistory = Array.isArray(product.priceHistory) ? product.priceHistory : [];
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stateForStorage(state)));
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
      const hadMaster = Array.isArray(data.state.users) && data.state.users.some(user => user.role === "master" || user.isMaster);
      syncingFromServer = true;
      state = normalizeState(data.state);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stateForStorage(state)));
      syncingFromServer = false;
      render();
      if (!hadMaster) await pushStateToCloud();
      maybeAutoBackup();
      return true;
    }
    await pushStateToCloud();
    maybeAutoBackup();
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
        state: stateForCloud(),
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
  const master = uid("usr");
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
      seedUser({ id: master, name: "Dueno del sistema", username: "master", password: "master123", role: "master", active: true, access: { ...DEFAULT_ACCESS.master } }),
      seedUser({ id: admin, name: "Omar", username: "admin", password: "adminO123", role: "admin", active: true }),
      seedUser({ id: supervisor1, name: "Sonia", username: "supervisor1", password: "super1123", role: "supervisor", active: true }),
      seedUser({ id: supervisor2, name: "Toño F", username: "supervisor2", password: "super2123", role: "supervisor", active: true }),
      seedUser({ id: vendedor, name: "Cajero", username: "vendedor", password: "vend123", role: "vendedor", active: true })
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

function defaultAccessForRole(role) {
  return { ...(DEFAULT_ACCESS[role] || DEFAULT_ACCESS.vendedor) };
}

function isMaster(user = currentUser()) {
  return user?.role === "master" || user?.isMaster;
}

function roleLabel(role) {
  return ({ master: "Dueno/Master", admin: "Administrador", supervisor: "Supervisor", vendedor: "Vendedor" })[role] || role;
}

function canAccess(viewId, user = currentUser()) {
  if (!user?.active) return false;
  if (isMaster(user)) return true;
  const access = { ...defaultAccessForRole(user.role), ...(user.access || {}) };
  return Boolean(access[viewId]);
}

function canEditUser(targetUser) {
  const actor = currentUser();
  if (!actor || !targetUser) return false;
  if (isMaster(targetUser) && targetUser.id !== actor.id) return false;
  if (isMaster(actor)) return true;
  if (actor.role !== "admin" || !canAccess("users", actor)) return false;
  if (isMaster(targetUser) || targetUser.role === "admin" || targetUser.role === "master") return false;
  return true;
}

function userName(id) {
  return state.users.find(user => user.id === id)?.name || "Sistema";
}

function categoryName(id) {
  return state.categories.find(category => category.id === id)?.name || "Sin tipo";
}

function unitLabel(product, qty = product.units) {
  const unit = product.stockUnit || "pieza";
  if (unit === "kilogramo") return `${qty} kg`;
  if (unit === "gramo") return `${qty} g`;
  if (unit === "miligramo") return `${qty} mg`;
  if (unit === "paquete") return `${qty} paquete(s)`;
  return `${qty} pieza(s)`;
}

function recordProductPriceChange(product, beforeCost, beforePrice, reason = "Actualizacion") {
  const afterCost = Number(product.cost || 0);
  const afterPrice = Number(product.price || 0);
  if (Number(beforeCost || 0) === afterCost && Number(beforePrice || 0) === afterPrice) return;
  product.priceHistory = product.priceHistory || [];
  product.priceHistory.unshift({
    id: uid("price"),
    beforeCost: Number(beforeCost || 0),
    afterCost,
    beforePrice: Number(beforePrice || 0),
    afterPrice,
    reason,
    userId: session?.userId || "sistema",
    date: today(),
    time: nowTime()
  });
  product.priceHistory = product.priceHistory.slice(0, 25);
}

function isWeightProduct(product) {
  return ["kilogramo", "gramo", "miligramo"].includes(product.stockUnit);
}

function weightSaleStep(product) {
  if (product.stockUnit === "kilogramo") return 0.001;
  if (product.stockUnit === "gramo") return 0.001;
  return 1;
}

function saleOptions(product) {
  const options = [
    { id: "base", name: product.stockUnit === "pieza" ? "Por pieza" : `Por ${product.stockUnit}`, quantity: 1, price: Number(product.price || 0) }
  ];
  if (product.packageUnits > 1 && product.packagePrice > 0) {
    options.push({ id: "package", name: `Paquete/caja de ${product.packageUnits}`, quantity: Number(product.packageUnits), price: Number(product.packagePrice) });
  }
  if (product.wholesaleMin > 1 && product.wholesalePrice > 0) {
    options.push({ id: "wholesale", name: `Precio especial desde ${product.wholesaleMin}`, quantity: 1, price: Number(product.wholesalePrice), minQty: Number(product.wholesaleMin) });
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

function consumeLotsDetailed(product, qty) {
  let remaining = qty;
  let totalCost = 0;
  const costLayers = [];
  product.lots = product.lots || [];
  for (const lot of product.lots) {
    if (remaining <= 0) break;
    const take = Math.min(lot.qty, remaining);
    const unitCost = Number(lot.cost || product.cost || 0);
    lot.qty -= take;
    remaining -= take;
    totalCost += take * unitCost;
    costLayers.push({ qty: take, cost: unitCost });
  }
  product.lots = product.lots.filter(lot => lot.qty > 0.000001);
  if (remaining > 0) {
    const unitCost = Number(product.cost || 0);
    totalCost += remaining * unitCost;
    costLayers.push({ qty: remaining, cost: unitCost });
  }
  return { totalCost, costLayers };
}

function consumeLots(product, qty) {
  return consumeLotsDetailed(product, qty).totalCost;
}

function addLot(product, qty, cost, reference) {
  if (qty <= 0) return;
  product.lots = product.lots || [];
  product.lots.push({ id: uid("lot"), qty, cost: Number(cost), date: today(), reference });
}

function itemStockQty(item) {
  return Number(item.stockQty || item.qty || 0);
}

function itemTotalCost(item) {
  return Number(item.costTotal ?? Number(item.cost || 0) * itemStockQty(item));
}

function itemReturnedCost(item) {
  if (item.returnedCostTotal != null) return Number(item.returnedCostTotal);
  const stockQty = itemStockQty(item);
  const returnedStockQty = Number(item.returnedStockQty || 0);
  return stockQty > 0 ? itemTotalCost(item) * (returnedStockQty / stockQty) : 0;
}

function itemNetCost(item) {
  return Math.max(0, itemTotalCost(item) - itemReturnedCost(item));
}

function itemNetSold(item) {
  return Math.max(0, Number(item.subtotal || 0) - Number(item.returnedQty || 0) * Number(item.price || 0));
}

function itemNetProfit(item) {
  return itemNetSold(item) - itemNetCost(item);
}

function costLayersForRange(item, offset, qty) {
  const layers = Array.isArray(item.costLayers) && item.costLayers.length
    ? item.costLayers
    : [{ qty: itemStockQty(item), cost: itemStockQty(item) > 0 ? itemTotalCost(item) / itemStockQty(item) : 0 }];
  let skip = Math.max(0, Number(offset || 0));
  let remaining = Math.max(0, Number(qty || 0));
  const selected = [];
  for (const layer of layers) {
    if (remaining <= 0) break;
    const available = Math.max(0, Number(layer.qty || 0));
    if (skip >= available) {
      skip -= available;
      continue;
    }
    const take = Math.min(available - skip, remaining);
    selected.push({ qty: take, cost: Number(layer.cost || 0) });
    remaining -= take;
    skip = 0;
  }
  if (remaining > 0) {
    const fallbackCost = itemStockQty(item) > 0 ? itemTotalCost(item) / itemStockQty(item) : Number(item.cost || 0);
    selected.push({ qty: remaining, cost: fallbackCost });
  }
  return selected;
}

function restoreCostLayers(product, item, offset, qty, reference) {
  const layers = costLayersForRange(item, offset, qty);
  layers.forEach(layer => addLot(product, layer.qty, layer.cost, reference));
  return layers.reduce((sum, layer) => sum + layer.qty * layer.cost, 0);
}

function convertStockInput(product, receiptType, qty, unitsPerContainer) {
  if (receiptType === "box" || receiptType === "largePackage") return qty * unitsPerContainer;
  if (["kg", "g", "mg"].includes(receiptType) && isWeightProduct(product)) {
    const milligrams = { kg: 1000000, g: 1000, mg: 1 };
    const stockUnit = { kilogramo: 1000000, gramo: 1000, miligramo: 1 };
    return qty * milligrams[receiptType] / stockUnit[product.stockUnit];
  }
  return qty;
}

function receivedUnitName(receiptType) {
  return ({
    base: "unidad registrada",
    box: "caja",
    largePackage: "paquete",
    kg: "kilo",
    g: "gramo",
    mg: "miligramo"
  })[receiptType] || "cantidad recibida";
}

function calculateUnitCost(product, receiptType, enteredCost, unitsPerContainer, costMode) {
  if (costMode !== "received") return enteredCost;
  const unitsInOneReceived = convertStockInput(product, receiptType, 1, unitsPerContainer);
  return unitsInOneReceived > 0 ? enteredCost / unitsInOneReceived : 0;
}

function can(...roles) {
  const user = currentUser();
  if (isMaster(user)) return true;
  return roles.includes(user?.role);
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

function validateTokenOnly(code) {
  const clean = String(code || "").trim();
  if (!clean) return null;
  const token = activeAuthTokens().find(item => item.code === clean);
  if (!token) return null;
  token.used = true;
  const creator = state.users.find(user => user.id === token.createdBy);
  logOperation("uso_token_corte", "authTokens", token.id, `Uso token para corte generado por ${creator?.name || "supervisor/admin"}`);
  saveState();
  return { id: token.createdBy, name: creator?.name || "Supervisor/Admin", method: "token" };
}

function navItems() {
  const items = [
    { id: "dashboard", label: "Dashboard" },
    { id: "pos", label: "Punto de venta" },
    { id: "inventory", label: "Productos" },
    { id: "expenses", label: "Gastos" },
    { id: "sales", label: "Ventas" },
    { id: "cash", label: "Caja" },
    { id: "reports", label: "Reportes" },
    { id: "authorizations", label: "Autorizaciones" },
    { id: "site", label: "Sitio" },
    { id: "users", label: "Usuarios" },
    { id: "backup", label: "Respaldos" }
  ];
  return items.filter(item => canAccess(item.id));
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
          <span class="badge">${roleLabel(currentUser().role)}</span>
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
    inventory: "Productos",
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
  document.querySelector("#login-form").addEventListener("submit", handleLogin);
}

async function handleLogin(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  if (secureCloudAuth) {
    await loginWithSupabase(data.username, data.password);
    return;
  }
  const user = state.users.find(item => item.username === data.username && item.password === data.password && item.active);
  if (!user) return toast("Usuario o contrasena incorrectos");
  startSessionForUser(user);
}

async function loginWithSupabase(username, password) {
  const client = getCloudClient();
  const email = authEmailForUsername(username);
  if (!client || !email) return toast("Configuracion de nube incompleta");
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) return toast("Usuario o contrasena incorrectos");
  await syncStateFromCloud();
  let user = state.users.find(item =>
    item.authUserId === data.user.id ||
    String(item.authEmail || "").toLowerCase() === email ||
    String(item.username || "").toLowerCase() === String(username || "").toLowerCase()
  );
  if (!user) {
    user = normalizeUser({ id: uid("usr"), authUserId: data.user.id, authEmail: email, username, name: username, role: "vendedor", active: false });
    state.users.push(user);
    saveState();
    await client.auth.signOut();
    return toast("La cuenta existe en Supabase, pero no tiene permisos en el sistema");
  }
  if (!user.active) {
    await client.auth.signOut();
    return toast("Usuario inactivo");
  }
  if (!user.authUserId) {
    user.authUserId = data.user.id;
    user.authEmail = user.authEmail || email;
    saveState();
  }
  startSessionForUser(user);
  maybeAutoBackup();
}

function startSessionForUser(user) {
  session = { userId: user.id, authUserId: user.authUserId || null, startedAt: nowIso(), accounts: [{ id: "cuenta-1", name: "Cuenta 1", items: [] }] };
  sessionStorage.setItem("posSession", JSON.stringify(session));
  logOperation("login", "users", user.id, "Inicio de sesion", user.id);
  saveState();
  currentView = user.role === "vendedor" ? "pos" : "dashboard";
  render();
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
  if (secureCloudAuth) getCloudClient()?.auth.signOut();
  session = null;
  sessionStorage.removeItem("posSession");
  render();
}

function renderDashboard(root) {
  const date = today();
  const sales = state.sales.filter(sale => sale.date === date && sale.status !== "cancelada");
  const expenses = state.expenses.filter(expense => expense.date === date);
  const totalSales = sales.reduce((sum, sale) => sum + sale.total, 0);
  const totalCost = sales.flatMap(sale => sale.items).reduce((sum, item) => sum + itemNetCost(item), 0);
  const totalExpenses = expenses.reduce((sum, expense) => sum + expense.amount, 0);
  const lowProducts = state.products.filter(product => product.active && product.units <= product.minStock);
  const cashSales = sales.reduce((sum, sale) => sum + salePaymentAmount(sale, "efectivo"), 0);
  const cardTransferSales = sales.reduce((sum, sale) => sum + salePaymentAmount(sale, "tarjeta") + salePaymentAmount(sale, "transferencia"), 0);
  const topProducts = topSoldProducts(sales, 6);
  const noMovementProducts = productsWithoutMovement(30).slice(0, 6);
  root.innerHTML = `
    <div class="grid cols-4">
      ${metric("Ventas del dia", money.format(totalSales))}
      ${metric("Ganancia antes de gastos", money.format(totalSales - totalCost))}
      ${metric("Gastos del dia", money.format(totalExpenses))}
      ${metric("Ganancia neta", money.format(totalSales - totalCost - totalExpenses))}
    </div>
    <div class="grid cols-2">
      <div class="panel">
        <h2>Resumen de cobros</h2>
        <div class="grid cols-2">
          ${metric("Efectivo", money.format(cashSales))}
          ${metric("Tarjeta / transferencia", money.format(cardTransferSales))}
        </div>
      </div>
      <div class="panel">
        <h2>Mas vendido hoy</h2>
        ${topProducts.length ? topProductsTable(topProducts) : `<p class="empty">Aun no hay ventas hoy.</p>`}
      </div>
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
        <div class="split"><h2>Productos por agotarse</h2><span class="badge warn">${lowProducts.length}</span></div>
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
    <div class="panel">
      <h2>Productos sin venta reciente</h2>
      ${noMovementProducts.length ? productStockTable(noMovementProducts) : `<p class="empty">No hay productos activos sin movimiento reciente.</p>`}
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

function topSoldProducts(sales, limit = 5) {
  const totals = new Map();
  sales.forEach(sale => sale.items.forEach(item => {
    const current = totals.get(item.productId) || { name: item.name, qty: 0, sold: 0 };
    current.qty += Number(item.qty || 0) - Number(item.returnedQty || 0);
    current.sold += itemNetSold(item);
    totals.set(item.productId, current);
  }));
  return [...totals.values()].filter(item => item.qty > 0).sort((a, b) => b.sold - a.sold).slice(0, limit);
}

function productsWithoutMovement(days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const soldIds = new Set(state.sales
    .filter(sale => sale.status !== "cancelada" && new Date(sale.createdAt || sale.date) >= since)
    .flatMap(sale => sale.items.map(item => item.productId)));
  return state.products.filter(product => product.active && !soldIds.has(product.id));
}

function topProductsTable(products) {
  return `<div class="table-wrap"><table><thead><tr><th>Producto</th><th>Cantidad</th><th>Venta</th></tr></thead><tbody>${products.map(product => `<tr><td>${escapeHtml(product.name)}</td><td>${product.qty}</td><td>${money.format(product.sold)}</td></tr>`).join("")}</tbody></table></div>`;
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
          <label>Escaner o codigo <input id="barcode-input" placeholder="Escanea o escribe el codigo y Enter" autocomplete="off"></label>
          <label>Buscar producto <input id="product-search" placeholder="Nombre o codigo"></label>
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
        <small>${money.format(product.price)} | quedan ${unitLabel(product)}</small>
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
  if (!product || product.units <= 0) return toast("Producto agotado");
  const options = saleOptions(product);
  if (!optionId && options.length > 1) return saleOptionModal(product);
  const option = getSaleOption(product, optionId);
  const account = currentAccount();
  const line = account.items.find(item => item.productId === productId && item.optionId === option.id);
  const currentQty = line?.qty || 0;
  const availableSaleQty = product.units / option.quantity;
  const increment = Math.min(1, Math.max(0, availableSaleQty - currentQty));
  if (increment <= 0) return toast("No alcanza la cantidad disponible");
  if (line) line.qty += increment;
  else account.items.push({ productId, optionId: option.id, optionName: option.name, unitQuantity: option.quantity, unitPrice: option.price, qty: increment });
  saveSession();
  render();
}

function saleOptionModal(product) {
  showModal(`
    <h2>Elegir forma de venta</h2>
    <p>${escapeHtml(product.name)} | Disponible: ${unitLabel(product)}</p>
    <div class="grid">
      ${saleOptions(product).map(option => `<button class="product-button" data-sale-option="${option.id}">
        <strong>${escapeHtml(option.name)}</strong>
        <small>Sale del inventario: ${unitLabel(product, option.quantity)}</small>
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
    const step = isWeightProduct(product) ? weightSaleStep(product) : 1;
    const max = isWeightProduct(product)
      ? product.units / (item.unitQuantity || 1)
      : Math.floor(product.units / (item.unitQuantity || 1));
    return `<div class="cart-line">
      <div><strong>${product.name}</strong><br><small class="muted">${item.optionName || "Por pieza"} | sale del inventario: ${unitLabel(product, cartStockNeeded(item))}</small></div>
      <input data-cart-qty="${product.id}|${item.optionId || "base"}" type="number" min="${step}" step="${step}" max="${max}" value="${item.qty}">
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
      const minimum = isWeightProduct(product) ? weightSaleStep(product) : 1;
      const maximum = isWeightProduct(product)
        ? product.units / (line.unitQuantity || 1)
        : Math.floor(product.units / (line.unitQuantity || 1));
      const value = Math.max(minimum, Math.min(Number(input.value), maximum));
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
    const consumption = consumeLotsDetailed(product, stockQty);
    const totalCost = consumption.totalCost;
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
      costLayers: consumption.costLayers,
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
        <label>Buscar producto <input id="inventory-search" placeholder="Nombre, codigo o tipo"></label>
        <button class="primary compact" id="new-product">Agregar producto</button>
        ${can("admin", "supervisor") ? `<button class="ghost compact" id="new-category">Nuevo tipo</button>` : ""}
        ${can("admin", "supervisor") ? `<label><input id="show-inactive-products" type="checkbox"> Mostrar eliminados</label>` : ""}
      </div>
      <div id="inventory-table"></div>
    </div>
    ${can("admin", "supervisor") ? `
    <div class="panel">
      <h2>Historial de entradas y salidas</h2>
      ${movementTable(state.movements.slice(0, 30))}
    </div>` : ""}
  `;
  document.querySelector("#inventory-search").addEventListener("input", drawInventoryTable);
  document.querySelector("#show-inactive-products")?.addEventListener("change", drawInventoryTable);
  document.querySelector("#new-product").addEventListener("click", () => productModal());
  document.querySelector("#new-category")?.addEventListener("click", categoryModal);
  drawInventoryTable();
}

function drawInventoryTable() {
  const search = document.querySelector("#inventory-search")?.value.toLowerCase() || "";
  const showInactive = document.querySelector("#show-inactive-products")?.checked || false;
  const products = state.products.filter(product => {
    if (!product.active && !showInactive) return false;
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
    <thead><tr><th>Producto</th><th>Codigo</th><th>Tipo</th><th>Cantidad disponible</th><th>Lo que costo</th><th>Precio al publico</th><th>Se vende como</th><th>Acciones</th></tr></thead>
    <tbody>${products.map(product => `<tr>
      <td>${product.name} ${product.active ? "" : `<span class="badge danger">Inactivo</span>`}</td>
      <td>${product.code}</td>
      <td>${categoryName(product.categoryId)}</td>
      <td><span class="badge ${product.units <= product.minStock ? "warn" : "ok"}">${unitLabel(product)}</span><br><small class="muted">Avisar en: ${unitLabel(product, product.minStock)}</small>${product.location ? `<br><small class="muted">Ubicacion: ${escapeHtml(product.location)}</small>` : ""}</td>
      <td>${money.format(product.cost)}</td>
      <td>${money.format(product.price)}</td>
      <td>${saleOptions(product).map(option => escapeHtml(option.name)).join(", ")}</td>
      <td><div class="actions">
        ${product.active ? `<button class="tiny" data-stock-product="${product.id}">Entrada</button>` : ""}
        ${can("admin", "supervisor") ? `<button class="tiny" data-edit-product="${product.id}">Modificar</button><button class="tiny ${product.active ? "danger" : "warning"}" data-delete-product="${product.id}">${product.active ? "Eliminar" : "Restaurar"}</button>` : ""}
      </div></td>
    </tr>`).join("")}</tbody></table></div>`;
}

function productStockTable(products) {
  return `<div class="table-wrap"><table><thead><tr><th>Producto</th><th>Quedan</th><th>Avisar en</th></tr></thead><tbody>${products.map(product => `<tr><td>${product.name}</td><td>${unitLabel(product)}</td><td>${unitLabel(product, product.minStock)}</td></tr>`).join("")}</tbody></table></div>`;
}

function productModal(productId) {
  if (!can("admin", "supervisor") && productId) return toast("Solo administracion puede editar productos");
  const product = normalizeProduct(state.products.find(item => item.id === productId) || {});
  const mode = isWeightProduct(product) ? "peso" : product.packageUnits > 1 || product.packagePrice > 0 || product.wholesaleMin > 0 ? "paquete" : "unidad";
  showModal(`
    <h2>${productId ? "Editar producto" : "Agregar producto"}</h2>
    <form id="product-form" class="stack">
      <div class="grid cols-2">
        <label>Nombre del producto <input name="name" required value="${escapeHtml(product.name || "")}"></label>
        <label>Codigo de barras o interno <input name="code" required value="${escapeHtml(product.code || "")}"></label>
        <label>Tipo de producto <select name="categoryId">${state.categories.map(c => `<option value="${c.id}" ${product.categoryId === c.id ? "selected" : ""}>${c.name}</option>`).join("")}</select></label>
        <label>Como se maneja este producto
          <select name="productMode" id="product-mode">
            <option value="unidad" ${mode === "unidad" ? "selected" : ""}>Por piezas o unidades</option>
            <option value="paquete" ${mode === "paquete" ? "selected" : ""}>Por cajas o paquetes</option>
            <option value="peso" ${mode === "peso" ? "selected" : ""}>Por peso</option>
          </select>
        </label>
      </div>

      <div class="panel compact">
        <button type="button" class="ghost compact" id="toggle-alias">Agregar otro codigo</button>
        <label id="alias-box" class="wide" style="display:${(product.aliasCodes || []).length ? "grid" : "none"}">Otros codigos para el mismo producto <textarea name="aliasCodes" placeholder="Uno por linea">${(product.aliasCodes || []).join("\n")}</textarea></label>
        <p class="hint">Usalo si el producto llega con otro codigo de barras o si quieres manejar un codigo interno extra.</p>
      </div>

      <div class="grid cols-2">
        <label id="stock-unit-label">Como se cuenta en la tienda
          <select name="stockUnit">
            <option value="pieza" ${product.stockUnit === "pieza" ? "selected" : ""}>Piezas o unidades</option>
            <option value="paquete" ${product.stockUnit === "paquete" ? "selected" : ""}>Paquetes</option>
          </select>
        </label>
        <label id="weight-unit-label">Como se guardara la cantidad
          <select name="weightUnit">
            <option value="kilogramo" ${product.stockUnit === "kilogramo" ? "selected" : ""}>Kilogramos</option>
            <option value="gramo" ${product.stockUnit === "gramo" || !isWeightProduct(product) ? "selected" : ""}>Gramos</option>
            <option value="miligramo" ${product.stockUnit === "miligramo" ? "selected" : ""}>Miligramos</option>
          </select>
        </label>
        <label>Cantidad inicial <input name="units" type="number" min="0" step="0.001" required value="${product.units ?? 0}"></label>
        <label>Cuanto costo comprarlo <input name="cost" type="number" min="0" step="0.01" required value="${product.cost ?? 0}"></label>
        <label>Precio al publico <input name="price" type="number" min="0" step="0.01" required value="${product.price ?? 0}"></label>
        <label>Avisar cuando queden <input name="minStock" type="number" min="0" step="0.001" required value="${product.minStock ?? 1}"></label>
        <label>Proveedor <input name="supplier" value="${escapeHtml(product.supplier || "")}" placeholder="Opcional"></label>
        <label>Ubicacion <input name="location" value="${escapeHtml(product.location || "")}" placeholder="Anaquel, caja o zona"></label>
        <label class="wide">Observaciones <textarea name="notes" placeholder="Presentacion, contenido pendiente, proveedor alterno">${escapeHtml(product.notes || "")}</textarea></label>
      </div>

      <div class="panel compact" id="package-fields">
        <h3>Cajas, paquetes y precio especial</h3>
        <div class="grid cols-2">
          <label>Piezas que trae cada caja/paquete <input name="packageUnits" type="number" min="0" step="0.001" value="${product.packageUnits || 0}"></label>
          <label>Precio al vender caja/paquete <input name="packagePrice" type="number" min="0" step="0.01" value="${product.packagePrice || 0}"></label>
          <label>Precio especial desde cuantas piezas <input name="wholesaleMin" type="number" min="0" step="0.001" value="${product.wholesaleMin || 0}"></label>
          <label>Precio especial por pieza <input name="wholesalePrice" type="number" min="0" step="0.01" value="${product.wholesalePrice || 0}"></label>
        </div>
        <p class="hint">Ejemplo: si una caja trae 24 piezas, escribe 24. Al vender una caja, el sistema descuenta esas 24 piezas.</p>
      </div>

      <div class="panel compact" id="weight-help">
        <h3>Producto que se vende por peso</h3>
        <p class="hint">Para productos por peso puedes recibir kilos, gramos o miligramos en la entrada de stock. El sistema hara la conversion automaticamente.</p>
      </div>

      ${productId && product.priceHistory?.length ? `<div class="panel compact">
        <h3>Historial de costo y precio</h3>
        <div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Costo anterior</th><th>Costo nuevo</th><th>Precio anterior</th><th>Precio nuevo</th></tr></thead><tbody>${product.priceHistory.slice(0, 5).map(item => `<tr><td>${item.date} ${item.time}</td><td>${money.format(item.beforeCost)}</td><td>${money.format(item.afterCost)}</td><td>${money.format(item.beforePrice)}</td><td>${money.format(item.afterPrice)}</td></tr>`).join("")}</tbody></table></div>
      </div>` : ""}

      <div class="actions"><button class="primary">Guardar</button><button type="button" class="ghost" data-close-modal>Cancelar</button></div>
    </form>
  `);
  const form = document.querySelector("#product-form");
  const syncProductMode = () => {
    const selected = form.productMode.value;
    document.querySelector("#package-fields").style.display = selected === "paquete" ? "block" : "none";
    document.querySelector("#weight-help").style.display = selected === "peso" ? "block" : "none";
    document.querySelector("#stock-unit-label").style.display = selected === "peso" ? "none" : "grid";
    document.querySelector("#weight-unit-label").style.display = selected === "peso" ? "grid" : "none";
  };
  document.querySelector("#toggle-alias").addEventListener("click", () => {
    const box = document.querySelector("#alias-box");
    box.style.display = box.style.display === "none" ? "grid" : "none";
  });
  form.productMode.addEventListener("change", syncProductMode);
  syncProductMode();
  form.addEventListener("submit", event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    const aliases = (data.aliasCodes || "").split(/\r?\n/).map(code => code.trim()).filter(Boolean);
    const duplicate = state.products.find(p => [p.code, ...(p.aliasCodes || [])].includes(data.code) && p.id !== productId);
    if (duplicate) return toast("Ya existe un producto con ese codigo");
    const stockUnit = data.productMode === "peso" ? data.weightUnit : data.stockUnit;
    if (productId && product.units > 0 && stockUnit !== product.stockUnit) {
      return toast("Para cambiar la unidad de medida, primero deja la existencia en cero");
    }
    const packageUnits = data.productMode === "paquete" ? Number(data.packageUnits || 0) : 0;
    const packagePrice = data.productMode === "paquete" ? Number(data.packagePrice || 0) : 0;
    const wholesaleMin = data.productMode === "paquete" ? Number(data.wholesaleMin || 0) : 0;
    const wholesalePrice = data.productMode === "paquete" ? Number(data.wholesalePrice || 0) : 0;
    if (productId) {
      const before = product.units;
      const beforeCost = product.cost;
      const beforePrice = product.price;
      Object.assign(product, {
        name: data.name,
        code: data.code,
        aliasCodes: aliases,
        categoryId: data.categoryId,
        stockUnit,
        units: Number(data.units),
        cost: Number(data.cost),
        price: Number(data.price),
        minStock: Number(data.minStock),
        supplier: data.supplier || "",
        location: data.location || "",
        notes: data.notes || "",
        packageUnits,
        packagePrice,
        wholesaleMin,
        wholesalePrice
      });
      recordProductPriceChange(product, beforeCost, beforePrice, "Edicion manual");
      if (before !== product.units) addMovement(product, "Ajuste por edicion", before, product.units - before, product.units, product.id);
      logOperation("editar_producto", "products", product.id, `Edito ${product.name}`);
    } else {
      const created = {
        id: uid("prd"),
        name: data.name,
        code: data.code,
        aliasCodes: aliases,
        categoryId: data.categoryId,
        stockUnit,
        units: Number(data.units),
        cost: Number(data.cost),
        price: Number(data.price),
        minStock: Number(data.minStock),
        supplier: data.supplier || "",
        location: data.location || "",
        notes: data.notes || "",
        packageUnits,
        packagePrice,
        wholesaleMin,
        wholesalePrice,
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
  const isWeight = isWeightProduct(product);
  const baseWeightLabel = ({ kilogramo: "Kilogramos", gramo: "Gramos", miligramo: "Miligramos" })[product.stockUnit];
  const receiptOptions = isWeight
    ? `<option value="base">${baseWeightLabel}</option><option value="kg">Kilos</option><option value="g">Gramos</option><option value="mg">Miligramos</option>`
    : `<option value="base">${product.stockUnit === "paquete" ? "Paquetes" : "Unidades sueltas"}</option><option value="box">Cajas</option><option value="largePackage">Paquetes recibidos</option>`;
  showModal(`
    <h2>Agregar o quitar producto</h2>
    <p>${product.name}: <strong>${unitLabel(product)}</strong> actuales.</p>
    <form id="stock-form" class="stack">
      <label>Que quieres hacer
        <select name="type"><option value="Entrada manual">Agregar producto</option><option value="Salida manual">Quitar producto</option></select>
      </label>
      <label>Como lo estas registrando
        <select name="receiptType" id="receipt-type">${receiptOptions}</select>
      </label>
      <label>Cantidad <input name="qty" type="number" min="0.001" step="0.001" required></label>
      <label id="container-label">Cuantas piezas trae cada caja/paquete <input name="unitsPerContainer" type="number" min="0.001" step="0.001" value="${product.packageUnits || 1}"></label>
      <label id="cost-mode-label">El costo corresponde a
        <select name="costMode">
          <option value="base">Cada pieza/unidad del inventario</option>
          <option value="received">Cada caja, paquete o medida recibida</option>
        </select>
      </label>
      <label><span id="cost-label-text">Costo por pieza/unidad</span> <input name="cost" type="number" min="0" step="0.01" value="${product.cost || 0}"></label>
      <p id="stock-preview" class="badge">Conversion pendiente</p>
      <p class="hint">Si escribes el costo de una caja o paquete, el sistema lo divide entre su contenido para calcular el costo real por pieza.</p>
      <div class="actions"><button class="primary">Guardar</button><button type="button" class="ghost" data-close-modal>Cancelar</button></div>
    </form>
  `);
  const form = document.querySelector("#stock-form");
  const updateStockPreview = (receiptChanged = false) => {
    const data = Object.fromEntries(new FormData(form));
    const receiptType = data.receiptType;
    const usesContainer = ["box", "largePackage"].includes(receiptType);
    document.querySelector("#container-label").style.display = usesContainer ? "grid" : "none";
    if (receiptChanged) form.costMode.value = receiptType === "base" ? "base" : "received";
    const currentCostMode = form.costMode.value;
    document.querySelector("#cost-mode-label").style.display = receiptType === "base" ? "none" : "grid";
    document.querySelector("#cost-label-text").textContent = currentCostMode === "received"
      ? `Costo de cada ${receivedUnitName(receiptType)}`
      : `Costo por ${product.stockUnit === "pieza" ? "pieza" : product.stockUnit}`;
    const qty = Number(data.qty || 0);
    const unitsPerContainer = Number(data.unitsPerContainer || 1);
    const converted = convertStockInput(product, receiptType, qty, unitsPerContainer);
    const enteredCost = Number(data.cost || 0);
    const unitCost = calculateUnitCost(product, receiptType, enteredCost, unitsPerContainer, currentCostMode);
    const quantityText = qty > 0 ? `Equivale a ${unitLabel(product, converted)}` : "Conversion pendiente";
    const costText = enteredCost >= 0 ? `Costo calculado por ${product.stockUnit === "pieza" ? "pieza" : product.stockUnit}: ${money.format(unitCost)}` : "";
    document.querySelector("#stock-preview").textContent = `${quantityText} | ${costText}`;
  };
  form.receiptType.addEventListener("change", () => updateStockPreview(true));
  form.qty.addEventListener("input", () => updateStockPreview(false));
  form.unitsPerContainer.addEventListener("input", () => updateStockPreview(false));
  form.costMode.addEventListener("change", () => updateStockPreview(false));
  form.cost.addEventListener("input", () => updateStockPreview(false));
  updateStockPreview();
  form.addEventListener("submit", event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    const unitsPerContainer = Number(data.unitsPerContainer || 1);
    const qty = convertStockInput(product, data.receiptType, Number(data.qty), unitsPerContainer);
    const unitCost = calculateUnitCost(product, data.receiptType, Number(data.cost || 0), unitsPerContainer, data.costMode);
    const change = data.type === "Salida manual" ? -qty : qty;
    if (product.units + change < 0) return toast("No puedes dejar cantidades negativas");
    const before = product.units;
    product.units += change;
    if (change > 0) {
      const beforeCost = product.cost;
      const beforePrice = product.price;
      product.cost = unitCost;
      recordProductPriceChange(product, beforeCost, beforePrice, "Entrada de inventario");
      addLot(product, change, unitCost, `${data.receiptType}/${data.costMode}`);
    }
    addMovement(product, data.type, before, change, product.units, product.id);
    logOperation("stock", "products", product.id, `${data.type} de ${unitLabel(product, qty)} con costo unitario ${money.format(unitCost)}`);
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
  if (!product.active) {
    product.active = true;
    logOperation("restaurar_producto", "products", product.id, `Restauro ${product.name}`);
    saveState();
    render();
    toast("Producto restaurado");
    return;
  }
  showModal(`
    <h2>Eliminar producto</h2>
    <p>Se quitara <strong>${escapeHtml(product.name)}</strong> del inventario y del punto de venta.</p>
    <p class="muted">Su historial se conservara para no alterar ventas, costos ni reportes anteriores.</p>
    <div class="actions">
      <button class="danger" id="confirm-delete-product">Eliminar</button>
      <button class="ghost" data-close-modal>Cancelar</button>
    </div>
  `);
  document.querySelector("#confirm-delete-product").addEventListener("click", () => {
    product.active = false;
    logOperation("eliminar_producto", "products", product.id, `Elimino ${product.name} del catalogo`);
    saveState();
    closeModal();
    render();
    toast("Producto eliminado del catalogo");
  });
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
    <div class="table-wrap"><table><thead><tr><th>Producto</th><th>Forma de venta</th><th>Cant.</th><th>Salio del inventario</th>${sellerView ? "" : "<th>Lo que costo</th>"}<th>Precio</th><th>Total</th>${sellerView ? "" : "<th>Ganancia</th>"}</tr></thead>
    <tbody>${sale.items.map(item => `<tr><td>${item.name}</td><td>${item.optionName || "Por pieza"}</td><td>${item.qty - (item.returnedQty || 0)}</td><td>${itemStockQty(item) - (item.returnedStockQty || 0)}</td>${sellerView ? "" : `<td>${money.format(itemNetCost(item))}</td>`}<td>${money.format(item.price)}</td><td>${money.format(itemNetSold(item))}</td>${sellerView ? "" : `<td>${money.format(itemNetProfit(item))}</td>`}</tr>`).join("")}</tbody></table></div>
    <button class="ghost" data-close-modal>Cerrar</button>
  `);
}

function authorizeModal(title, onSuccess) {
  const credentialFields = secureCloudAuth ? "" : `
      <label>Usuario <input name="username" placeholder="Supervisor/admin"></label>
      <label>Contrasena <input name="password" type="password" placeholder="Contrasena"></label>`;
  showModal(`
    <h2>${title}</h2>
    <p class="muted">${secureCloudAuth ? "Ingresa la clave fija autorizada o un token temporal vigente." : "Ingresa usuario y contrasena de supervisor/admin, la clave fija autorizada o un token temporal vigente."}</p>
    <form id="auth-form" class="stack">
      ${credentialFields}
      <label>Clave fija o token temporal <input name="authCode" inputmode="numeric" placeholder="Clave o token"></label>
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
    if (secureCloudAuth) return toast("Autorizacion invalida: usa token o clave fija vigente");
    const authUser = state.users.find(user => user.username === data.username && user.password === data.password && user.active && (isMaster(user) || ["admin", "supervisor"].includes(user.role)) && canAccess("authorizations", user));
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
    restoreCostLayers(product, item, item.returnedStockQty || 0, qtyToRestore, `Cancelacion ${sale.id}`);
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
    const previousReturnedStockQty = Number(line.returnedStockQty || 0);
    const before = product.units;
    product.units += stockReturnQty;
    const returnedCost = restoreCostLayers(product, line, previousReturnedStockQty, stockReturnQty, `Devolucion ${sale.id}`);
    line.returnedQty = (line.returnedQty || 0) + qty;
    line.returnedStockQty = previousReturnedStockQty + stockReturnQty;
    line.returnedCostTotal = Number(line.returnedCostTotal || 0) + returnedCost;
    totalReturned += qty * line.price;
    addMovement(product, "Entrada por devolucion", before, stockReturnQty, product.units, sale.id);
    return { productId, qty, price: line.price, subtotal: qty * line.price, cost: returnedCost };
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
      ${metric("Tarjeta/transferencia", money.format(ticketSold))}
      ${metric("Gastos", money.format(spent))}
      ${metric("Esperado en caja", money.format(expected))}
      ${metric("Cuadre completo", money.format(expectedWithTickets))}
    </div>
    <div class="panel">
      <h3>Notas registradas en esta caja</h3>
      ${sales.length ? `<div class="table-wrap"><table><thead><tr><th>Nota</th><th>Hora</th><th>Pago</th><th>Total</th></tr></thead><tbody>${noteRows}</tbody></table></div>` : `<p class="empty">No hay notas registradas.</p>`}
    </div>
    <button class="primary" id="close-cash">Cerrar caja / corte con token</button>
  `;
}

function closeCash() {
  const cash = openCash();
  if (!cash) return toast("No hay caja abierta");
  authorizeCashCloseModal(authUser => completeCloseCash(cash.id, authUser));
}

function authorizeCashCloseModal(onSuccess) {
  showModal(`
    <h2>Autorizar corte de caja</h2>
    <p class="muted">Para cerrar caja se requiere un token temporal de un solo uso generado por administrador o supervisor.</p>
    <form id="cash-close-auth-form" class="stack">
      <label>Token de cierre <input name="authCode" inputmode="numeric" required placeholder="6 digitos"></label>
      <div class="actions"><button class="primary">Autorizar corte</button><button type="button" class="ghost" data-close-modal>Cancelar</button></div>
    </form>
  `);
  document.querySelector("#cash-close-auth-form").addEventListener("submit", event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    const authUser = validateTokenOnly(data.authCode);
    if (!authUser) return toast("Token invalido o expirado");
    onSuccess(authUser);
  });
}

function completeCloseCash(cashId, authUser) {
  const cash = openCash();
  if (!cash || cash.id !== cashId) return toast("No hay caja abierta");
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
  cash.closedByAuthorization = authUser.id;
  logOperation("cierre_caja", "cashRegisters", cash.id, `Cierre por ${money.format(cash.finalAmount)} autorizado por ${authUser.name}`);
  saveState();
  closeModal();
  render();
  toast("Caja cerrada");
}

function renderReports(root) {
  root.innerHTML = `
    <div class="panel">
      <div class="toolbar">
        <label>Desde <input type="date" id="report-start" value="${today()}"></label>
        <label>Hasta <input type="date" id="report-end" value="${today()}"></label>
      </div>
      <div id="report-content"></div>
    </div>
  `;
  document.querySelector("#report-start").addEventListener("change", drawReports);
  document.querySelector("#report-end").addEventListener("change", drawReports);
  drawReports();
}

function drawReports() {
  const start = document.querySelector("#report-start").value;
  const end = document.querySelector("#report-end").value;
  const sales = state.sales.filter(sale => sale.date >= start && sale.date <= end && sale.status !== "cancelada");
  const expenses = state.expenses.filter(expense => expense.date >= start && expense.date <= end);
  const rows = sales.flatMap(sale => sale.items.map(item => ({ type: `producto/${sale.paymentMethod || "efectivo"}`, date: sale.date, time: sale.time, name: `${item.name} (${item.optionName || "Unidad"}) - Nota ${sale.ticketFolio || "-"}`, qty: item.qty - (item.returnedQty || 0), cost: itemNetCost(item), sold: itemNetSold(item), profit: itemNetProfit(item) })));
  expenses.forEach(expense => rows.push({ type: "gasto", date: expense.date, time: expense.time, name: expense.description, qty: 1, cost: 0, sold: -expense.amount, profit: -expense.amount }));
  const cashTotal = sales.reduce((sum, sale) => sum + salePaymentAmount(sale, "efectivo"), 0);
  const cardTotal = sales.reduce((sum, sale) => sum + salePaymentAmount(sale, "tarjeta"), 0);
  const transferTotal = sales.reduce((sum, sale) => sum + salePaymentAmount(sale, "transferencia"), 0);
  const sellerTotals = sales.reduce((map, sale) => {
    const current = map.get(sale.userId) || { userId: sale.userId, sales: 0, total: 0 };
    current.sales += 1;
    current.total += sale.total;
    map.set(sale.userId, current);
    return map;
  }, new Map());
  const totals = rows.reduce((acc, row) => {
    acc.cost += row.cost;
    acc.sold += row.sold;
    acc.profit += row.profit;
    return acc;
  }, { cost: 0, sold: 0, profit: 0 });
  document.querySelector("#report-content").innerHTML = `
    <div class="grid cols-3">
      ${metric("Lo que costo", money.format(totals.cost))}
      ${metric("Venta total", money.format(totals.sold))}
      ${metric("Ganancia neta", money.format(totals.profit))}
    </div>
    <div class="grid cols-3">
      ${metric("Efectivo", money.format(cashTotal))}
      ${metric("Tarjeta", money.format(cardTotal))}
      ${metric("Transferencia", money.format(transferTotal))}
    </div>
    <div class="grid cols-2">
      <div class="panel">
        <h2>Productos mas vendidos</h2>
        ${topSoldProducts(sales, 10).length ? topProductsTable(topSoldProducts(sales, 10)) : `<p class="empty">Sin ventas en el periodo.</p>`}
      </div>
      <div class="panel">
        <h2>Ventas por usuario</h2>
        ${sellerTotals.size ? `<div class="table-wrap"><table><thead><tr><th>Usuario</th><th>Ventas</th><th>Total</th></tr></thead><tbody>${[...sellerTotals.values()].map(row => `<tr><td>${userName(row.userId)}</td><td>${row.sales}</td><td>${money.format(row.total)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="empty">Sin ventas por usuario.</p>`}
      </div>
    </div>
    ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Tipo</th><th>Nombre</th><th>Fecha</th><th>Hora</th><th>Cantidad</th><th>Lo que costo</th><th>Venta o gasto</th><th>Ganancia</th></tr></thead><tbody>${rows.map(row => `<tr><td>${row.type}</td><td>${row.name}</td><td>${row.date}</td><td>${row.time}</td><td>${row.qty}</td><td>${money.format(row.cost)}</td><td>${money.format(row.sold)}</td><td>${money.format(row.profit)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="empty">Sin movimientos para este periodo.</p>`}
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
  const canCreate = isMaster() || currentUser().role === "admin";
  root.innerHTML = `
    <div class="panel">
      <div class="split"><h2>Usuarios y accesos</h2><button class="primary" id="new-user" ${canCreate ? "" : "disabled"}>Nuevo usuario</button></div>
      <p class="muted">Activa o quita accesos por usuario. Solo el Dueno/Master puede modificar administradores; nadie puede desactivar o cambiar al Master.</p>
      ${userTable()}
    </div>
  `;
  document.querySelector("#new-user").addEventListener("click", () => userModal());
  document.querySelectorAll("[data-edit-user]").forEach(button => button.addEventListener("click", () => userModal(button.dataset.editUser)));
  document.querySelectorAll("[data-toggle-user]").forEach(button => button.addEventListener("click", () => toggleUser(button.dataset.toggleUser)));
}

function userTable() {
  return `<div class="table-wrap"><table><thead><tr><th>Nombre</th><th>Usuario</th>${secureCloudAuth ? "<th>Correo Auth</th>" : ""}<th>Tipo de usuario</th><th>Accesos</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>${state.users.map(user => {
    const accessCount = VIEW_ACCESS.filter(item => canAccess(item.id, user)).length;
    const editable = canEditUser(user);
    const canToggle = editable && user.id !== session.userId && !isMaster(user);
    return `<tr>
      <td>${escapeHtml(user.name)}</td>
      <td>${escapeHtml(user.username)}</td>
      ${secureCloudAuth ? `<td>${escapeHtml(user.authEmail || authEmailForUsername(user.username))}</td>` : ""}
      <td>${roleLabel(user.role)}</td>
      <td>${isMaster(user) ? "Todos" : `${accessCount} de ${VIEW_ACCESS.length}`}</td>
      <td><span class="badge ${user.active ? "ok" : "danger"}">${user.active ? "Activo" : "Inactivo"}</span></td>
      <td><div class="actions">
        <button class="tiny" data-edit-user="${user.id}" ${editable ? "" : "disabled"}>Editar</button>
        <button class="tiny danger" data-toggle-user="${user.id}" ${canToggle ? "" : "disabled"}>${user.active ? "Desactivar" : "Activar"}</button>
      </div></td>
    </tr>`;
  }).join("")}</tbody></table></div>`;
}

function userModal(userId) {
  const existing = state.users.find(item => item.id === userId);
  if (!userId && !isMaster() && currentUser().role !== "admin") return toast("Solo administracion puede crear usuarios");
  if (userId && !canEditUser(existing)) return toast("No tienes permiso para modificar ese usuario");
  const user = existing || { role: "vendedor", access: defaultAccessForRole("vendedor") };
  const actorIsMaster = isMaster();
  const targetIsMaster = isMaster(user);
  const selectedAccess = { ...defaultAccessForRole(user.role), ...(user.access || {}) };
  const authFields = secureCloudAuth
    ? `<label>Correo de acceso Supabase <input name="authEmail" type="email" required value="${escapeHtml(user.authEmail || authEmailForUsername(user.username || ""))}"></label>`
    : `<label>Contrasena <input name="password" required value="${escapeHtml(user.password || "")}"></label>`;
  const roleOptions = targetIsMaster
    ? `<option value="master" selected>Dueno/Master</option>`
    : `${actorIsMaster ? `<option value="admin" ${user.role === "admin" ? "selected" : ""}>Administrador</option>` : ""}<option value="supervisor" ${user.role === "supervisor" ? "selected" : ""}>Supervisor</option><option value="vendedor" ${user.role === "vendedor" ? "selected" : ""}>Vendedor</option>`;
  showModal(`
    <h2>${userId ? "Editar usuario" : "Nuevo usuario"}</h2>
    <form id="user-form" class="stack">
      <div class="grid cols-2">
        <label>Nombre <input name="name" required value="${escapeHtml(user.name || "")}"></label>
        <label>Usuario <input name="username" required value="${escapeHtml(user.username || "")}"></label>
        ${authFields}
        <label>Tipo de usuario <select name="role" ${targetIsMaster ? "disabled" : ""}>${roleOptions}</select></label>
      </div>
      <div class="panel compact">
        <h3>Accesos permitidos</h3>
        <div class="grid cols-2" id="user-access-list">
          ${VIEW_ACCESS.map(item => `<label><input type="checkbox" name="access" value="${item.id}" ${selectedAccess[item.id] ? "checked" : ""} ${targetIsMaster ? "disabled" : ""}> ${item.label}</label>`).join("")}
        </div>
        <p class="hint">${secureCloudAuth ? "Crea tambien este correo en Supabase Authentication. La contrasena se administra en Supabase, no en este sistema." : "Autorizaciones permite generar tokens y autorizar operaciones con usuario y contrasena."}</p>
      </div>
      <div class="actions"><button class="primary">Guardar</button><button type="button" class="ghost" data-close-modal>Cancelar</button></div>
    </form>
  `);
  const form = document.querySelector("#user-form");
  form.role?.addEventListener("change", event => {
    const defaults = defaultAccessForRole(event.target.value);
    form.querySelectorAll("[name='access']").forEach(input => {
      input.checked = Boolean(defaults[input.value]);
    });
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    const formData = new FormData(event.target);
    const data = Object.fromEntries(formData);
    const role = targetIsMaster ? "master" : data.role;
    if ((role === "admin" || role === "master") && !actorIsMaster) return toast("Solo el Master puede asignar administradores");
    if (state.users.some(item => item.username === data.username && item.id !== userId)) return toast("Ese usuario ya existe");
    const selected = formData.getAll("access");
    const access = targetIsMaster
      ? { ...DEFAULT_ACCESS.master }
      : Object.fromEntries(VIEW_ACCESS.map(item => [item.id, selected.includes(item.id)]));
    if (role !== "admin") access.users = false;
    if (userId) {
      const update = { name: data.name, username: data.username, authEmail: data.authEmail || authEmailForUsername(data.username), role, access };
      if (!secureCloudAuth) update.password = data.password;
      Object.assign(user, update);
      logOperation("editar_usuario", "users", user.id, `Edito usuario ${user.name}`);
    } else {
      const createdData = { id: uid("usr"), name: data.name, username: data.username, authEmail: data.authEmail || authEmailForUsername(data.username), role, access, active: true };
      if (!secureCloudAuth) createdData.password = data.password;
      const created = normalizeUser(createdData);
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
  if (!canEditUser(user) || isMaster(user) || user.id === session.userId) return toast("No puedes cambiar el estado de ese usuario");
  user.active = !user.active;
  logOperation("estado_usuario", "users", user.id, `${user.active ? "Activo" : "Desactivo"} usuario ${user.name}`);
  saveState();
  render();
}

function renderBackup(root) {
  root.innerHTML = `
    <div class="grid cols-2">
      <div class="panel">
        <h2>Respaldo de informacion</h2>
        <p class="muted">Descarga una copia de productos, ventas, cajas, usuarios, gastos y bitacora.</p>
        <div class="actions"><button class="primary" id="make-backup">Generar respaldo</button><button class="ghost" id="load-cloud-backups">Actualizar lista nube</button></div>
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
  document.querySelector("#load-cloud-backups").addEventListener("click", loadCloudBackups);
  document.querySelector("#restore-backup").addEventListener("click", restoreBackup);
  document.querySelectorAll("[data-download-backup]").forEach(button => button.addEventListener("click", () => downloadBackupById(button.dataset.downloadBackup)));
}

async function makeBackup() {
  const backup = createBackupRecord("manual");
  state.backups.unshift(backupMetadata(backup));
  logOperation("respaldo", "backups", backup.id, "Genero respaldo de informacion");
  saveState();
  await saveBackupToCloud(backup);
  downloadBackup(backup);
  render();
}

function createBackupRecord(kind = "manual") {
  const date = today();
  const time = nowTime();
  return {
    id: uid("bak"),
    kind,
    businessId: cloudBusinessId,
    date,
    time,
    userId: session?.userId || "sistema",
    filename: `respaldo-tienda-${date}-${kind}.json`,
    data: backupStateSnapshot()
  };
}

function backupMetadata(backup) {
  return { id: backup.id, kind: backup.kind, date: backup.date, time: backup.time, userId: backup.userId, filename: backup.filename };
}

function downloadBackup(backup) {
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = backup.filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function saveBackupToCloud(backup) {
  const client = getCloudClient();
  if (!client) return;
  try {
    await client.from("pos_backups").insert({
      id: backup.id,
      business_id: cloudBusinessId,
      backup_type: backup.kind,
      created_by: backup.userId,
      filename: backup.filename,
      state: backup.data
    });
  } catch (error) {
    console.warn("No se pudo guardar respaldo en nube:", error.message);
  }
}

async function loadCloudBackups() {
  const client = getCloudClient();
  if (!client) return toast("La nube no esta configurada");
  const { data, error } = await client
    .from("pos_backups")
    .select("id, backup_type, created_by, filename, created_at")
    .eq("business_id", cloudBusinessId)
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) return toast("No se pudo cargar lista de respaldos");
  state.backups = data.map(item => ({
    id: item.id,
    kind: item.backup_type,
    date: item.created_at.slice(0, 10),
    time: new Date(item.created_at).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" }),
    userId: item.created_by,
    filename: item.filename,
    cloud: true
  }));
  saveState();
  render();
  toast("Lista de respaldos actualizada");
}

async function downloadBackupById(id) {
  const local = state.backups.find(backup => backup.id === id);
  const client = getCloudClient();
  if (!client) return toast("Solo se pueden descargar respaldos historicos desde la nube");
  const { data, error } = await client
    .from("pos_backups")
    .select("id, backup_type, created_by, filename, state, created_at")
    .eq("id", id)
    .single();
  if (error || !data) return toast("No se pudo descargar el respaldo");
  downloadBackup({
    id: data.id,
    kind: data.backup_type,
    businessId: cloudBusinessId,
    date: data.created_at.slice(0, 10),
    time: new Date(data.created_at).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" }),
    userId: data.created_by,
    filename: data.filename || local?.filename || `respaldo-${data.id}.json`,
    data: data.state
  });
}

async function maybeAutoBackup() {
  if (autoBackupBusy || !session || !cloudMode) return;
  const key = `lastAutoBackup:${cloudBusinessId}`;
  if (localStorage.getItem(key) === today()) return;
  autoBackupBusy = true;
  try {
    const backup = createBackupRecord("automatico");
    state.backups.unshift(backupMetadata(backup));
    state.backups = state.backups.slice(0, 30);
    logOperation("respaldo_auto", "backups", backup.id, "Genero respaldo automatico diario", backup.userId);
    localStorage.setItem(key, today());
    saveState();
    await saveBackupToCloud(backup);
  } finally {
    autoBackupBusy = false;
  }
}

function restoreBackup() {
  const file = document.querySelector("#restore-file").files[0];
  if (!file) return toast("Selecciona un archivo");
  if (!confirm("Restaurar un respaldo reemplazara la informacion actual del sistema. Confirma que tienes una copia reciente antes de continuar.")) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const backup = JSON.parse(reader.result);
      state = backup.data || backup;
      logOperation("restauracion", "backups", backup.id || "manual", "Restauro respaldo de informacion");
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
  return `<div class="table-wrap"><table><thead><tr><th>Archivo</th><th>Tipo</th><th>Fecha</th><th>Hora</th><th>Usuario</th><th>Acciones</th></tr></thead><tbody>${state.backups.map(backup => `<tr><td>${backup.filename}</td><td>${backup.kind || "manual"}</td><td>${backup.date}</td><td>${backup.time}</td><td>${userName(backup.userId)}</td><td><button class="tiny" data-download-backup="${backup.id}">Descargar</button></td></tr>`).join("")}</tbody></table></div>`;
}

function expenseTable(expenses) {
  if (!expenses.length) return `<p class="empty">No hay gastos registrados.</p>`;
  return `<div class="table-wrap"><table><thead><tr><th>Descripcion</th><th>Monto</th><th>Fecha</th><th>Usuario</th></tr></thead><tbody>${expenses.map(expense => `<tr><td>${expense.description}</td><td>${money.format(expense.amount)}</td><td>${expense.date} ${expense.time}</td><td>${userName(expense.userId)}</td></tr>`).join("")}</tbody></table></div>`;
}

function movementTable(movements) {
  if (!movements.length) return `<p class="empty">Sin movimientos de inventario.</p>`;
  return `<div class="table-wrap"><table><thead><tr><th>Producto</th><th>Operacion</th><th>Antes</th><th>Cambio</th><th>Despues</th><th>Usuario</th><th>Fecha</th></tr></thead><tbody>${movements.map(mov => `<tr><td>${state.products.find(p => p.id === mov.productId)?.name || "Producto"}</td><td>${mov.type}</td><td>${mov.before}</td><td>${mov.change}</td><td>${mov.after}</td><td>${userName(mov.userId)}</td><td>${mov.date} ${mov.time}</td></tr>`).join("")}</tbody></table></div>`;
}

function simpleLogTable(logs) {
  return `<div class="table-wrap"><table><thead><tr><th>Operacion</th><th>Usuario</th><th>Fecha</th></tr></thead><tbody>${logs.map(log => `<tr><td>${log.description}</td><td>${userName(log.userId)}</td><td>${log.date} ${log.time}</td></tr>`).join("")}</tbody></table></div>`;
}

function cashTable(cashes) {
  if (!cashes.length) return `<p class="empty">Sin cajas para mostrar.</p>`;
  return `<div class="table-wrap"><table><thead><tr><th>Usuario</th><th>Apertura</th><th>Inicio de caja</th><th>Estado</th><th>Efectivo final</th><th>Tarjeta/transf.</th></tr></thead><tbody>${cashes.map(cash => `<tr><td>${userName(cash.userId)}</td><td>${cash.dateOpen} ${cash.timeOpen}</td><td>${money.format(cash.initialAmount)}</td><td><span class="badge ${cash.status === "abierta" ? "ok" : ""}">${cash.status}</span></td><td>${cash.finalAmount == null ? "-" : money.format(cash.finalAmount)}</td><td>${cash.ticketAmount == null ? "-" : money.format(cash.ticketAmount)}</td></tr>`).join("")}</tbody></table></div>`;
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
