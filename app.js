const DB_NAME = 'gstbill-local-db';
const DB_VERSION = 1;
const PROFILE_KEY = 'gstbill-business-profile';
const DRAFT_KEY = 'gstbill-current-draft';
const GST_RATES = [0, 5, 12, 18, 28];
const TEST_BARCODE = '123456789012';
const productCatalog = (Array.isArray(window.GSTBILL_PRODUCTS) ? window.GSTBILL_PRODUCTS : [])
  .map((product, index) => ({ ...product, id: Number(product.id) || index + 1 }));
let db;
let items = [];
let nextProductId = productCatalog.reduce((highest, product) => Math.max(highest, Number(product.id) || 0), 0) + 1;
let toastTimer;
let cameraScanner;
let lastCameraCode = '';
let cameraResetTimer;
const $ = (id) => document.getElementById(id);
const fields = ['businessName', 'businessGstin', 'businessAddress', 'invoiceNumber', 'invoiceDate', 'placeOfSupply', 'taxType', 'customerName', 'customerGstin', 'customerAddress', 'paymentMethod', 'invoiceNotes', 'discountType', 'discountValue'];

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('invoices')) database.createObjectStore('invoices', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function storeRequest(storeName, mode, action) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = action(tx.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
const getAll = (name) => storeRequest(name, 'readonly', (store) => store.getAll());
const put = (name, value) => storeRequest(name, 'readwrite', (store) => store.put(value));
const getProducts = () => Promise.resolve(productCatalog);

function productMatches(existing, product) {
  const sameName = String(existing.name || '').trim().toLowerCase() === String(product.name || '').trim().toLowerCase();
  if (product.barcode) return String(existing.barcode || '').trim() === product.barcode || (!existing.barcode && sameName);
  return !existing.barcode && sameName;
}

async function saveProductCatalog() {
  const source = `window.GSTBILL_PRODUCTS = ${JSON.stringify(productCatalog, null, 2)};\n`;
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: 'product-data.js',
        types: [{ description: 'JavaScript file', accept: { 'text/javascript': ['.js'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(source);
      await writable.close();
      showToast('Saved product-data.js — reload the app to use the saved catalog');
    } catch (error) {
      if (error.name !== 'AbortError') {
        const message = `Could not save product-data.js: ${error.message || 'file access was denied'}`;
        setStatus(message, true);
        showToast(message);
      }
    }
    return;
  }
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'product-data.js';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('Downloaded product-data.js — replace the project file and redeploy');
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
function money(value) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format(Number(value) || 0);
}
function number(value, fallback = 0) {
  const parsed = Number(String(value ?? '').replace(/,/g, '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}
function safeDate(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString().slice(0, 10) : date.toISOString().slice(0, 10);
}
function formatDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${value}T00:00:00`));
}
function nextInvoiceNumber() {
  return getAll('invoices').then((invoices) => {
    const prefix = `NM-${new Date().getFullYear()}-`;
    const highest = invoices.reduce((max, invoice) => {
      const match = String(invoice.number || '').match(/(\d+)$/);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
    return `${prefix}${String(highest + 1).padStart(4, '0')}`;
  });
}
function setStatus(message, isError = false) {
  const status = $('importStatus');
  status.textContent = message;
  status.classList.toggle('error', isError);
  if (message) window.setTimeout(() => { if (status.textContent === message) status.textContent = ''; }, 6500);
}
function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 2600);
}
function lineAmounts(item) {
  const quantity = Math.max(0, number(item.quantity));
  const rate = Math.max(0, number(item.rate));
  const subtotal = quantity * rate;
  const discountPercent = Math.min(100, Math.max(0, number(item.discountPercent)));
  const discount = subtotal * discountPercent / 100;
  const priceAfterDiscount = subtotal - discount;
  const gstRate = Math.max(0, number(item.gstRate));
  const taxable = gstRate ? priceAfterDiscount / (1 + gstRate / 100) : priceAfterDiscount;
  const tax = priceAfterDiscount - taxable;
  return { subtotal, discount, taxable, tax, total: priceAfterDiscount };
}
function currentInvoice() {
  const data = Object.fromEntries(fields.map((id) => [id, $(id).value.trim()]));
  data.invoiceDate = data.invoiceDate || new Date().toISOString().slice(0, 10);
  data.items = items.map((item) => ({ ...item }));
  data.paymentMethod = data.paymentMethod || 'Cash';
  return data;
}
function totals() {
  const taxableSubtotal = items.reduce((sum, item) => sum + lineAmounts(item).taxable, 0);
  const itemDiscount = items.reduce((sum, item) => sum + lineAmounts(item).discount, 0);
  const tax = items.reduce((sum, item) => sum + lineAmounts(item).tax, 0);
  const grossSubtotal = items.reduce((sum, item) => sum + lineAmounts(item).subtotal, 0);
  const interstate = $('taxType').value === 'inter';
  const discountInput = Math.max(0, number($('discountValue').value));
  const afterItemDiscount = grossSubtotal - itemDiscount;
  const discount = Math.min(afterItemDiscount, $('discountType').value === 'percent' ? afterItemDiscount * Math.min(100, discountInput) / 100 : discountInput);
  return { subtotal: taxableSubtotal, grossSubtotal, itemDiscount, cgst: interstate ? 0 : tax / 2, sgst: interstate ? 0 : tax / 2, igst: interstate ? tax : 0, discount, total: taxableSubtotal + tax - discount };
}
function persistDraft() {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(currentInvoice())); } catch { /* Private browsing may block storage. */ }
}
function updatePreview() {
  const bill = currentInvoice();
  const sum = totals();
  $('subtotalValue').textContent = money(sum.subtotal);
  $('grossSubtotalValue').textContent = money(sum.grossSubtotal);
  $('cgstValue').textContent = money(sum.cgst);
  $('sgstValue').textContent = money(sum.sgst);
  $('igstValue').textContent = money(sum.igst);
  $('discountValueDisplay').textContent = `−${money(sum.discount)}`;
  $('discountSummaryLine').hidden = sum.discount <= 0;
  $('itemDiscountValue').textContent = `−${money(sum.itemDiscount)}`;
  $('itemDiscountSummaryLine').hidden = sum.itemDiscount <= 0;
  const hasTax = sum.cgst + sum.sgst + sum.igst > 0;
  $('cgstLine').hidden = bill.taxType === 'inter' || !hasTax;
  $('sgstLine').hidden = bill.taxType === 'inter' || !hasTax;
  $('igstLine').hidden = bill.taxType !== 'inter' || !hasTax;
  $('totalValue').textContent = money(sum.total);
  $('itemCountLabel').textContent = `${items.length} ${items.length === 1 ? 'item' : 'items'}`;
  const receiptRows = items.map((item) => {
    const amount = lineAmounts(item);
    return `<tr><td class="receipt-desc">${escapeHtml(item.name || 'Item')}<br>${number(item.quantity)} × ${money(item.rate)}${number(item.discountPercent) ? ` · ${number(item.discountPercent)}% off` : ''} · GST ${number(item.gstRate)}%</td><td>${money(amount.total)}</td></tr>`;
  }).join('');
  const taxLines = sum.cgst + sum.sgst + sum.igst === 0 ? '' : bill.taxType === 'inter' ? `<div class="receipt-pair"><span>IGST</span><span>${money(sum.igst ?? sum.cgst + sum.sgst)}</span></div>` : `<div class="receipt-pair"><span>CGST</span><span>${money(sum.cgst)}</span></div><div class="receipt-pair"><span>SGST</span><span>${money(sum.sgst)}</span></div>`;
  bill.discount = sum.discount;
  bill.itemDiscount = sum.itemDiscount;
  const receipt = `<div class="receipt-center"><h3>${escapeHtml(bill.businessName || 'YOUR BUSINESS')}</h3><div class="receipt-sub">${escapeHtml(bill.businessAddress || '')}</div>${bill.businessGstin ? `<div class="receipt-sub">GSTIN: ${escapeHtml(bill.businessGstin.toUpperCase())}</div>` : ''}</div><div class="receipt-rule"></div><div class="receipt-center"><b>TAX INVOICE</b></div><div class="receipt-pair"><span>No: ${escapeHtml(bill.invoiceNumber || '—')}</span><span>${escapeHtml(formatDate(bill.invoiceDate))}</span></div>${bill.placeOfSupply ? `<div class="receipt-pair"><span>Place of supply</span><span>${escapeHtml(bill.placeOfSupply)}</span></div>` : ''}<div class="receipt-rule"></div><div><b>Bill to:</b> ${escapeHtml(bill.customerName || 'Cash customer')}</div>${bill.customerGstin ? `<div class="receipt-sub">GSTIN: ${escapeHtml(bill.customerGstin.toUpperCase())}</div>` : ''}${bill.customerAddress ? `<div class="receipt-sub">${escapeHtml(bill.customerAddress)}</div>` : ''}<div class="receipt-rule"></div><table class="receipt-items"><thead><tr><th>Item / Qty</th><th>Amount</th></tr></thead><tbody>${receiptRows}</tbody></table><div class="receipt-rule"></div><div class="receipt-pair"><span>Subtotal (incl. GST)</span><span>${money(sum.grossSubtotal)}</span></div>${number(bill.itemDiscount) > 0 ? `<div class="receipt-pair"><span>Product discounts</span><span>−${money(bill.itemDiscount)}</span></div>` : ''}<div class="receipt-pair"><span>Taxable value</span><span>${money(sum.subtotal)}</span></div>${taxLines}<div class="receipt-rule"></div><div class="receipt-pair receipt-total"><span>TOTAL</span><span>${money(sum.total)}</span></div><div class="receipt-pair"><span>Payment</span><span>${escapeHtml(bill.paymentMethod)}</span></div>${bill.invoiceNotes ? `<div class="receipt-center receipt-sub">${escapeHtml(bill.invoiceNotes)}</div>` : ''}<div class="receipt-center receipt-thanks">Thank you!</div>`;
  $('receiptPreview').innerHTML = formatGroceryReceipt(receipt, bill);
}
function formatGroceryReceipt(receipt, bill) {
  return receipt
    .replace('<b>TAX INVOICE</b>', `<b>${bill.businessGstin ? 'TAX INVOICE' : 'GROCERY BILL'}</b>`)
    .replace('<b>Bill to:</b>', '<b>Customer:</b>')
    .replace('<th>Item / Qty</th>', '<th>Grocery / Qty</th>')
    .replace('<div class="receipt-rule"></div><div class="receipt-pair receipt-total">', `${number(bill.discount) > 0 ? `<div class="receipt-pair"><span>Discount</span><span>−${money(bill.discount)}</span></div>` : ''}<div class="receipt-rule"></div><div class="receipt-pair receipt-total">`);
}
function drawItems() {
  $('itemsBody').innerHTML = items.map((item, index) => `<tr data-index="${index}"><td data-label="Item"><input class="item-input name-input" data-field="name" aria-label="Grocery item" value="${escapeHtml(item.name)}" placeholder="Grocery item"></td><td data-label="HSN/SAC"><input class="item-input" data-field="hsn" aria-label="HSN code" value="${escapeHtml(item.hsn)}" placeholder="—"></td><td data-label="Quantity"><input class="item-input numeric" data-field="quantity" aria-label="Quantity" type="number" min="0" step="any" value="${number(item.quantity, 1)}"></td><td data-label="Rate (₹)"><input class="item-input numeric" data-field="rate" aria-label="Rate in rupees" type="number" min="0" step="0.01" value="${number(item.rate)}"></td><td data-label="Discount %"><input class="item-input numeric" data-field="discountPercent" aria-label="Product discount percent" type="number" min="0" max="100" step="0.1" value="${number(item.discountPercent)}"></td><td data-label="GST"><select class="item-input" data-field="gstRate" aria-label="GST rate">${GST_RATES.map((rate) => `<option value="${rate}" ${number(item.gstRate) === rate ? 'selected' : ''}>${rate}%</option>`).join('')}</select></td><td class="item-amount" data-label="Amount">${money(lineAmounts(item).total)}</td><td><button class="remove-item" type="button" aria-label="Remove item" title="Remove item">×</button></td></tr>`).join('');
  updatePreview();
}
function addItem(item = {}) {
  const newItem = { name: item.name || '', barcode: item.barcode || '', hsn: item.hsn || '', quantity: number(item.quantity, 1), rate: number(item.rate), discountPercent: Math.min(100, Math.max(0, number(item.discountPercent))), gstRate: GST_RATES.includes(number(item.gstRate, 0)) ? number(item.gstRate, 0) : 0 };
  const isProduct = Boolean(newItem.name || newItem.barcode);
  if (isProduct && items.length === 1 && !items[0].name.trim() && !items[0].barcode && number(items[0].rate) === 0) items[0] = newItem;
  else items.push(newItem);
  drawItems();
  persistDraft();
}
function profileLoad() {
  try {
    const profile = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}');
    ['businessName', 'businessGstin', 'businessAddress'].forEach((id) => { $(id).value = profile[id] || (id === 'businessName' ? 'Naveen Mart' : ''); });
  } catch { /* Start with a blank seller profile. */ }
}
function draftLoad() {
  let draft;
  try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { draft = null; }
  if (!draft) return false;
  fields.forEach((id) => { if (draft[id] !== undefined && id !== 'businessName' && id !== 'businessGstin' && id !== 'businessAddress') $(id).value = draft[id]; });
  if (!$('customerName').value) $('customerName').value = 'Walk-in customer';
  $('customerGstin').value = '';
  if (Array.isArray(draft.items) && draft.items.length) items = draft.items;
  return true;
}
function saveProfile() {
  const profile = Object.fromEntries(['businessName', 'businessGstin', 'businessAddress'].map((id) => [id, $(id).value.trim()]));
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch { showToast('Could not save profile in browser storage'); }
}
async function resetBill() {
  fields.filter((id) => !['businessName', 'businessGstin', 'businessAddress'].includes(id)).forEach((id) => { if (id === 'paymentMethod') $(id).value = 'Cash'; else if (id === 'taxType') $(id).value = 'intra'; else if (id === 'discountType') $(id).value = 'amount'; else if (id === 'discountValue') $(id).value = '0'; else $(id).value = ''; });
  $('invoiceDate').value = new Date().toISOString().slice(0, 10);
  $('invoiceNumber').value = await nextInvoiceNumber();
  $('customerName').value = 'Walk-in customer';
  $('customerGstin').value = '';
  items = [{ name: '', barcode: '', hsn: '', quantity: 1, rate: 0, gstRate: 0 }];
  drawItems();
  persistDraft();
}
function showView(viewName) {
  document.querySelectorAll('.view').forEach((view) => view.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach((link) => link.classList.toggle('active', link.dataset.view === viewName));
  const target = { billing: 'billingView', history: 'historyView', products: 'productsView' }[viewName] || 'billingView';
  $(target).classList.add('active');
  const labels = { billing: 'New bill', history: 'Bill history', products: 'Product library' };
  $('crumbCurrent').textContent = labels[viewName];
  $('pageTitle').textContent = viewName === 'billing' ? 'Create a grocery bill' : labels[viewName];
  if (viewName === 'history') renderHistory();
  if (viewName === 'products') renderProducts();
}
async function refreshBillCount() {
  const invoices = await getAll('invoices');
  $('billCount').textContent = invoices.length;
}
async function renderHistory() {
  const invoices = (await getAll('invoices')).sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  $('historyList').innerHTML = invoices.length ? invoices.map((invoice) => `<div class="record-row"><div><b>${escapeHtml(invoice.number)}</b><small>${escapeHtml(invoice.customerName || 'Cash customer')} · ${escapeHtml(formatDate(invoice.invoiceDate))}</small></div><span>${escapeHtml(invoice.paymentMethod || '')}</span><span class="record-amount">${money(invoice.total)}</span><div class="row-actions"><button data-action="print" data-id="${escapeHtml(invoice.id)}">Print</button><button data-action="load" data-id="${escapeHtml(invoice.id)}">Open</button><button data-action="delete" data-id="${escapeHtml(invoice.id)}" aria-label="Delete bill">×</button></div></div>`).join('') : '<div class="empty-state"><b>No saved bills yet</b>Your invoices will appear here after you save one.</div>';
}
async function renderProducts() {
  const products = (await getProducts()).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  $('productList').innerHTML = products.length ? products.map((product) => `<div class="product-row"><div><b>${escapeHtml(product.name)}</b><small>${escapeHtml(product.barcode ? `Barcode ${product.barcode}` : product.hsn || 'No barcode')}${number(product.discountPercent) ? ` · ${number(product.discountPercent)}% product discount` : ''}</small></div><span>GST ${number(product.gstRate)}%</span><span class="record-amount">${money(product.rate)}</span><div class="row-actions"><button data-action="use" data-id="${product.id}">Add to bill</button></div></div>`).join('') : '<div class="empty-state"><b>Your product library is empty</b>Upload your grocery master list with barcode, product name and price columns.</div>';
}
function normalizeHeader(header) {
  return String(header ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function firstMatching(row, aliases) {
  const keys = Object.keys(row);
  for (const alias of aliases) {
    const found = keys.find((key) => normalizeHeader(key) === alias)
      || keys.find((key) => normalizeHeader(key).includes(alias));
    if (found) return row[found];
  }
  return '';
}
function mapProduct(row) {
  const name = firstMatching(row, ['itemdescription', 'productname', 'description', 'product', 'item', 'particulars', 'name', 'goods']);
  if (!String(name || '').trim()) return null;
  const directGst = firstMatching(row, ['gstrate', 'taxrate', 'gstpercent', 'taxpercent']);
  const igst = firstMatching(row, ['igst', 'integratedgst']);
  const cgst = firstMatching(row, ['cgst', 'centralgst']);
  const sgst = firstMatching(row, ['sgst', 'stategst', 'utgst']);
  const gstVal = directGst !== '' ? number(directGst) : igst !== '' ? number(igst) : number(cgst) + number(sgst);
  return {
    name: String(name).trim(),
    barcode: String(firstMatching(row, ['barcode', 'ean', 'upc', 'itemcode', 'productcode', 'scancode']) || '').trim(),
    hsn: String(firstMatching(row, ['hsnsac', 'hsn', 'sac', 'hsncode']) || '').trim(),
    quantity: Math.max(1, number(firstMatching(row, ['quantity', 'qty', 'units']), 1)),
    mrp: Math.max(0, number(firstMatching(row, ['mrp', 'maximumretailprice']))),
    rate: Math.max(0, number(firstMatching(row, ['sr', 'sellingrate', 'salesrate', 'sellingprice', 'unitprice', 'mrp', 'maximumretailprice', 'rate', 'price', 'amount']))),
    discountPercent: Math.min(100, Math.max(0, number(firstMatching(row, ['discountpercent', 'discountpercentage', 'discountpct', 'discpercent', 'offerpercent', 'schemepercent', 'discount'])))),
    gstRate: GST_RATES.includes(gstVal) ? gstVal : 0,
  };
}
async function renderProductSearch(query) {
  const results = $('productSearchResults');
  const search = String(query || '').trim().toLowerCase();
  if (!search) {
    results.hidden = true;
    $('productSearch').setAttribute('aria-expanded', 'false');
    return;
  }
  const products = await getProducts();
  const matches = products.filter((product) => [product.name, product.barcode, product.hsn]
    .some((value) => String(value || '').toLowerCase().includes(search)))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .slice(0, 8);
  results.innerHTML = matches.length ? matches.map((product) => `<button type="button" class="product-search-result" role="option" data-action="select-search-product" data-id="${product.id}"><span><b>${escapeHtml(product.name)}</b><small>${escapeHtml(product.barcode ? `Barcode ${product.barcode}` : product.hsn || 'Grocery item')}${number(product.discountPercent) ? ` · ${number(product.discountPercent)}% off` : ''}</small></span><strong>${money(product.rate)}</strong></button>`).join('') : '<div class="search-empty">No matching items. Import your grocery master list or add the item manually.</div>';
  results.hidden = false;
  $('productSearch').setAttribute('aria-expanded', 'true');
}
async function selectSearchProduct(id) {
  const products = await getProducts();
  const product = products.find((entry) => String(entry.id) === String(id));
  if (!product) return;
  addItem({ ...product, quantity: 1 });
  $('productSearch').value = '';
  $('productSearchResults').hidden = true;
  $('productSearch').setAttribute('aria-expanded', 'false');
  $('productSearch').focus();
}
function toggleTestBarcode() {
  const panel = $('testBarcodePanel');
  panel.hidden = !panel.hidden;
  $('testBarcodeButton').textContent = panel.hidden ? 'Show test barcode' : 'Hide test barcode';
  if (!panel.hidden && window.JsBarcode) window.JsBarcode($('testBarcodeSvg'), TEST_BARCODE, { format: 'CODE128', width: 2, height: 45, displayValue: true, margin: 8 });
}
async function scanBarcode(value) {
  const barcode = String(value || '').trim();
  if (!barcode) return;
  $('barcodeInput').value = '';
  const products = await getProducts();
  const product = products.find((entry) => String(entry.barcode || '').trim() === barcode)
    || (barcode === TEST_BARCODE ? { name: 'Test grocery item', barcode: TEST_BARCODE, hsn: '', rate: 1, gstRate: 0 } : null);
  if (!product) {
    addItem({ name: '', barcode, quantity: 1, rate: 0, gstRate: 0 });
    $('itemsBody').querySelector('tr:last-child [data-field="name"]')?.focus();
    showToast(`Barcode ${barcode} not in product library — enter item and price`);
    return;
  }
  const existing = items.find((entry) => String(entry.barcode || '') === barcode);
  if (existing) {
    existing.quantity = number(existing.quantity) + 1;
    drawItems();
    persistDraft();
  } else addItem({ ...product, quantity: 1 });
  $('barcodeInput').focus();
  showToast(`${product.name} added`);
}
async function stopCameraScanner() {
  const scanner = cameraScanner;
  cameraScanner = null;
  if (scanner) {
    try { if (scanner.isScanning) await scanner.stop(); } catch { /* Camera may already be stopped. */ }
    try { scanner.clear(); } catch { /* The preview may already be cleared. */ }
  }
  window.clearTimeout(cameraResetTimer);
  lastCameraCode = '';
  $('cameraPanel').hidden = true;
  $('cameraButton').textContent = 'Use camera';
}
async function startCameraScanner() {
  if (!navigator.mediaDevices?.getUserMedia) {
    $('cameraPanel').hidden = false;
    $('cameraStatus').textContent = 'Camera access is unavailable. Open this app from localhost or a secure HTTPS page and allow camera permission.';
    return;
  }
  if (!window.Html5Qrcode) {
    $('cameraPanel').hidden = false;
    $('cameraStatus').textContent = 'Camera scanner could not load. Check your internet connection, then try again.';
    return;
  }
  $('cameraPanel').hidden = false;
  $('cameraStatus').textContent = 'Starting camera…';
  const supportedFormats = window.Html5QrcodeSupportedFormats || {};
  const formats = ['EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'CODE_128', 'CODE_39', 'ITF']
    .map((format) => supportedFormats[format])
    .filter((format) => format !== undefined);
  try {
    cameraScanner = new window.Html5Qrcode('cameraReader', formats.length ? { formatsToSupport: formats } : {});
    await cameraScanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 250, height: 110 } },
      (decodedText) => {
        if (decodedText === lastCameraCode) return;
        window.clearTimeout(cameraResetTimer);
        lastCameraCode = decodedText;
        $('cameraStatus').textContent = `Scanned ${decodedText} — point at the next item.`;
        scanBarcode(decodedText);
      },
      () => {
        window.clearTimeout(cameraResetTimer);
        cameraResetTimer = window.setTimeout(() => { lastCameraCode = ''; }, 900);
      },
    );
    $('cameraButton').textContent = 'Stop camera';
  } catch (error) {
    cameraScanner = null;
    $('cameraStatus').textContent = error?.message || 'Could not start the camera. Check browser permission and that no other app is using it.';
    $('cameraButton').textContent = 'Try camera again';
  }
}
function parseCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"' && text[i + 1] === '"' && quoted) { value += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === delimiter && !quoted) { row.push(value); value = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(value); if (row.some((cell) => cell.trim())) rows.push(row); row = []; value = '';
    } else value += char;
  }
  row.push(value); if (row.some((cell) => cell.trim())) rows.push(row);
  if (rows.length < 2) return [];
  const headers = rows.shift().map((header) => header.trim());
  return rows.map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ''])));
}
async function fileToRows(file) {
  const extension = file.name.split('.').pop().toLowerCase();
  if (extension === 'csv') return parseCsv(await file.text());
  if (!['xlsx', 'xls'].includes(extension)) return [];
  if (!window.XLSX) throw new Error('Excel reader did not load. Check your internet connection, or export the workbook as CSV.');
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: '' });
}
async function importFiles(fileList) {
  const files = Array.from(fileList).filter((file) => /\.(xlsx|xls|csv)$/i.test(file.name));
  if (!files.length) { setStatus('Choose an Excel (.xlsx/.xls) or CSV file.', true); return; }
  let imported = 0, skipped = 0;
  setStatus(`Reading ${files.length} file${files.length === 1 ? '' : 's'}…`);
  try {
    const catalog = productCatalog;
    for (const file of files) {
      const rows = await fileToRows(file);
      for (const row of rows) {
        const product = mapProduct(row);
        if (!product) { skipped += 1; continue; }
        const existingMatches = catalog.filter((entry) => productMatches(entry, product));
        const existing = existingMatches[0];
        const importedProduct = { ...existing, ...product, sourceFile: file.name, importedAt: new Date().toISOString() };
        if (existing) {
          Object.assign(existing, importedProduct);
          for (const duplicate of existingMatches.slice(1)) {
            catalog.splice(catalog.indexOf(duplicate), 1);
          }
        } else {
          importedProduct.id = nextProductId++;
          catalog.push(importedProduct);
        }
        imported += 1;
      }
    }
    await renderProducts();
    await refreshDraftProductPrices(true);
    setStatus(imported ? `Imported ${imported} product${imported === 1 ? '' : 's'} into this session. Choose Save JS catalog and select product-data.js to keep the changes after reload.${skipped ? ` · skipped ${skipped} blank/unrecognized row${skipped === 1 ? '' : 's'}` : ''}` : 'No products found. Check that the first row has a product/name or description column.', imported === 0);
    if (imported) showToast(`${imported} products imported — save the JS catalog to keep them`);
  } catch (error) {
    setStatus(error.message || 'Could not read the selected file.', true);
  }
  $('fileInput').value = '';
  $('folderInput').value = '';
}
async function refreshDraftProductPrices(forceCatalogPrice = false) {
  const products = await getProducts();
  let changed = false;
  items.forEach((item) => {
    const itemName = String(item.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const product = products.find((entry) => (item.barcode && String(entry.barcode || '') === String(item.barcode))
      || String(entry.name || '').toLowerCase().replace(/[^a-z0-9]/g, '') === itemName);
    if (!product) return;
    const isOldMrpPrice = number(product.mrp) > 0 && Math.abs(number(item.rate) - number(product.mrp)) < 0.005;
    if (!forceCatalogPrice && !isOldMrpPrice) return;
    item.rate = number(product.rate);
    item.gstRate = number(product.gstRate);
    item.discountPercent = number(product.discountPercent);
    item.barcode = product.barcode || item.barcode || '';
    changed = true;
  });
  if (changed) {
    drawItems();
    persistDraft();
  }
}
async function saveAndPrint() {
  saveProfile();
  const bill = currentInvoice();
  if (!bill.invoiceNumber) { showToast('Invoice number is required'); $('invoiceNumber').focus(); return; }
  if (!bill.businessName) { showToast('Add your business name first'); $('businessName').focus(); return; }
  if (!items.some((item) => item.name.trim())) { showToast('Add at least one item'); return; }
  if (bill.customerGstin && !/^[0-9A-Z]{15}$/i.test(bill.customerGstin)) { showToast('Customer GSTIN must contain 15 characters'); return; }
  if (bill.businessGstin && !/^[0-9A-Z]{15}$/i.test(bill.businessGstin)) { showToast('Business GSTIN must contain 15 characters'); return; }
  const sum = totals();
  const record = { ...bill, number: bill.invoiceNumber, id: bill.invoiceNumber, items: bill.items.filter((item) => item.name.trim()), subtotal: sum.subtotal, grossSubtotal: sum.grossSubtotal, cgst: sum.cgst, sgst: sum.sgst, igst: sum.igst, itemDiscount: sum.itemDiscount, discount: sum.discount, total: sum.total, savedAt: new Date().toISOString() };
  try {
    await put('invoices', record);
    await refreshBillCount();
  } catch (error) {
    showToast(`Bill could not be saved: ${error.message || 'storage unavailable'}`);
    return;
  }
  try {
    let printRoot = $('printRoot');
    if (!printRoot) {
      printRoot = document.createElement('div');
      printRoot.id = 'printRoot';
      document.body.append(printRoot);
    }
    printRoot.innerHTML = $('receiptPreview').innerHTML;
    document.body.classList.add('printing');
    window.addEventListener('afterprint', () => document.body.classList.remove('printing'), { once: true });
    window.print();
  } catch (error) {
    document.body.classList.remove('printing');
    showToast(`Bill saved, but the print dialog could not open: ${error.message || 'use Ctrl+P to print'}`);
  }
}
async function openInvoice(id) {
  const record = (await getAll('invoices')).find((invoice) => invoice.id === id);
  if (!record) return;
  fields.forEach((field) => { $(field).value = record[field] ?? (field === 'discountType' ? 'amount' : field === 'discountValue' ? '0' : ''); });
  items = record.items || [];
  drawItems();
  persistDraft();
  showView('billing');
}
function attachEvents() {
  document.querySelectorAll('.nav-link').forEach((link) => link.addEventListener('click', () => showView(link.dataset.view)));
  $('newBillButton').addEventListener('click', () => resetBill().then(() => showView('billing')));
  $('historyNewButton').addEventListener('click', () => resetBill().then(() => showView('billing')));
  $('addItemButton').addEventListener('click', () => addItem());
  $('addBlankItem').addEventListener('click', () => addItem());
  $('savePrintButton').addEventListener('click', saveAndPrint);
  $('importButton').addEventListener('click', () => $('fileInput').click());
  $('productImportButton').addEventListener('click', () => $('fileInput').click());
  $('productExportButton').addEventListener('click', saveProductCatalog);
  $('folderButton').addEventListener('click', () => $('folderInput').click());
  $('fileInput').addEventListener('change', (event) => importFiles(event.target.files));
  $('folderInput').addEventListener('change', (event) => importFiles(event.target.files));
  $('barcodeForm').addEventListener('submit', (event) => { event.preventDefault(); scanBarcode($('barcodeInput').value); });
  $('cameraButton').addEventListener('click', () => cameraScanner ? stopCameraScanner() : startCameraScanner());
  $('testBarcodeButton').addEventListener('click', toggleTestBarcode);
  $('productSearch').addEventListener('input', (event) => renderProductSearch(event.target.value));
  $('productSearch').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      const firstResult = $('productSearchResults').querySelector('[data-action="select-search-product"]');
      if (firstResult) { event.preventDefault(); firstResult.click(); }
    } else if (event.key === 'Escape') {
      $('productSearchResults').hidden = true;
      $('productSearch').setAttribute('aria-expanded', 'false');
    }
  });
  $('productSearchResults').addEventListener('click', (event) => {
    const button = event.target.closest('[data-action="select-search-product"]');
    if (button) selectSearchProduct(button.dataset.id);
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.product-search')) {
      $('productSearchResults').hidden = true;
      $('productSearch').setAttribute('aria-expanded', 'false');
    }
  });
  $('itemsBody').addEventListener('input', (event) => {
    const input = event.target.closest('[data-field]');
    if (!input) return;
    const row = input.closest('tr');
    const item = items[Number(row.dataset.index)];
    item[input.dataset.field] = ['quantity', 'rate', 'discountPercent', 'gstRate'].includes(input.dataset.field) ? number(input.value) : input.value;
    if (input.dataset.field === 'discountPercent') item.discountPercent = Math.min(100, Math.max(0, item.discountPercent));
    row.querySelector('.item-amount').textContent = money(lineAmounts(item).total);
    updatePreview();
    persistDraft();
  });
  $('itemsBody').addEventListener('change', (event) => {
    if (event.target.matches('select[data-field]')) $('itemsBody').dispatchEvent(new Event('input', { bubbles: true }));
  });
  $('itemsBody').addEventListener('click', (event) => {
    const remove = event.target.closest('.remove-item');
    if (!remove) return;
    const index = Number(remove.closest('tr').dataset.index);
    items.splice(index, 1);
    drawItems();
    persistDraft();
  });
  fields.forEach((id) => $(id).addEventListener('input', () => {
    if (['businessName', 'businessGstin', 'businessAddress'].includes(id)) saveProfile();
    updatePreview();
    persistDraft();
  }));
  $('taxType').addEventListener('change', () => { updatePreview(); persistDraft(); });
  $('discountType').addEventListener('change', () => { updatePreview(); persistDraft(); });
  $('historyList').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const invoice = (await getAll('invoices')).find((entry) => entry.id === button.dataset.id);
    if (button.dataset.action === 'load') openInvoice(button.dataset.id);
    else if (button.dataset.action === 'print' && invoice) {
      $('printRoot').innerHTML = formatGroceryReceipt(buildReceipt(invoice), invoice);
      document.body.classList.add('printing');
      window.addEventListener('afterprint', () => document.body.classList.remove('printing'), { once: true });
      window.print();
    } else if (button.dataset.action === 'delete' && invoice && window.confirm(`Delete bill ${invoice.number}? This cannot be undone.`)) {
      await storeRequest('invoices', 'readwrite', (store) => store.delete(invoice.id));
      await refreshBillCount(); renderHistory(); showToast('Bill deleted');
    }
  });
  $('productList').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action="use"]');
    if (!button) return;
    const product = (await getProducts()).find((entry) => entry.id === Number(button.dataset.id));
    if (product) { addItem({ ...product, quantity: 1 }); showView('billing'); }
  });
  $('helpButton').addEventListener('click', () => window.alert('Bills are stored in this browser using IndexedDB. Products are loaded from product-data.js only, not browser storage. After importing products, choose Save JS catalog and select this project file to keep the changes after reload. Redeploy to make updated products available to everyone. Business details and your current draft are stored in localStorage. Data does not upload to a server. Choose the MASTER UPLOAD folder using “Choose folder”; the browser will ask you to select it.'));
}
function buildReceipt(bill) {
  const grossSubtotal = bill.grossSubtotal !== undefined ? number(bill.grossSubtotal) : (bill.items || []).reduce((sum, item) => sum + number(item.quantity) * number(item.rate), 0);
  const itemDiscount = bill.itemDiscount !== undefined ? number(bill.itemDiscount) : (bill.items || []).reduce((sum, item) => sum + lineAmounts(item).discount, 0);
  const sum = { subtotal: number(bill.subtotal), grossSubtotal, itemDiscount, cgst: number(bill.cgst), sgst: number(bill.sgst), igst: number(bill.igst), discount: number(bill.discount), total: number(bill.total) };
  const rows = (bill.items || []).map((item) => `<tr><td class="receipt-desc">${escapeHtml(item.name || 'Item')}<br>${number(item.quantity)} × ${money(item.rate)}${number(item.discountPercent) ? ` · ${number(item.discountPercent)}% off` : ''} · GST ${number(item.gstRate)}%</td><td>${money(lineAmounts(item).total)}</td></tr>`).join('');
  const taxLines = sum.cgst + sum.sgst + sum.igst === 0 ? '' : bill.taxType === 'inter' ? `<div class="receipt-pair"><span>IGST</span><span>${money(sum.igst || sum.cgst + sum.sgst)}</span></div>` : `<div class="receipt-pair"><span>CGST</span><span>${money(sum.cgst)}</span></div><div class="receipt-pair"><span>SGST</span><span>${money(sum.sgst)}</span></div>`;
  return `<div class="receipt-center"><h3>${escapeHtml(bill.businessName || 'NAVEEN MART')}</h3><div class="receipt-sub">${escapeHtml(bill.businessAddress || '')}</div>${bill.businessGstin ? `<div class="receipt-sub">GSTIN: ${escapeHtml(bill.businessGstin)}</div>` : ''}</div><div class="receipt-rule"></div><div class="receipt-center"><b>${bill.businessGstin ? 'TAX INVOICE' : 'GROCERY BILL'}</b></div><div class="receipt-pair"><span>No: ${escapeHtml(bill.invoiceNumber || bill.number || '')}</span><span>${escapeHtml(formatDate(bill.invoiceDate))}</span></div>${bill.placeOfSupply ? `<div class="receipt-pair"><span>Place of supply</span><span>${escapeHtml(bill.placeOfSupply)}</span></div>` : ''}<div class="receipt-rule"></div><div><b>Customer:</b> ${escapeHtml(bill.customerName || 'Walk-in customer')}</div>${bill.customerGstin ? `<div class="receipt-sub">GSTIN: ${escapeHtml(bill.customerGstin)}</div>` : ''}${bill.customerAddress ? `<div class="receipt-sub">${escapeHtml(bill.customerAddress)}</div>` : ''}<div class="receipt-rule"></div><table class="receipt-items"><thead><tr><th>Item / Qty</th><th>Amount</th></tr></thead><tbody>${rows}</tbody></table><div class="receipt-rule"></div><div class="receipt-pair"><span>Subtotal (incl. GST)</span><span>${money(sum.grossSubtotal)}</span></div>${sum.itemDiscount > 0 ? `<div class="receipt-pair"><span>Product discounts</span><span>−${money(sum.itemDiscount)}</span></div>` : ''}<div class="receipt-pair"><span>Taxable value</span><span>${money(sum.subtotal)}</span></div>${taxLines}<div class="receipt-rule"></div><div class="receipt-pair receipt-total"><span>TOTAL</span><span>${money(sum.total)}</span></div><div class="receipt-pair"><span>Payment</span><span>${escapeHtml(bill.paymentMethod || 'Cash')}</span></div>${bill.invoiceNotes ? `<div class="receipt-center receipt-sub">${escapeHtml(bill.invoiceNotes)}</div>` : ''}<div class="receipt-center receipt-thanks">Thank you!</div>`;
}
async function init() {
  attachEvents();
  try { db = await openDatabase(); }
  catch { showToast('Browser database unavailable; try a recent browser with storage enabled'); }
  profileLoad();
  const hasDraft = draftLoad();
  if (hasDraft) await refreshDraftProductPrices();
  if (!hasDraft) await resetBill();
  if (!items.length) items = [{ name: '', barcode: '', hsn: '', quantity: 1, rate: 0, gstRate: 0 }];
  drawItems();
  await refreshBillCount();
}
document.addEventListener('DOMContentLoaded', init);
