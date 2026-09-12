import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, registerUser } from './helpers.js';

let base: string;
before(async () => { base = await startServer(); });
after(async () => { await stopServer(); });

// Create an expense transaction with an itemized receipt.
async function addReceipt(client: any, acct: number, date: string, items: any[]) {
  const txn = await client.post('/api/transactions', { amount: 10, account_id: acct, direction: 'expense', txn_date: date });
  assert.equal(txn.status, 201, JSON.stringify(txn.body));
  const r = await client.put(`/api/transactions/${txn.body.id}/receipt`, { merchant: 'Walmart', purchased_at: date, items });
  assert.equal(r.status, 200);
}

test('item reporting aggregates spend by category, top products, and price history', async () => {
  const { client } = await registerUser(base);
  const acct = (await client.post('/api/accounts', { name: 'Checking', type: 'checking' })).body.id;

  await addReceipt(client, acct, '2026-05-10', [
    { name: 'Great Value Greek Yogurt', brand: 'Great Value', category: 'Dairy & Eggs', size: 32, unit: 'oz', quantity: 1, total_price: 4.00 },
    { name: 'Bananas', category: 'Produce', quantity: 1, total_price: 2.00 },
  ]);
  await addReceipt(client, acct, '2026-06-10', [
    { name: 'Great Value Greek Yogurt', brand: 'Great Value', category: 'Dairy & Eggs', size: 32, unit: 'oz', quantity: 1, total_price: 5.00 },
  ]);

  // Overview: totals + category breakdown.
  const ov = (await client.get('/api/receipt-items/overview?months=24')).body;
  assert.equal(ov.total_spend, 11);
  assert.equal(ov.product_count, 2, 'two distinct products');
  const dairy = ov.by_category.find((c: any) => c.category === 'Dairy & Eggs');
  assert.equal(dairy.spend, 9, 'yogurt spend rolls up under Dairy & Eggs');
  assert.equal(ov.by_month.length, 2, 'two purchase months');

  // Products: yogurt is the top product; first/last unit price captured for the trend.
  // The endpoint is paginated → { products, total }.
  const productsResp = (await client.get('/api/receipt-items/products')).body;
  assert.equal(productsResp.total, 2, 'two distinct products in the full set');
  const products = productsResp.products;
  assert.equal(products[0].name, 'Great Value Greek Yogurt');
  assert.equal(products[0].purchases, 2);
  assert.equal(products[0].total_spend, 9);
  assert.equal(products[0].brand, 'Great Value');
  assert.equal(Math.round(products[0].first_uom_price * 10000), 1250, '$4.00 / 32oz = $0.1250/oz');
  assert.equal(Math.round(products[0].last_uom_price * 10000), 1563, '$5.00 / 32oz ≈ $0.1563/oz');

  // Category filter narrows the list.
  const produce = (await client.get('/api/receipt-items/products?category=Produce')).body.products;
  assert.equal(produce.length, 1);
  assert.equal(produce[0].name, 'Bananas');

  // Per-product history is ordered by date with per-unit prices.
  const hist = (await client.get(`/api/receipt-items/product?name=${encodeURIComponent('Great Value Greek Yogurt')}`)).body;
  assert.equal(hist.length, 2);
  assert.equal(hist[0].date, '2026-05-10');
  assert.equal(hist[1].date, '2026-06-10');
  assert.ok(hist[1].uom_price > hist[0].uom_price, 'unit price went up over time');
});

test('item reporting is empty for a book with no receipts', async () => {
  const { client } = await registerUser(base);
  const ov = (await client.get('/api/receipt-items/overview')).body;
  assert.equal(ov.total_spend, 0);
  assert.equal(ov.item_count, 0);
  const emptyProducts = (await client.get('/api/receipt-items/products')).body;
  assert.deepEqual(emptyProducts.products, []);
  assert.equal(emptyProducts.total, 0);
});
